import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parse } from 'yaml';
import { applyPlan, createNotionClient, hash, planImport, readSnapshots } from '../import.mjs';

const hex = (char, length = 32) => char.repeat(length);
const dataSourceId = `${hex('a', 8)}-${hex('a', 4)}-4aaa-8aaa-${hex('a', 12)}`;
const databaseId = `${hex('b', 8)}-${hex('b', 4)}-4bbb-8bbb-${hex('b', 12)}`;
const config = { dataSourceId, databaseId };
const pageId = hex('c');
const date = '2026-10-24', retrievedAt = '2026-10-24T06:00:00.000Z';
const path = `meetings/2026/10/${date}-notion-${pageId}.md`;
const statePath = 'integrations/notion/state.json';
const snapshot = (body = '## 논의\n\n새 회의의 검토할 제안입니다.') => ({
  page: { object: 'page', id: pageId, parent: { type: 'data_source_id', data_source_id: config.dataSourceId, database_id: config.databaseId },
    last_edited_time: '2026-10-24T05:00:00.000Z', properties: {
      이름: { type: 'title', title: [{ plain_text: '회의: 자동 반영 검증' }] },
      날짜: { type: 'date', date: { start: date } }, 상태: { type: 'status', status: { name: '작성 완료' } },
    } },
  markdown: { object: 'page_markdown', id: pageId, markdown: body, truncated: false, unknown_block_ids: [] },
});
const makePlan = (options = {}) => planImport({ config, state: {}, snapshots: [snapshot()], files: { [path]: null }, retrievedAt, ...options });
const list = (pages, extra = {}) => ({ object: 'list', results: pages, has_more: false, next_cursor: null, ...extra });
const editedSnapshot = body => {
  const result = snapshot(body);
  result.page.last_edited_time = '2026-10-24T07:00:00.000Z';
  return result;
};

test('새 회의록은 전체 페이지 ID 경로와 출처를 갖고 작성 완료여도 needs-review로 생성된다', () => {
  const plan = makePlan();
  assert.equal(plan.writes[0].path, path);
  const text = plan.writes[0].content;
  const metadata = parse(text.split('---\n')[1]);
  assert.equal(metadata.title, '회의: 자동 반영 검증');
  assert.equal(metadata.status, 'needs-review');
  assert.equal(metadata.notion_page, `https://www.notion.so/${pageId}`);
  assert.equal(metadata.notion_retrieved_at, retrievedAt);
  assert.equal(metadata.notion_last_edited_time, snapshot().page.last_edited_time);
  assert.match(text, /^date: 2026-10-24$/m);
  assert.match(text, /^status: needs-review$/m);
  assert.match(text, /새 회의의 검토할 제안/);
  assert.equal(plan.state[pageId].fileHash, hash(text));
  assert.equal(plan.counts.imported, 1);
});

test('변화가 없으면 조회 날짜나 불필요한 수정 시각이 달라도 파일과 manifest를 쓰지 않는다', () => {
  const first = makePlan(), next = snapshot();
  next.page.last_edited_time = '2026-10-25T05:00:00.000Z';
  const plan = makePlan({ state: first.state, files: { [path]: first.writes[0].content }, snapshots: [next], retrievedAt: '2026-10-26T05:00:00.000Z' });
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.stateChanged, false);
});

test('자동 관리 회의록의 본문이 바뀌면 소스와 파일 해시를 함께 갱신한다', () => {
  const first = makePlan();
  const plan = makePlan({ state: first.state, files: { [path]: first.writes[0].content }, snapshots: [editedSnapshot('수정된 논의입니다.')] });
  assert.equal(plan.counts.updated, 1);
  assert.match(plan.writes[0].content, /수정된 논의/);
  assert.notEqual(plan.state[pageId].sourceHash, first.state[pageId].sourceHash);
  assert.equal(plan.state[pageId].fileHash, hash(plan.writes[0].content));
});

test('Git에서 편집하거나 지운 자동 관리 파일은 원격 변경으로 덮어쓰지 않는다', () => {
  const first = makePlan();
  for (const current of ['Git에서 검토 후 편집한 내용', null]) {
    assert.throws(() => makePlan({ state: first.state, files: { [path]: current }, snapshots: [snapshot('Notion 변경')] }), /Git 회의록이 변경되거나 삭제/);
  }
});

