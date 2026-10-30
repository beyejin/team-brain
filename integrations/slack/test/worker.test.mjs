import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import worker, { EventJob, verifySignature, selectEvent, formatReply, answerQuestion } from '../src/worker.mjs';

const brain = JSON.parse(await readFile(new URL('../src/brain.json', import.meta.url), 'utf8'));
const cited = brain.documents.find((document) => document.status === 'needs-review');
if (!cited) throw new Error('needs-review sample note is missing');
const secret = 'test-only-signing-secret';
const env = {
  SLACK_SIGNING_SECRET: secret,
  SLACK_BOT_TOKEN: 'test-only-bot-token',
  SLACK_TEAM_ID: 'team-sample',
  SLACK_CHANNEL_ID: 'channel-sample',
};
const payload = (event = {}, outer = {}) => ({
  type: 'event_callback', team_id: env.SLACK_TEAM_ID, event_id: 'Ev123',
  event: {
    type: 'app_mention', channel: env.SLACK_CHANNEL_ID, user: 'U123',
    text: '<@UBOT> 팀명이 확정됐나요?', ts: '1792742685.834849', ...event,
  },
  ...outer,
});
const sign = (body, timestamp) => `v0=${createHmac('sha256', secret)
  .update(`v0:${timestamp}:${body}`).digest('hex')}`;
const request = (body, options = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  return new Request('https://worker.example/slack/events', {
    method: 'POST', body: raw,
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': options.signature ?? sign(raw, timestamp),
    },
  });
};
const docs = [
  { id: 'one', path: 'meetings/2026/10/2026-10-23-운영.md', date: '2026-10-23',
    title: '팀 운영', status: 'needs-review', content: '팀명은 미정입니다.' },
  { id: 'two', path: 'meetings/2026/10/2026-10-24-결정.md', date: '2026-10-24',
    title: '후속 회의', status: 'confirmed', content: '확인된 결정입니다.' },
];

const completion = result => ({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  choices: [{ index: 0, finish_reason: 'stop', message: {
    role: 'assistant', content: JSON.stringify(result), refusal: null,
    reasoning: '이 내부 추론은 답변에 노출되면 안 됩니다.',
    reasoning_content: '이 내부 추론은 답변에 노출되면 안 됩니다.',
  } }],
});

class Storage {
  values = new Map();
  alarm = null;
  transactions = Promise.resolve();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) {
    if (typeof key === 'object') {
      for (const [name, item] of Object.entries(key)) this.values.set(name, structuredClone(item));
    } else this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    if (Array.isArray(key)) return key.filter(name => this.values.delete(name)).length;
    return this.values.delete(key);
  }
  async deleteAll() { this.values.clear(); }
  async setAlarm(at) { this.alarm = Number(at); }
  async getAlarm() { return this.alarm; }
  async deleteAlarm() { this.alarm = null; }
  async transaction(callback) {
    const result = this.transactions.then(() => callback(this));
    this.transactions = result.catch(() => {});
    return result;
  }
}

function jobEnvironment(t, slackResult = { ok: true, ts: '1792742686.000001' }) {
  const storage = new Storage();
  const sent = [];
  let inferenceCount = 0;
  const jobEnv = {
    ...env,
    AI: { async run() {
      inferenceCount++;
      return completion({
        answer: '팀명 최종 확정은 확인되지 않았습니다.',
        source_ids: [cited.id],
      });
    } },
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://slack.com/api/chat.postMessage');
    const body = JSON.parse(options.body);
    sent.push(body);
    return Response.json(slackResult);
  });
  const job = new EventJob({ storage, blockConcurrencyWhile: fn => fn() }, jobEnv);
  return { storage, sent, job, jobEnv, inferenceCount: () => inferenceCount };
}
const enqueue = (job, event) => job.fetch(new Request('https://event-job/enqueue', {
  method: 'POST', body: JSON.stringify(event),
}));

