import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const pageId = 'c'.repeat(32);
const dataSourceId = `${'a'.repeat(8)}-${'a'.repeat(4)}-4aaa-8aaa-${'a'.repeat(12)}`;

test('새 회의록 커밋을 빌드하면 문서와 기준 커밋이 갱신되고 링크는 main을 유지하며 원문과 개인 파일은 제외됩니다', t => {
  const root = mkdtempSync(join(tmpdir(), 'team-brain-build-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = subject => {
    git('-c', 'user.name=Build Test', '-c', 'user.email=build-test@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', subject);
    return git('rev-parse', 'HEAD');
  };
  const buildScript = 'integrations/slack/scripts/build-brain.mjs';
  const build = () => {
    execFileSync(process.execPath, [buildScript], { cwd: root, encoding: 'utf8' });
    return JSON.parse(readFileSync(join(root, 'integrations/slack/src/brain.json'), 'utf8'));
  };
  const meeting = (date, title, status, body) =>
    `---\ndate: ${date}\ntitle: ${title}\nstatus: ${status}\n---\n\n${body}\n`;
  const firstPath = 'meetings/2026/10/2026-10-23-첫-회의.md';
  const nextPath = 'meetings/2026/10/2026-10-24-후속-회의.md';
  const rules = '# 팀 규칙\nconfirmed 결정만 확정으로 답합니다.\n';
  const firstContent = meeting('2026-10-23', '첫 회의', 'needs-review', '테스트 팀명은 검토 중입니다.');
  const nextContent = meeting('2026-10-24', '후속 회의', 'confirmed', '테스트 다음 회의는 금요일입니다.')
    .replace('status: confirmed', `status: confirmed\nnotion_page: "https://www.notion.so/${pageId}"\nnotion_data_source: ${dataSourceId}`);

  git('init', '--quiet');
  write('AGENTS.md', rules);
  write(firstPath, firstContent);
  write('sources/meetings/2026-10-23/raw.md', 'EXCLUDED_RAW_TRANSCRIPT_MARKER');
  write('personal-profile.md', 'EXCLUDED_PERSONAL_PROFILE_MARKER');
  mkdirSync(dirname(join(root, buildScript)), { recursive: true });
  copyFileSync(new URL('../scripts/build-brain.mjs', import.meta.url), join(root, buildScript));
  git('add', '.');
  const firstCommit = commit('test: 첫 회의록 추가');
  const initial = build();

  assert.equal(initial.commit, firstCommit);
  assert.equal(initial.rules, rules);
  assert.deepEqual(initial.documents.map(doc => doc.path), [firstPath]);
  assert.equal(initial.documents[0].content, firstContent);
  assert.equal(initial.documents[0].url, `https://github.com/beyejin/team-brain/blob/main/${firstPath.split('/').map(encodeURIComponent).join('/')}`);

  write(nextPath, nextContent);
  git('add', nextPath);
  const nextCommit = commit('test: 후속 회의록 추가');
  const updated = build();

  assert.notEqual(nextCommit, firstCommit);
  assert.equal(updated.commit, nextCommit);
  assert.deepEqual(updated.documents.map(doc => doc.path), [nextPath, firstPath]);
  assert.deepEqual(updated.documents.map(doc => doc.content), [nextContent, firstContent]);
  assert.equal(updated.documents[0].notion_page, `https://www.notion.so/${pageId}`);
  assert.equal(updated.documents[0].notion_data_source, dataSourceId);
  assert.equal(updated.documents[1].notion_page, undefined);
  assert.equal(updated.documents[1].url, initial.documents[0].url);
  for (const doc of updated.documents) {
    const encodedPath = doc.path.split('/').map(encodeURIComponent).join('/');
    assert.equal(doc.url, `https://github.com/beyejin/team-brain/blob/main/${encodedPath}`);
  }
  for (const output of [initial, updated]) {
    assert.equal(JSON.stringify(output).includes('EXCLUDED_RAW_TRANSCRIPT_MARKER'), false);
    assert.equal(JSON.stringify(output).includes('EXCLUDED_PERSONAL_PROFILE_MARKER'), false);
  }
});