test('수동 관리 기존 회의록은 기준만 등록하고 원격 변경 시 실패하여 보존한다', () => {
  const existingPath = 'meetings/2026/10/2026-10-23-기존회의.md';
  const options = { config: { ...config, existingPages: { [pageId]: existingPath } }, files: { [existingPath]: '검토한 기존 회의록' } };
  const baseline = makePlan(options);
  assert.deepEqual(baseline.writes, []);
  assert.equal(baseline.state[pageId].managed, false);
  assert.equal(baseline.counts.baselined, 1);
  assert.throws(() => makePlan({ ...options, state: baseline.state, snapshots: [editedSnapshot('변경된 원문')] }), /수동 관리 회의록/);
  assert.equal(baseline.state[pageId].fileHash, hash('검토한 기존 회의록'));
});

test('원격에서 사라진 페이지는 manifest와 회의록을 보존하고 경고한다', () => {
  const first = makePlan();
  const plan = makePlan({ state: first.state, snapshots: [], files: { [path]: first.writes[0].content } });
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.stateChanged, false);
  assert.match(plan.warnings[0], /사라진 페이지/);
});

test('빈 본문과 제목 또는 날짜가 없는 작성 중 페이지를 건너뛰고 잘못된 날짜는 실패한다', () => {
  const empty = makePlan({ snapshots: [snapshot(' \n ')] });
  assert.deepEqual(empty.writes, []);
  assert.equal(empty.stateChanged, false);
  assert.match(empty.warnings[0], /빈 본문/);
  for (const property of ['이름', '날짜']) {
    const invalid = snapshot();
    delete invalid.page.properties[property];
    const skipped = makePlan({ snapshots: [invalid] });
    assert.deepEqual(skipped.writes, []);
    assert.equal(skipped.stateChanged, false);
    assert.match(skipped.warnings[0], /작성 중 페이지/);
  }
  const invalidDate = snapshot();
  invalidDate.page.properties.날짜.date.start = '2026-02-30';
  assert.throws(() => makePlan({ snapshots: [invalidDate] }), /제목과 유효한 날짜/);
});

test('Notion 수정 시각이 같으면 첨부 URL 만료 갱신으로 파일을 다시 쓰지 않는다', () => {
  const first = makePlan({ snapshots: [snapshot('![첨부](https://files.example/a?expires=old)')] });
  const options = { state: first.state, files: { [path]: first.writes[0].content }, snapshots: [snapshot('![첨부](https://files.example/a?expires=new)')] };
  const plan = makePlan(options);
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.stateChanged, false);
  assert.throws(() => makePlan({ ...options, files: { [path]: 'Git 수정' } }), /Git 회의록이 변경/);
});

test('날짜가 없는 초안의 본문은 조회하지 않고 기존 회의록은 보존한다', async () => {
  const first = makePlan(), draft = snapshot();
  delete draft.page.properties.날짜;
  let calls = 0;
  const snapshots = await readSnapshots(config, async () => { calls++; return list([draft.page]); });
  assert.equal(calls, 1);
  const plan = makePlan({ state: first.state, snapshots, files: { [path]: first.writes[0].content } });
  assert.equal(plan.stateChanged, false);
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.warnings.length, 1);
});

test('truncated, unknown IDs, 지원하지 않는 블록 태그는 전체 계획을 중단한다', () => {
  for (const patch of [{ truncated: true }, { unknown_block_ids: [pageId] }, { markdown: '<unknown url="private"/>' }, { markdown: '<unsupported>content</unsupported>' }]) {
    const invalid = snapshot();
    Object.assign(invalid.markdown, patch);
    assert.throws(() => makePlan({ snapshots: [invalid] }), /불완전한 Notion 본문/);
  }
});