test('실제 Workers AI 응답 형태에서 최종 답변만 읽고 내부 추론은 노출하지 않습니다', async () => {
  const answer = '팀명 최종 확정은 확인되지 않았습니다.';
  const result = completion({ answer, source_ids: [cited.id] });
  const falseAnswer = JSON.stringify({ answer: '추론 영역의 가짜 답변', source_ids: ['nonexistent-source'] });
  result.choices[0].message.reasoning = falseAnswer;
  result.choices[0].message.reasoning_content = falseAnswer;
  const reply = await answerQuestion({ text: '팀명이 확정됐나요?' }, {
    AI: { run: async () => result },
  });
  assert.ok(JSON.stringify(reply.blocks).includes(answer));
  assert.ok(JSON.stringify(reply.blocks).includes('needs-review'));
  assert.ok(JSON.stringify(reply.blocks).includes(`https://github.com/${brain.repository}/blob/main/`));
  assert.equal(JSON.stringify(reply).includes('추론 영역의 가짜 답변'), false);
});

test('잘린 응답과 거절, 도구 호출, 비정상 최종 답변은 채택하지 않습니다', async () => {
  const valid = () => completion({ answer: '확인된 답변', source_ids: [cited.id] });
  const invalid = [
    ['토큰 한도에서 잘린 응답', result => { result.choices[0].finish_reason = 'length'; }],
    ['후보 없는 응답', result => { result.choices = []; }],
    ['후보가 여러 개인 응답', result => { result.choices.push(structuredClone(result.choices[0])); }],
    ['assistant가 아닌 응답', result => { result.choices[0].message.role = 'user'; }],
    ['최종 텍스트 없는 응답', result => { result.choices[0].message.content = null; }],
    ['거절 응답', result => { result.choices[0].message.refusal = '거절'; }],
    ['도구 호출 응답', result => { result.choices[0].message.tool_calls = [{ id: 'tool-1' }]; }],
    ['함수 호출 응답', result => { result.choices[0].message.function_call = { name: 'unexpected' }; }],
    ['잘린 JSON 응답', result => { result.choices[0].message.content = '{"answer":'; }],
  ];
  for (const [description, mutate] of invalid) {
    const result = valid();
    mutate(result);
    if (result.choices[0]) {
      result.choices[0].message.reasoning_content = JSON.stringify({
        answer: '추론 영역에서 복구하면 안 됩니다.', source_ids: [cited.id],
      });
    }
    await assert.rejects(answerQuestion({ text: '팀명이 확정됐나요?' }, {
      AI: { run: async () => result },
    }), description);
  }
});

test('서명은 원문 body와 시각을 검증하고 변조 및 재생을 거부합니다', async () => {
  const now = 1_800_000_000_000;
  const timestamp = String(now / 1000);
  const body = JSON.stringify(payload());
  assert.equal(await verifySignature(body, timestamp, sign(body, timestamp), secret, now), true);
  assert.equal(await verifySignature(`${body} `, timestamp, sign(body, timestamp), secret, now), false);
  for (const offset of [-301, 301]) {
    const stale = String(now / 1000 + offset);
    assert.equal(await verifySignature(body, stale, sign(body, stale), secret, now), false);
  }
  for (const signature of ['', 'v0=bad', `v0=${'0'.repeat(64)}`]) {
    assert.equal(await verifySignature(body, timestamp, signature, secret, now), false);
  }
  assert.equal(await verifySignature(body, 'NaN', sign(body, 'NaN'), secret, now), false);
});

test('지정 채널의 app_mention만 처리하며 멘션을 제거하고 원래 스레드를 유지합니다', () => {
  const event = selectEvent(payload({ thread_ts: '1792742600.000001' }), env);
  assert.equal(event.eventId, 'Ev123');
  assert.equal(event.teamId, env.SLACK_TEAM_ID);
  assert.equal(event.channelId, env.SLACK_CHANNEL_ID);
  assert.equal(event.text, '팀명이 확정됐나요?');
  assert.equal(event.threadTs, '1792742600.000001');
  assert.equal(selectEvent(payload(), env).threadTs, payload().event.ts);
});

