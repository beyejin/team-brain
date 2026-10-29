import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const valid = '---\ntitle: "회의: 운영"\n---\n\n# 회의\n';
const invalid = '---\ntitle: 회의: 운영\n---\n';

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'team-brain-yaml-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const git = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout;
  };
  git('init', '--quiet');
  git('config', 'user.name', 'YAML hook test');
  git('config', 'user.email', 'yaml-hook@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.hooksPath', '.githooks');
  for (const path of ['scripts/check-frontmatter.mjs', '.githooks/pre-commit']) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    copyFileSync(join(root, path), join(cwd, path));
  }
  chmodSync(join(cwd, '.githooks/pre-commit'), 0o755);
  symlinkSync(join(root, 'node_modules'), join(cwd, 'node_modules'), 'junction');
  return {
    cwd,
    git,
    write(path, content) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    },
    commit: () => run('commit', '--quiet', '-m', 'test'),
    check: (...args) => spawnSync(process.execPath, ['scripts/check-frontmatter.mjs', ...args], { cwd, encoding: 'utf8' }),
  };
}

function succeeds(result) {
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
}

function blocked(result, path) {
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(path), result.stderr);
}

test('따옴표 없는 콜론과 닫는 구분자 누락을 차단한다', t => {
  const repo = repository(t);
  repo.write('invalid.md', invalid);
  repo.git('add', 'invalid.md');
  blocked(repo.commit(), 'invalid.md');
  repo.write('invalid.md', '---\ntitle: "회의: 운영"\n');
  repo.git('add', 'invalid.md');
  blocked(repo.commit(), 'invalid.md');
});

test('따옴표 제목, CRLF와 한글 공백 경로를 허용한다', t => {
  const repo = repository(t);
  repo.write('회의록/팀 운영.md', valid.replaceAll('\n', '\r\n'));
  repo.git('add', '회의록/팀 운영.md');
  succeeds(repo.commit());
});

test('작업 파일을 고쳐도 스테이징된 YAML이 잘못되면 차단한다', t => {
  const repo = repository(t);
  repo.write('meeting.md', invalid);
  repo.git('add', 'meeting.md');
  repo.write('meeting.md', valid);
  blocked(repo.commit(), 'meeting.md');
});

test('스테이징된 YAML이 정상이면 작업 파일의 오류와 관계없이 허용한다', t => {
  const repo = repository(t);
  repo.write('meeting.md', valid);
  repo.git('add', 'meeting.md');
  repo.write('meeting.md', invalid);
  succeeds(repo.commit());
  assert.equal(repo.git('show', 'HEAD:meeting.md'), valid);
});

test('일반 Markdown과 이름 변경 및 삭제를 허용한다', t => {
  const repo = repository(t);
  repo.write('plain.md', '# 메모\n\ntitle: 회의: 운영\n');
  repo.write('old.md', valid);
  repo.write('deleted.md', valid);
  repo.git('add', 'plain.md', 'old.md', 'deleted.md');
  succeeds(repo.commit());
  renameSync(join(repo.cwd, 'old.md'), join(repo.cwd, '이름 변경.md'));
  rmSync(join(repo.cwd, 'deleted.md'));
  repo.git('add', '-A', '--', 'old.md', '이름 변경.md', 'deleted.md');
  succeeds(repo.commit());
});

test('--all은 스테이징 변경 없이도 HEAD의 YAML 오류를 차단한다', t => {
  const repo = repository(t);
  repo.write('회의록/팀 운영.md', invalid);
  repo.git('add', '회의록/팀 운영.md');
  repo.git('-c', 'core.hooksPath=.disabled-hooks', 'commit', '--quiet', '-m', 'test');
  assert.equal(repo.git('diff', '--cached', '--name-only'), '');
  blocked(repo.check('--all'), '회의록/팀 운영.md');
  repo.write('회의록/팀 운영.md', valid);
  blocked(repo.check('--all'), '회의록/팀 운영.md');
});

test('--all은 HEAD가 정상이면 스테이징, 작업 파일과 미추적 파일의 오류를 무시한다', t => {
  const repo = repository(t);
  repo.write('meeting.md', valid);
  repo.git('add', 'meeting.md');
  succeeds(repo.commit());
  repo.write('meeting.md', invalid);
  repo.git('add', 'meeting.md');
  repo.write('untracked.md', invalid);
  succeeds(repo.check('--all'));
});
