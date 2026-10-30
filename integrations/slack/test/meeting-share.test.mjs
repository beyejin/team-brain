import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { MeetingShareJob, selectMeeting, formatMeeting, shareMeetings } from '../src/meeting-share.mjs';

const hex = (char, length = 32) => char.repeat(length);
const pageId = hex('c');
const dataSourceId = `${hex('a', 8)}-${hex('a', 4)}-4aaa-8aaa-${hex('a', 12)}`;
const env = {
  SLACK_MEETING_CHANNEL_ID: 'CMEET', SLACK_MEETING_START_DATE: '2026-04-01',
  SLACK_BOT_TOKEN: 'test-only-token', NOTION_DATA_SOURCE_ID: dataSourceId,
};
const document = {
  title: '데모 범위 초안', date: '2026-04-09', status: 'needs-review',
  notion_page: `https://app.notion.com/p/demo-${pageId}?source=copy_link`,
  notion_data_source: dataSourceId,
  content: `---\nnotion_retrieved_at: 2026-04-09T00:00:00Z\n---
### 액션 아이템
- [ ] 각자 관심 장면을 조사해오기 [^https://example.invalid/ref]
- [ ] 내일 장면을 5\\~6개 안으로 줄이기
- [ ] 4월 30일까지 장면 확정
### 회의 개요
- 데모 장면 후보를 공유하고 검토했습니다.
- 장면을 <b>줄이는 것</b>이 목표였으나 충분히 줄이지 못했습니다.
- 다음 회의에 더 구체적인 조사를 가져오기로 했습니다.
### 전사 원문
- RAW_TRANSCRIPT_DO_NOT_SHARE
`,
};

class Storage {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
}
function setup(t, response = () => Response.json({ ok: true, ts: '1792825200.000001' })) {
  const storage = new Storage(), calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return response();
  });
  const job = new MeetingShareJob({ storage }, env);
  const publish = (record = document) => job.fetch(new Request('https://meeting-share/publish', {
    method: 'POST', body: JSON.stringify(record),
  }));
  return { storage, calls, job, publish };
}

test('공지 채널 미설정, 과거 기록, 다른 DB 또는 비정상 원본 URL은 공유하지 않습니다', async () => {
  assert.equal(selectMeeting(document, { ...env, SLACK_MEETING_CHANNEL_ID: undefined }), null);
  for (const override of [
    { date: '2026-03-01' }, { notion_data_source: 'other-data-source' },
    { notion_page: `https://attacker.example/${pageId}` },
    { notion_page: 'https://app.notion.com/p/no-page-id' },
  ]) assert.equal(selectMeeting({ ...document, ...override }, env), null);
  const selected = selectMeeting(document, env);
  assert.equal(selected.pageId, pageId);
  assert.equal(selected.url, `https://www.notion.so/${pageId}`);
  await shareMeetings([document], { SLACK_BOT_TOKEN: 'test-only-token' });
  const response = await worker.fetch(new Request('https://worker.example/publish', { method: 'POST' }), env);
  assert.equal(response.status, 404, '공유용 공개 HTTP 진입점이 없어야 합니다');
});

test('개요 마지막 2개와 첫 액션 2개만 발췌하며 원본 링크·검토 고지를 붙이고 전사·각주·뒤 일정은 제외합니다', () => {
  const result = formatMeeting(selectMeeting(document, env));
  assert.equal(result.text.split('\n').filter(line => line.startsWith('• ')).length, 4);
  assert.ok(result.text.indexOf('줄이는 것') < result.text.indexOf('관심 장면'));
  assert.match(result.text, /5~6개/);
  assert.match(result.text, /needs-review/);
  assert.match(result.text, /현재 합의로 확정할 수 없습니다/);
  assert.ok(result.text.includes(`https://www.notion.so/${pageId}`));
  for (const unwanted of ['데모 장면 후보', '4월 30일', 'RAW_TRANSCRIPT', '[^', '<b>', 'notion_retrieved_at']) {
    assert.equal(result.text.includes(unwanted), false, unwanted);
  }
  const long = formatMeeting({ ...selectMeeting(document, env), title: '가'.repeat(300),
    content: '### 회의 개요\n' + Array.from({ length: 10 }, (_, index) => `- ${index} ${'나'.repeat(1000)}`).join('\n') });
  assert.ok(long.text.length <= 1500);
  assert.equal(long.blocks[0].text.type, 'plain_text');
});

