import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, lstat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const STATE_PATH = 'integrations/notion/state.json';
const MAX_PAGES = 1000;
export const hash = text => createHash('sha256').update(text).digest('hex');
const id = value => {
  if (typeof value !== 'string' || !/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(value)) {
    throw new Error('유효하지 않은 Notion ID입니다.');
  }
  return value.replaceAll('-', '').toLowerCase();
};
const meetingPath = path => {
  if (!/^meetings\/\d{4}\/\d{2}\/[^/\\]+\.md$/.test(path)) throw new Error(`회의록 범위 밖 경로: ${path}`);
  return path;
};

function pageInfo(page, config) {
  const pageId = id(page.id);
  if (page.object !== 'page' || page.parent?.type !== 'data_source_id' ||
      id(page.parent.data_source_id) !== id(config.dataSourceId) ||
      (page.parent.database_id && id(page.parent.database_id) !== id(config.databaseId))) {
    throw new Error(`지정한 회의록 데이터 소스 밖의 페이지입니다: ${pageId}`);
  }
  if (page.archived || page.in_trash) throw new Error(`조회 중 삭제되거나 보관된 페이지입니다: ${pageId}`);
  if (!page.last_edited_time || !Number.isFinite(Date.parse(page.last_edited_time))) {
    throw new Error(`수정 시각이 없는 페이지입니다: ${pageId}`);
  }
  if (config.categoryProperty) {
    const categories = page.properties?.[config.categoryProperty]?.multi_select?.map(option => option.name) ?? [];
    if (!categories.includes(config.categoryValue) || categories.includes('개인 일정')) {
      return { id: pageId, skip: '수집 대상이 아닌 일정' };
    }
  }
  const titles = Object.values(page.properties ?? {}).filter(property => property.type === 'title');
  const title = titles.length === 1 && titles[0].title?.map(part => part.plain_text ?? part.text?.content ?? '').join('').trim();
  const rawDate = page.properties?.[config.dateProperty ?? '날짜']?.date?.start;
  if (!title || !rawDate) return { id: pageId, skip: '회의 제목 또는 날짜가 없는 작성 중 페이지' };
  const date = rawDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error(`회의 제목과 유효한 날짜 속성이 필요합니다: ${pageId}`);
  }
  return { id: pageId, title, date, lastEdited: page.last_edited_time };
}

function sourceInfo(snapshot, config) {
  const info = pageInfo(snapshot.page, config);
  if (info.skip) return info;
  const result = snapshot.markdown;
  if (result.object !== 'page_markdown' || id(result.id) !== info.id ||
      result.truncated !== false || !Array.isArray(result.unknown_block_ids) || result.unknown_block_ids.length ||
      typeof result.markdown !== 'string' || /<\s*(?:unknown|unsupported|truncated)(?:\s|\/?>)/i.test(result.markdown)) {
    throw new Error(`불완전한 Notion 본문입니다. 기존 파일을 보존합니다: ${info.id}`);
  }
  if (config.requireMeetingNotes) {
    const notes = [...result.markdown.matchAll(/<meeting-notes(?:\s[^>]*)?>[\s\S]*?<\/meeting-notes>/g)];
    const sections = [];
    for (const [note] of notes) {
      // 두 Markdown 형식의 회의록 태그만 읽고, 주변 일정 메모와 전사는 가져오지 않습니다.
      const summary = note.match(/<(meeting-notes-section-summary|summary)>[\s\S]*?<\/\1>/)?.[0];
      const userNotes = note.match(/<(meeting-notes-section-notes|notes)>[\s\S]*?<\/\1>/)?.[0];
      if (summary?.replace(/<[^>]*>/g, '').trim()) {
        sections.push([summary, userNotes].filter(Boolean).join('\n\n'));
      }
    }
    if (!sections.length) return { ...info, skip: '요약이 준비된 회의록 블록이 없는 일정' };
    return { ...info, markdown: sections.join('\n\n') };
  }
  return { ...info, markdown: result.markdown.trim() };
}

