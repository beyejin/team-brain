import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const all = process.argv.includes('--all');
const paths = (all
  ? git('ls-tree', '-r', '--name-only', '-z', 'HEAD')
  : git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'))
  .split('\0').filter(path => /\.md$/i.test(path));
if (!paths.length) process.exit(0);

let parseDocument;
try {
  ({ parseDocument } = await import('yaml'));
} catch {
  console.error('YAML 검사에 필요한 패키지가 없습니다. 저장소 루트에서 npm ci를 실행하세요.');
  process.exit(1);
}

let failed = false;
for (const path of paths) {
  const lines = git('show', `${all ? 'HEAD' : ''}:${path}`).replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0])) continue;
  const end = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
  const errors = end < 0
    ? [new Error('YAML을 닫는 ---가 없습니다.')]
    : parseDocument(lines.slice(1, end).join('\n')).errors;
  for (const error of errors) {
    console.error(`${path}: ${error.message}`);
    failed = true;
  }
}

if (failed) {
  console.error(all
    ? '커밋된 문서의 YAML 오류를 수정해 새 커밋에 반영하세요.'
    : 'YAML 오류를 수정하고 git add로 다시 스테이징한 뒤 커밋하세요.');
  process.exit(1);
}
