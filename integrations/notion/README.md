# Notion 회의록 자동 가져오기

`integrations/notion/config.json`에 적힌 일정 데이터 소스에서 회의록을 읽어 `meetings/`에 저장합니다. 일정 페이지가 원본입니다. 기존 회의록 본문은 조건이 맞을 때만 갱신합니다. `main`에 반영된 회의록은 Slack 워커를 다시 배포할 때 답변 자료에 포함됩니다.

식별자와 토큰 자리는 비어 있거나 `YOUR_NOTION_*` 자리표시자입니다. 값을 Git에 커밋하지 않습니다.

## 사용하는 방법

1. 일정 페이지의 이름, 날짜, `카테고리: 팀일정`을 채우고 Notion 회의록 블록으로 기록합니다. 요약이 있는 회의록만 가져옵니다.
2. GitHub Actions가 10분 간격(`7,17,27,37,47,57 * * * *`)으로 확인합니다. 예약 작업은 GitHub 상황에 따라 늦어질 수 있습니다. `workflow_dispatch`로 직접 실행할 수도 있습니다.
3. 새 회의록은 `meetings/YYYY/MM/YYYY-MM-DD-notion-페이지ID.md`에 저장됩니다. 같은 페이지를 수정하면 같은 파일을 갱신합니다.
4. 가져오기와 테스트를 통과하면 `main`에 커밋합니다. 실패하면 기존 파일을 유지합니다.

`작성 완료` 체크는 팀 합의를 뜻하지 않습니다. 자동으로 가져온 회의록은 항상 `needs-review`로 시작합니다. 참석자, 담당자, 기한, 결정 상태를 새로 추측하거나 전사 원문을 읽기용 회의록에 합치지 않습니다.

## 기록 보호

- 대상은 `config.json`의 일정 데이터 소스 하나입니다. 조회와 개별 페이지 확인에서 모두 `팀일정`을 포함하고 `개인 일정`을 제외합니다. 회의록이 없는 일정, 회의록 밖의 메모, 링크로 연결된 다른 페이지, 원문 전사, 개인 브레인은 가져오지 않습니다.
- `existingPages`에 등록한 경로는 수동 관리 기록입니다. 처음에는 해시만 기준점으로 저장하고, 이후 Notion 원문이 달라지면 덮어쓰지 않고 중단합니다.
- 자동관리 파일을 Git에서 직접 수정했으면 다음 Notion 수정 시 덮어쓰지 않고 충돌로 중단합니다.
- Notion에서 삭제하거나 접근할 수 없게 된 기록도 Git에서 자동 삭제하지 않습니다.
- 본문이 잘렸거나 읽지 못한 블록이 있으면 불완전한 내용을 저장하지 않습니다. 날짜, 제목, 본문이 비어 있는 작성 중 페이지는 건너뜁니다.

## 실행과 인증

Notion 내부 연결은 `콘텐츠 읽기` 권한과 `사용자 정보 없음`으로 만들고, 일정 데이터베이스 접근을 허용해야 합니다. API 필터로 팀 일정만 조회하며 개인 일정 본문은 읽지 않습니다. 토큰은 이 저장소의 Actions secret `NOTION_TOKEN`에 둡니다. 토큰 값은 Git, 채팅, 로그에 남기지 않습니다.

GitHub Actions의 쓰기 권한은 이 저장소의 `contents: write`이며, 새 GitHub 개인 토큰은 사용하지 않습니다. 로컬 동기화 스크립트의 `pull --ff-only` 규칙은 그대로입니다.

로컬에서 이미 준비한 `NOTION_TOKEN`과 채워 둔 `config.json`으로 확인할 수 있습니다.

```sh
npm ci
node --test integrations/notion/test/*.test.mjs
node integrations/notion/import.mjs --dry-run
```

실행 기록은 Actions의 `Notion 회의록 가져오기` 워크플로에서 봅니다. 변경이 없으면 새 커밋을 만들지 않습니다. 동시 수정으로 푸시가 거부되면 강제로 덮어쓰지 않고 다음 실행에서 다시 읽습니다.

## 근거

- [Notion 연결 권한](https://developers.notion.com/reference/capabilities)
- [Notion 데이터 소스 조회](https://developers.notion.com/reference/query-a-data-source)
- [Notion 본문 Markdown 조회](https://developers.notion.com/reference/retrieve-page-markdown)
- [GitHub 예약 작업의 제약](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