test('Notion REST v1 summary 안의 탭 들여쓰기 제목을 인식하여 뒤쪽 일정이 공지에 섞이지 않습니다', () => {
  const content = `<summary>
\t\t### 액션 아이템
\t\t- [ ] 북극성 데모 화면 초안을 내일 회의에 가져오기
\t\t- [ ] 내일 회의 목표: 데모 장면을 최소 5\\~6개 안으로 줄이기
\t\t- [ ] 4월 30일까지 발표 장면 1개 확정
\t\t- [ ] 4월 20일까지 검색 시나리오 확인
\t\t- [ ] 4월 23일까지 슬라이드 자료 취합
\t\t---
\t\t### 회의 개요
\t\t- 북극성 팀이 발표 데모의 장면 후보를 공유하고 리뷰하는 자리
\t\t- 오늘 목표는 장면을 줄이는 것이었으나 생각보다 많이 줄이지 못함
\t\t- 각자 조사 깊이가 달라, 다음 회의엔 더 구체적으로 정리해 온 내용을 가져오기로 함
\t</summary>
<notes>
\t\t<empty-block/>
\t</notes>`;
  const result = formatMeeting(selectMeeting({ ...document, content }, env));
  assert.deepEqual(result.text.split('\n').filter(line => line.startsWith('• ')), [
    '• 오늘 목표는 장면을 줄이는 것이었으나 생각보다 많이 줄이지 못함',
    '• 각자 조사 깊이가 달라, 다음 회의엔 더 구체적으로 정리해 온 내용을 가져오기로 함',
    '• 북극성 데모 화면 초안을 내일 회의에 가져오기',
    '• 내일 회의 목표: 데모 장면을 최소 5~6개 안으로 줄이기',
  ]);
  for (const unwanted of ['4월 30일', '장면 후보', '<summary>', '\t']) {
    assert.equal(result.text.includes(unwanted), false, unwanted);
  }
});

test('동일 페이지 동시 호출과 반복 cron은 한 번만 게시하고 내용 변경은 같은 ts를 갱신합니다', async t => {
  const state = setup(t);
  await Promise.all([state.publish(), state.publish()]);
  await state.publish();
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(state.calls[0].body.thread_ts, undefined);
  assert.equal(state.calls[0].body.channel, env.SLACK_MEETING_CHANNEL_ID);
  assert.equal(state.calls[0].body.mrkdwn, false);
  await state.publish({ ...document, content: document.content.replace('00:00:00', '00:10:00') });
  assert.equal(state.calls.length, 1, '수집 시각만 바뀌면 공지를 수정하지 않습니다');
  await state.publish({ ...document, content: document.content.replace('5\\~6개', '4개') });
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[1].url, 'https://slack.com/api/chat.update');
  assert.equal(state.calls[1].body.ts, '1792825200.000001');
  assert.match(state.calls[1].body.text, /4개/);
});

test('최초 전송 결과가 불명확하면 새 공지를 자동 재게시하지 않습니다', async t => {
  const state = setup(t, () => { throw new Error('response lost'); });
  assert.equal((await state.publish()).status, 503);
  assert.equal((await state.publish()).status, 409);
  assert.equal(state.calls.length, 1);
  assert.equal((await state.storage.get('publication')).state, 'sending');
});

test('Slack 성공 후 완료 상태 저장이 실패해도 새 공지를 자동 재게시하지 않습니다', async t => {
  const state = setup(t);
  const put = state.storage.put.bind(state.storage);
  t.mock.method(state.storage, 'put', async (key, value) => {
    if (value.state === 'published') throw new Error('storage unavailable');
    await put(key, value);
  });
  await assert.rejects(state.publish(), /storage unavailable/);
  assert.equal((await state.publish()).status, 409);
  assert.equal(state.calls.length, 1);
});