test('다른 데이터 소스와 경로 경계를 거부하고 기존 경로 충돌도 보존한다', () => {
  const outside = snapshot();
  outside.page.parent.data_source_id = hex('d');
  assert.throws(() => makePlan({ snapshots: [outside] }), /데이터 소스 밖/);
  assert.throws(() => makePlan({ config: { ...config, existingPages: { [pageId]: '../개인.md' } } }), /범위 밖/);
  assert.throws(() => makePlan({ files: { [path]: '기존 파일' } }), /기존 파일을 덮어쓰지/);
});

test('페이지네이션 전체를 읽고 전사를 제외하며 본문 안의 개인 링크는 조회하지 않는다', async () => {
  const first = snapshot(`[개인 페이지](https://www.notion.so/${hex('e')})`);
  const second = snapshot('두 번째 회의록');
  second.page.id = second.markdown.id = hex('f');
  const calls = [], responses = [list([first.page], { has_more: true, next_cursor: 'next' }), list([second.page]), first.markdown, first.page, second.markdown, second.page];
  const result = await readSnapshots(config, async (url, body) => { calls.push({ url, body }); return responses.shift(); });
  assert.equal(result.length, 2);
  assert.equal(calls[1].body.start_cursor, 'next');
  assert.equal(calls[2].url, `/pages/${pageId}/markdown?include_transcript=false`);
  assert.equal(calls.length, 6);
  assert.equal(calls.some(call => call.url.includes(hex('e'))), false);
});

test('상한 때문에 incomplete인 목록이나 반복 cursor는 본문 조회 전에 중단한다', async () => {
  let calls = 0;
  await assert.rejects(readSnapshots(config, async () => { calls++; return list([], { request_status: { type: 'incomplete' } }); }), /목록 조회가 불완전/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(readSnapshots(config, async () => { calls++; return list([], { has_more: true, next_cursor: 'same' }); }), /페이지네이션/);
  assert.equal(calls, 2);
});

test('회의록 안전 한도를 넘으면 부분 결과를 사용하지 않는다', async () => {
  const many = Array.from({ length: 1001 }, (_, index) => ({ ...snapshot().page, id: index.toString(16).padStart(32, '0') }));
  await assert.rejects(readSnapshots(config, async () => list(many)), /안전 한도/);
});

test('조회 중 변경된 페이지나 다른 부모로 옮긴 페이지를 저장하지 않는다', async () => {
  const original = snapshot(), changed = structuredClone(original.page);
  changed.last_edited_time = '2026-10-24T06:00:00.000Z';
  let responses = [list([original.page]), original.markdown, changed];
  await assert.rejects(readSnapshots(config, async () => responses.shift()), /읽는 동안 회의록이 변경/);
  changed.last_edited_time = original.page.last_edited_time;
  changed.parent.type = 'page_id';
  responses = [list([original.page]), original.markdown, changed];
  await assert.rejects(readSnapshots(config, async () => responses.shift()), /데이터 소스 밖/);
});

test('429는 Retry-After를 지키고 최대 네 번까지만 요청한다', async () => {
  const waits = [], calls = [];
  const request = createNotionClient({ token: 'test-secret', sleep: async ms => waits.push(ms), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length < 3 ? new Response('', { status: 429, headers: { 'Retry-After': '2' } }) : Response.json({ ok: true });
  } });
  assert.deepEqual(await request('/pages/test'), { ok: true });
  assert.deepEqual(waits, [2000, 2000]);
  assert.equal(calls[0].options.headers['Notion-Version'], '2026-03-11');
  let attempts = 0;
  const failed = createNotionClient({ token: 'test-secret', sleep: async () => {}, fetchImpl: async () => { attempts++; return new Response('', { status: 429 }); } });
  await assert.rejects(failed('/pages/test'), /HTTP 429/);
  assert.equal(attempts, 4);
});

