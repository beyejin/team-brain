import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const repository = 'beyejin/team-brain';
const commit = git('rev-parse', 'HEAD').trim();
if (git('status', '--porcelain', '--', 'AGENTS.md', 'meetings').trim()) {
  throw new Error('회의록 또는 AGENTS.md에 미커밋 변경이 있습니다. 기록을 검토하고 커밋한 뒤 배포하세요.');
}
const documents = git('ls-tree', '-rz', '--full-tree', 'HEAD', 'meetings/').split('\0')
  .filter(Boolean).map(entry => {
    const [metadata, path] = entry.split('\t');
    if (!metadata.startsWith('100644 blob ') || !/^meetings\/\d{4}\/\d{2}\/[^/]+\.md$/.test(path)) return null;
    const content = git('show', `HEAD:${path}`);
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatter) throw new Error(`문서 메타데이터가 없습니다: ${path}`);
    const value = name => frontmatter[1].match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1].trim();
    const date = value('date');
    const status = value('status');
    const title = value('title');
    const scalar = name => value(name)?.replace(/^(["'])(.*)\1$/, '$2');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !title ||
      !['confirmed', 'proposed', 'needs-review', 'deferred', 'rejected', 'superseded'].includes(status)) {
      throw new Error(`날짜, 제목 또는 검토 상태를 확인하세요: ${path}`);
    }
    return { path, date, title, status, content,
      notion_page: scalar('notion_page'), notion_data_source: scalar('notion_data_source'),
      url: `https://github.com/${repository}/blob/main/${path.split('/').map(encodeURIComponent).join('/')}` };
  }).filter(Boolean).sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path))
  .map((doc, index) => ({ id: `meeting-${index + 1}`, ...doc }));
if (!documents.length) throw new Error('배포할 회의록이 없습니다.');
const brain = { repository, commit, generatedAt: new Date().toISOString(),
  rules: git('show', 'HEAD:AGENTS.md'), documents };
if (JSON.stringify(brain).length > 100000) {
  throw new Error('전체 회의록이 100,000자를 넘었습니다. 일부 기록을 조용히 누락하지 않도록 검색 방식 검토 후 배포하세요.');
}
const target = new URL('../src/brain.json', import.meta.url);
mkdirSync(new URL('../src/', import.meta.url), { recursive: true });
writeFileSync(target, JSON.stringify(brain, null, 2) + '\n', { mode: 0o600 });
console.log(`팀 회의록 ${documents.length}개 반영, 기준 커밋 ${commit.slice(0, 7)}`);