test('명시적 Slack 거절은 재시도하고 기존 공지 업데이트 실패도 같은 ts로 재시도합니다', async t => {
  let accepted = false;
  const state = setup(t, () => Response.json(accepted ? { ok: true, ts: '1792825200.000001' } : { ok: false, error: 'ratelimited' }));
  assert.equal((await state.publish()).status, 503);
  assert.equal(await state.storage.get('publication'), undefined);
  accepted = true;
  await state.publish();
  accepted = false;
  const updated = { ...document, content: `${document.content}\n### 회의 개요\n- 새 논의` };
  assert.equal((await state.publish(updated)).status, 503);
  accepted = true;
  await state.publish(updated);
  assert.deepEqual(state.calls.map(call => call.url.split('/').at(-1)), ['chat.postMessage', 'chat.postMessage', 'chat.update', 'chat.update']);
  assert.equal(state.calls[2].body.ts, state.calls[3].body.ts);
});

test('본문 없는 HTTP 429는 최초 전송 예약을 해제하고 다음 주기에 게시와 갱신을 재시도합니다', async t => {
  let limited = true;
  const state = setup(t, () => limited
    ? new Response(null, { status: 429, headers: { 'retry-after': '1' } })
    : Response.json({ ok: true, ts: '1792825200.000001' }));
  assert.equal((await state.publish()).status, 503);
  assert.equal(await state.storage.get('publication'), undefined);
  limited = false;
  assert.equal((await state.publish()).status, 200);
  const previous = await state.storage.get('publication');
  const updated = { ...document, content: `${document.content}\n### 회의 개요\n- 새 논의` };
  limited = true;
  assert.equal((await state.publish(updated)).status, 503);
  assert.deepEqual(await state.storage.get('publication'), previous);
  limited = false;
  assert.equal((await state.publish(updated)).status, 200);
  assert.deepEqual(state.calls.map(call => call.url.split('/').at(-1)), ['chat.postMessage', 'chat.postMessage', 'chat.update', 'chat.update']);
  assert.equal(state.calls[2].body.ts, state.calls[3].body.ts);
});

test('채널 설정을 바꿔도 기존 회의록을 다른 채널에 다시 게시하지 않습니다', async t => {
  const state = setup(t);
  await state.publish();
  const changed = new MeetingShareJob({ storage: state.storage }, { ...env, SLACK_MEETING_CHANNEL_ID: 'COTHER' });
  const result = await changed.fetch(new Request('https://meeting-share/publish', { method: 'POST', body: JSON.stringify(document) }));
  assert.equal(result.status, 409);
  assert.equal(state.calls.length, 1);
});

test('cron은 회의 페이지 ID별로 작업을 선택하고 대상 밖 문서는 건너뜁니다', async () => {
  const ids = [], records = [];
  await shareMeetings([document, { ...document, date: '2026-03-01' }, { ...document, notion_data_source: 'other' }], {
    ...env, MEETING_SHARES: {
      idFromName(id) { ids.push(id); return id; },
      get() { return { async fetch(_url, options) { records.push(JSON.parse(options.body)); return new Response('Published'); } }; },
    },
  });
  assert.deepEqual(ids, [pageId]);
  assert.deepEqual(records, [document]);
});

test('cron은 비정상 응답과 예외 뒤에도 나머지 회의를 처리하고 실패 합계가 있으면 거부합니다', async t => {
  const ids = [pageId, hex('d'), hex('e')];
  const processed = [];
  t.mock.method(console, 'error', () => {});
  await assert.rejects(shareMeetings(ids.map(id => ({ ...document, notion_page: `https://www.notion.so/${id}` })), {
    ...env, MEETING_SHARES: {
      idFromName: id => id,
      get(id) { return { async fetch() {
        processed.push(id);
        if (id === ids[0]) return new Response('Slack failed', { status: 503 });
        if (id === ids[1]) throw new Error('DO unavailable');
        return new Response('Published');
      } }; },
    },
  }), /meeting_share_failed: 2/);
  assert.deepEqual(processed, ids);
});