test('dry-run은 읽기만 하며 apply는 회의록과 manifest를 함께 저장한다', async t => {
  const root = await mkdtemp(join(tmpdir(), 'notion-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = makePlan();
  await applyPlan(root, plan, null, { dryRun: true });
  await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' });
  await applyPlan(root, plan, null);
  assert.equal(await readFile(join(root, path), 'utf8'), plan.writes[0].content);
  assert.deepEqual(JSON.parse(await readFile(join(root, statePath), 'utf8')), plan.state);
});

test('검토 후 manifest가 변경되면 첫 회의록을 포함해 아무 파일도 쓰지 않는다', async t => {
  const root = await mkdtemp(join(tmpdir(), 'notion-import-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(dirname(join(root, statePath)), { recursive: true });
  await writeFile(join(root, statePath), '{"다른작업":true}\n');
  await assert.rejects(applyPlan(root, makePlan(), null), /계획 이후 파일이 변경/);
  await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' });
});

test('회의록 폴더의 심볼릭 링크를 따라 다른 저장소에 쓰지 않는다', async t => {
  const root = await mkdtemp(join(tmpdir(), 'notion-import-link-'));
  const other = await mkdtemp(join(tmpdir(), 'notion-import-outside-'));
  t.after(() => Promise.all([root, other].map(dir => rm(dir, { recursive: true, force: true }))));
  await symlink(other, join(root, 'meetings'));
  await assert.rejects(applyPlan(root, makePlan(), null), /심볼릭 링크/);
});

const scheduleConfig = { ...config, categoryProperty: '카테고리', categoryValue: '팀일정', requireMeetingNotes: true };
const scheduleSnapshot = (body, categories = ['팀일정']) => {
  const result = snapshot(body);
  result.page.properties.카테고리 = { type: 'multi_select', multi_select: categories.map(name => ({ name })) };
  return result;
};

test('일정에서 요약이 있는 회의록만 가져오고 주변 메모와 전사는 제외한다', () => {
  for (const prefix of ['meeting-notes-section-', '']) {
    const source = scheduleSnapshot(`주변 일정 메모\n<meeting-notes view-url="test">\n회의 제목\n<${prefix}summary>논의한 내용</${prefix}summary>\n<${prefix}notes>작성한 회의 메모</${prefix}notes>\n<${prefix}transcript>전사 비공유 내용</${prefix}transcript>\n</meeting-notes>`);
    const plan = makePlan({ config: scheduleConfig, snapshots: [source] });
    assert.equal(plan.counts.imported, 1);
    assert.match(plan.writes[0].content, /논의한 내용/);
    assert.match(plan.writes[0].content, /작성한 회의 메모/);
    assert.doesNotMatch(plan.writes[0].content, /주변 일정 메모|전사 비공유 내용/);
  }
});

test('팀일정의 일반 메모와 처리 중인 빈 회의록 요약은 가져오지 않는다', () => {
  for (const body of ['팀 회의실 예약 메모', '<meeting-notes><summary><p /></summary><notes>녹음 중</notes></meeting-notes>']) {
    const plan = makePlan({ config: scheduleConfig, snapshots: [scheduleSnapshot(body)] });
    assert.deepEqual(plan.writes, []);
    assert.equal(plan.stateChanged, false);
  }
});

test('개인 일정과 팀일정 카테고리가 없는 일정은 본문도 읽지 않는다', async () => {
  for (const categories of [['개인 일정'], ['팀일정', '개인 일정'], []]) {
    let calls = 0;
    const snapshots = await readSnapshots(scheduleConfig, async () => {
      calls++;
      return list([scheduleSnapshot('읽으면 안 되는 본문', categories).page]);
    });
    assert.equal(calls, 1);
    assert.deepEqual(makePlan({ config: scheduleConfig, snapshots }).writes, []);
  }
});

test('일정 조회에는 팀일정 포함과 개인 일정 제외 필터를 함께 적용한다', async () => {
  await readSnapshots(scheduleConfig, async (url, body) => {
    assert.deepEqual(body.filter, { and: [
      { property: '카테고리', multi_select: { contains: '팀일정' } },
      { property: '카테고리', multi_select: { does_not_contain: '개인 일정' } },
    ] });
    return list([]);
  });
});

test('수집 소스 변경으로 목록에서 빠진 기존 수동 기록은 경고 없이 보존한다', () => {
  const first = makePlan();
  const plan = makePlan({ config: { ...scheduleConfig, existingPages: { [pageId]: path } }, state: first.state, snapshots: [], files: { [path]: first.writes[0].content } });
  assert.deepEqual(plan.writes, []);
  assert.deepEqual(plan.warnings, []);
  assert.deepEqual(plan.state, first.state);
});