function renderMeeting(source, config, retrievedAt) {
  const importedOn = new Date(Date.parse(retrievedAt) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const metadata = stringify({
    type: 'meeting', date: source.date, title: source.title, participants: [], status: 'needs-review',
    notion_page: `https://www.notion.so/${source.id}`,
    notion_page_role: config.requireMeetingNotes ? '일정 페이지 회의록 자동 가져오기' : '읽기용 회의록 자동 가져오기', notion_imported_on: importedOn,
    notion_retrieved_at: retrievedAt, notion_last_edited_time: source.lastEdited,
    notion_data_source: config.dataSourceId,
  }, { lineWidth: 0 });
  return `---\n${metadata}---\n\n# ${source.title.replace(/[\r\n]+/g, ' ')}\n\n` +
    '> Notion 회의록을 그대로 가져온 자료입니다. 작성 완료 여부와 관계없이 참석자가 확인하기 전까지 needs-review 상태입니다.\n\n' +
    `${source.markdown}\n`;
}

// 모든 원격 본문과 로컬 파일을 검증한 다음 변경 계획만 반환합니다.
export function planImport({ config, state = {}, snapshots, files, retrievedAt }) {
  id(config.dataSourceId);
  id(config.databaseId);
  if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error('조회 시각이 유효하지 않습니다.');
  const existing = Object.fromEntries(Object.entries(config.existingPages ?? {}).map(([key, path]) => [id(key), meetingPath(path)]));
  const nextState = structuredClone(state);
  const writes = [], warnings = [], seen = new Set();
  const counts = { imported: 0, updated: 0, baselined: 0 };
  for (const [key, entry] of Object.entries(state)) {
    if (id(key) !== key || typeof entry.managed !== 'boolean' || !/^[a-f\d]{64}$/.test(entry.sourceHash) ||
        !/^[a-f\d]{64}$/.test(entry.fileHash)) throw new Error(`잘못된 동기화 상태입니다: ${key}`);
    meetingPath(entry.path);
  }
  for (const snapshot of snapshots) {
    const source = sourceInfo(snapshot, config);
    if (seen.has(source.id)) throw new Error(`중복된 Notion 페이지입니다: ${source.id}`);
    seen.add(source.id);
    if (source.skip) {
      warnings.push(`${source.skip}를 건너뜁니다. 기존 기록은 보존합니다: ${source.id}`);
      continue;
    }
    if (!source.markdown) {
      warnings.push(`빈 본문을 건너뜁니다. 기존 기록은 보존합니다: ${source.id}`);
      continue;
    }
    const sourceHash = hash(JSON.stringify([source.title, source.date, source.markdown]));
    const previous = state[source.id];
    const generatedPath = `meetings/${source.date.slice(0, 4)}/${source.date.slice(5, 7)}/${source.date}-notion-${source.id}.md`;
    const path = previous?.path ?? existing[source.id] ?? generatedPath;
    if (!(path in files)) throw new Error(`로컬 파일 검증 자료가 없습니다: ${path}`);
    const current = files[path];
    if (previous) {
      if (current === null || (previous.managed && hash(current) !== previous.fileHash)) {
        throw new Error(`Git 회의록이 변경되거나 삭제되었습니다. 덮어쓰지 않습니다: ${path}`);
      }
      // 첨부 파일의 임시 URL은 재조회만으로 바뀔 수 있습니다.
      if (source.lastEdited === previous.notionLastEdited || sourceHash === previous.sourceHash) continue;
      if (!previous.managed) throw new Error(`수동 관리 회의록의 Notion 원문이 변경되었습니다. 대조가 필요합니다: ${path}`);
      if (path !== generatedPath) throw new Error(`회의 날짜가 변경되었습니다. 파일 이동 검토가 필요합니다: ${path}`);
    } else if (existing[source.id]) {
      if (current === null) throw new Error(`기존 회의록을 찾지 못했습니다: ${path}`);
      nextState[source.id] = { path, notionLastEdited: source.lastEdited, sourceHash, fileHash: hash(current), managed: false };
      counts.baselined++;
      continue;
    } else if (current !== null) {
      throw new Error(`같은 경로의 기존 파일을 덮어쓰지 않습니다: ${path}`);
    }
    const content = renderMeeting(source, config, retrievedAt);
    writes.push({ path, before: current, content });
    nextState[source.id] = { path, notionLastEdited: source.lastEdited, sourceHash, fileHash: hash(content), managed: true };
    counts[previous ? 'updated' : 'imported']++;
  }
  for (const [pageId, entry] of Object.entries(state)) {
    if (!seen.has(pageId) && !existing[pageId]) warnings.push(`Notion 목록에서 사라진 페이지입니다. Git 기록을 보존합니다: ${entry.path}`);
  }
  return { writes, state: nextState, stateChanged: JSON.stringify(state) !== JSON.stringify(nextState), warnings, counts };
}

export function createNotionClient({ token, apiVersion = '2026-03-11', fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!token) throw new Error('NOTION_TOKEN이 필요합니다.');
  return async (path, body) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetchImpl(`https://api.notion.com/v1${path}`, {
        method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token}`, 'Notion-Version': apiVersion, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 429 && attempt < 3) {
        const seconds = Number(response.headers.get('retry-after') ?? 1);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error('Notion 재시도 대기 범위를 초과했습니다.');
        await sleep(Math.ceil(seconds * 1000));
        continue;
      }
      if (!response.ok) throw new Error(`Notion 요청 실패 (HTTP ${response.status}): ${path}`);
      return response.json();
    }
  };
}

export async function readSnapshots(config, request) {
  id(config.dataSourceId);
  id(config.databaseId);
  const pages = [], cursors = new Set(), pageIds = new Set();
  let cursor;
  do {
    const filter = config.categoryProperty ? { and: [
      { property: config.categoryProperty, multi_select: { contains: config.categoryValue } },
      { property: config.categoryProperty, multi_select: { does_not_contain: '개인 일정' } },
    ] } : undefined;
    const result = await request(`/data_sources/${config.dataSourceId}/query`, { page_size: 100, ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}) });
    if (result.request_status?.type === 'incomplete' || !Array.isArray(result.results) || typeof result.has_more !== 'boolean') {
      throw new Error('Notion 목록 조회가 불완전합니다. 파일을 변경하지 않습니다.');
    }
    for (const page of result.results) {
      const info = pageInfo(page, config);
      if (pageIds.has(info.id)) throw new Error(`조회 결과에 중복 페이지가 있습니다: ${info.id}`);
      pageIds.add(info.id);
      pages.push(page);
    }
    if (pages.length > MAX_PAGES || (pages.length === MAX_PAGES && result.has_more)) throw new Error(`회의록 안전 한도 ${MAX_PAGES}개를 넘었습니다.`);
    if (!result.has_more) break;
    cursor = result.next_cursor;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor) || cursors.size >= 100) {
      throw new Error('Notion 페이지네이션이 유효하지 않습니다.');
    }
    cursors.add(cursor);
  } while (true);
  const snapshots = [];
  for (const page of pages) {
    if (pageInfo(page, config).skip) {
      snapshots.push({ page });
      continue;
    }
    const markdown = await request(`/pages/${page.id}/markdown?include_transcript=false`);
    sourceInfo({ page, markdown }, config);
    const after = await request(`/pages/${page.id}`);
    pageInfo(after, config);
    if (id(after.id) !== id(page.id) || after.last_edited_time !== page.last_edited_time) {
      throw new Error(`읽는 동안 회의록이 변경되었습니다. 다음 실행에서 다시 시도합니다: ${id(page.id)}`);
    }
    snapshots.push({ page, markdown });
  }
  return snapshots;
}

async function readLocal(root, path) {
  const parts = path.split('/');
  for (let index = 1; index <= parts.length; index++) {
    try {
      if ((await lstat(resolve(root, ...parts.slice(0, index)))).isSymbolicLink()) throw new Error(`심볼릭 링크는 가져오기 대상이 아닙니다: ${path}`);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  return readFile(resolve(root, path), 'utf8');
}

export async function applyPlan(root, plan, previousStateText, { dryRun = false } = {}) {
  const writes = [...plan.writes];
  if (plan.stateChanged) writes.push({ path: STATE_PATH, before: previousStateText, content: JSON.stringify(plan.state, null, 2) + '\n' });
  // 원격 조회 이후의 로컬 변경도 모든 파일에 대해 먼저 검사합니다.
  for (const write of writes) {
    if (write.path !== STATE_PATH) meetingPath(write.path);
    if (await readLocal(root, write.path) !== write.before) throw new Error(`계획 이후 파일이 변경되었습니다: ${write.path}`);
  }
  if (dryRun) return;
  const staged = [];
  try {
    for (const write of writes) {
      const destination = resolve(root, write.path), temporary = `${destination}.${randomUUID()}.tmp`;
      await mkdir(dirname(destination), { recursive: true });
      staged.push({ destination, temporary });
      await writeFile(temporary, write.content, { flag: 'wx', mode: 0o644 });
    }
    for (const file of staged) await rename(file.temporary, file.destination);
  } finally {
    await Promise.all(staged.map(file => rm(file.temporary, { force: true })));
  }
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--dry-run')) throw new Error('사용법: node integrations/notion/import.mjs [--dry-run]');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const config = JSON.parse(await readLocal(root, 'integrations/notion/config.json'));
  const stateText = await readLocal(root, STATE_PATH), state = JSON.parse(stateText ?? '{}');
  const snapshots = await readSnapshots(config, createNotionClient({ token: process.env.NOTION_TOKEN, apiVersion: config.apiVersion }));
  const paths = new Set([...Object.values(state).map(entry => entry.path), ...Object.values(config.existingPages ?? {})]);
  for (const snapshot of snapshots) {
    const source = pageInfo(snapshot.page, config);
    if (source.skip) continue;
    paths.add(`meetings/${source.date.slice(0, 4)}/${source.date.slice(5, 7)}/${source.date}-notion-${source.id}.md`);
  }
  const files = {};
  for (const path of paths) files[meetingPath(path)] = await readLocal(root, path);
  const plan = planImport({ config, state, snapshots, files, retrievedAt: new Date().toISOString() });
  await applyPlan(root, plan, stateText, { dryRun: process.argv.includes('--dry-run') });
  for (const warning of plan.warnings) console.error(`경고: ${warning}`);
  console.log(`${process.argv.includes('--dry-run') ? '검토만: ' : ''}신규 ${plan.counts.imported}, 갱신 ${plan.counts.updated}, 기존 기준 등록 ${plan.counts.baselined}, 경고 ${plan.warnings.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
