#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

if [ -n "$(git status --porcelain)" ]; then
  printf '%s\n' '로컬 변경사항이 있어 자동 동기화를 멈춥니다. 변경사항을 먼저 검토하고 커밋하거나 보관해 주세요.' >&2
  exit 1
fi

git pull --ff-only