test('다른 워크스페이스나 채널, 일반 메시지, 봇과 수정 이벤트는 처리하지 않습니다', () => {
  const rejected = [
    payload({}, { team_id: 'TOTHER' }), payload({ channel: 'COTHER' }),
    payload({ type: 'message' }), payload({ subtype: 'message_changed' }),
    payload({ subtype: 'bot_message' }), payload({ bot_id: 'B123' }),
    payload({ bot_profile: { id: 'B123' } }), payload({ hidden: true }),
    payload({ user: '' }), payload({ text: '<@UBOT>   ' }),
    payload({}, { event_id: '' }),
  ];
  for (const candidate of rejected) assert.equal(selectEvent(candidate, env), null);
});

test('challenge에도 서명이 필요하고 검증에 실패하면 enqueue하지 않습니다', async () => {
  let queued = false;
  const testEnv = { ...env, EVENT_JOBS: { idFromName() { queued = true; throw new Error('unexpected enqueue'); } } };
  const challenge = { type: 'url_verification', challenge: 'test-challenge' };
  const accepted = await worker.fetch(request(challenge), testEnv, {});
  assert.equal(accepted.status, 200);
  assert.match(await accepted.text(), /test-challenge/);
  const rejected = await worker.fetch(request(challenge, { signature: 'v0=bad' }), testEnv, {});
  assert.equal(rejected.status, 401);
  assert.equal(queued, false);
});

test('허용되지 않은 채널은 서명이 정상이더라도 작업을 만들지 않습니다', async () => {
  let queued = false;
  const testEnv = { ...env, EVENT_JOBS: { idFromName() { queued = true; throw new Error('unexpected enqueue'); } } };
  const response = await worker.fetch(request(payload({ channel: 'COTHER' })), testEnv, {});
  assert.equal(response.status, 200);
  assert.equal(queued, false);
});

test('작업을 저장하지 못하면 성공 ACK 대신 재전달 가능한 오류를 반환합니다', async () => {
  const testEnv = { ...env, EVENT_JOBS: {
    idFromName: id => id,
    get: () => ({ fetch: async () => { throw new Error('storage unavailable'); } }),
  } };
  assert.equal((await worker.fetch(request(payload()), testEnv, {})).status, 503);
});

test('같은 이벤트가 재전송되어도 저장된 작업과 답장은 하나입니다', async t => {
  const state = jobEnvironment(t);
  const ids = [];
  const testEnv = {
    ...state.jobEnv,
    EVENT_JOBS: {
      idFromName(id) { ids.push(id); return id; },
      get() { return { fetch: (url, options) => state.job.fetch(new Request(url, options)) }; },
    },
  };
  const responses = await Promise.all([0, 1].map(() => worker.fetch(request(payload()), testEnv, {})));
  for (const response of responses) assert.equal(response.status, 200);
  assert.deepEqual(ids, ['Ev123', 'Ev123']);
  assert.equal(state.inferenceCount(), 0, 'ACK 전에 AI 추론을 실행하면 안 됩니다');
  assert.ok(state.storage.alarm, 'ACK 전에 후속 작업이 예약되어야 합니다');
  await state.job.alarm();
  await enqueue(state.job, selectEvent(payload(), env));
  await state.job.alarm();
  assert.equal(state.inferenceCount(), 1);
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].channel, env.SLACK_CHANNEL_ID);
  assert.equal(state.sent[0].thread_ts, payload().event.ts);
  assert.equal(state.sent[0].mrkdwn, false);
  assert.equal(state.sent[0].parse, 'none');
  assert.equal((await state.storage.get('done')).outcome, 'sent');
});

test('내부 enqueue에서도 다른 워크스페이스와 채널을 거부합니다', async t => {
  const state = jobEnvironment(t);
  const event = selectEvent(payload(), env);
  for (const overrides of [{ teamId: 'TOTHER' }, { channelId: 'COTHER' }]) {
    const response = await enqueue(state.job, { ...event, ...overrides });
    assert.ok(response.status >= 400 && response.status < 500);
    assert.equal(await state.storage.get('event'), undefined);
  }
  assert.equal(state.sent.length, 0);
  assert.equal(state.inferenceCount(), 0);
});

test('Slack 전송 뒤 정리 저장이 실패해도 이미 보낸 답장을 재전송하지 않습니다', async t => {
  const state = jobEnvironment(t);
  await enqueue(state.job, selectEvent(payload(), env));
  const transaction = state.storage.transaction.bind(state.storage);
  let failOnce = true;
  t.mock.method(state.storage, 'transaction', async callback => {
    if (failOnce) { failOnce = false; throw new Error('temporary storage failure'); }
    return transaction(callback);
  });
  await assert.rejects(state.job.alarm(), /temporary storage failure/);
  assert.equal(await state.storage.get('sent'), true);
  await state.job.alarm();
  assert.equal(state.sent.length, 1);
  assert.equal(state.inferenceCount(), 1);
  assert.equal((await state.storage.get('done')).outcome, 'sent');
});

test('출처 없는 모델 답변은 채택하지 않고 알 수 없는 출처는 거부합니다', () => {
  const invented = '확정됐습니다. 담당자는 가짜이고 기한은 내일입니다.';
  const reply = formatReply({ answer: invented, source_ids: [] }, docs);
  assert.equal(JSON.stringify(reply).includes(invented), false);
  assert.match(reply.text, /근거|기록|확인/);
  assert.throws(() => formatReply({ answer: invented, source_ids: ['missing'] }, docs));
  assert.throws(() => formatReply({ answer: invented, source_ids: ['one', 'missing'] }, docs));
});

test('검토 상태와 출처를 붙이며 사용자 멘션이 Slack 서식으로 실행되지 않게 합니다', () => {
  const answer = '<!channel> <@U123> 팀명은 확인이 필요합니다.';
  const reply = formatReply({ answer, source_ids: ['one'] }, docs);
  assert.match(JSON.stringify(reply), /needs-review/);
  assert.match(JSON.stringify(reply), /2026-10-23/);
  assert.match(JSON.stringify(reply), /팀원 검토 전/);
  assert.match(JSON.stringify(reply), /현재 팀 합의로 확정할 수 없습니다/);
  assert.equal(reply.text.includes('<!channel>'), false);
  assert.equal(reply.text.includes('<@U123>'), false);
  const textObjects = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.text === 'string' && typeof value.type === 'string') textObjects.push(value);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(walk); else walk(child);
    }
  };
  walk(reply.blocks);
  const answerBlocks = textObjects.filter(value => value.text.includes('팀명은 확인이 필요합니다.'));
  assert.ok(answerBlocks.length > 0);
  assert.ok(answerBlocks.every(value => value.type === 'plain_text'));
  const fakeURL = 'https://attacker.example/leak';
  assert.equal(JSON.stringify(formatReply({ answer: '미정입니다.', source_ids: ['one'] },
    [{ ...docs[0], url: fakeURL }])).includes(fakeURL), false);
});

test('모델이 없는 출처를 인용하면 Slack에 답장을 보내지 않습니다', async t => {
  const state = jobEnvironment(t);
  state.jobEnv.AI.run = async () => completion({
    answer: '이것은 근거가 없는 답변입니다.', source_ids: ['nonexistent-source'],
  });
  await enqueue(state.job, selectEvent(payload(), env));
  await state.job.alarm();
  assert.equal(state.sent.length, 0);
  assert.equal(await state.storage.get('done'), undefined);
  assert.ok(state.storage.alarm > Date.now());
});

test('Slack HTTP 200의 ok:false는 완료로 기록하지 않고 재시도합니다', async t => {
  const state = jobEnvironment(t, { ok: false, error: 'ratelimited' });
  await enqueue(state.job, selectEvent(payload(), env));
  await state.job.alarm();
  assert.equal(await state.storage.get('done'), undefined);
  assert.ok(state.storage.alarm > Date.now());
  assert.equal(state.sent.length, 1);
  await state.job.alarm();
  await state.job.alarm();
  assert.notEqual((await state.storage.get('done'))?.outcome, 'sent');
  assert.equal(state.sent.length, 4);
  assert.equal(state.sent[3].text, '회의록 답변을 만들지 못했습니다. 잠시 뒤 다시 질문해 주세요.');
  assert.equal(state.sent[3].channel, env.SLACK_CHANNEL_ID);
  assert.equal(state.sent[3].thread_ts, payload().event.ts);
  await state.job.alarm();
  assert.equal(state.sent.length, 4, '실패 안내를 이미 시도한 작업은 다시 보내면 안 됩니다');
});
