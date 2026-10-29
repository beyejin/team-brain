# 팀 브레인 Slack 봇

질문 채널에서 봇을 멘션하면, 배포에 포함된 회의록만 근거로 같은 스레드에 답합니다. 후속 질문에도 봇을 멘션하고 필요한 맥락을 함께 적습니다. 일반 대화와 과거 Slack 대화 기록은 읽지 않습니다.

워크스페이스, 채널, 계정, 봇 사용자 ID는 Git에 넣지 않습니다. `wrangler.jsonc`의 해당 값은 빈 문자열이고, 비밀은 `.dev.vars` 또는 `wrangler secret`에만 둡니다.

## 사용 범위

- 질문 대상: 환경 변수 `SLACK_TEAM_ID`, `SLACK_CHANNEL_ID`와 모두 일치하는 `app_mention`
- Slack 권한: `app_mentions:read`, `chat:write`
- 자료: Git에 커밋된 `AGENTS.md`와 `meetings/YYYY/MM/*.md`
- 제외: 개인 브레인, 녹음, `sources/` 전사 원문, 미커밋 회의록, 기타 파일
- 모델: Cloudflare Workers AI `@cf/openai/gpt-oss-120b`
- 회의 공지: `SLACK_MEETING_CHANNEL_ID`, `SLACK_MEETING_START_DATE`, `NOTION_DATA_SOURCE_ID`가 있을 때만

답변의 날짜와 검토 상태는 배포 당시 커밋의 파일에서 옵니다. GitHub 회의록 링크는 항상 이 저장소 `main`의 최신 문서를 엽니다. 따라서 링크를 열었을 때의 내용은 답변 당시 기록보다 최신일 수 있습니다. `needs-review` 기록은 검토 전이라는 안내를 붙입니다. 근거가 없거나 출처 ID가 올바르지 않으면 추측한 답변을 채택하지 않습니다.

## 실행 구조

Slack 멘션 → 서명 검증 → 지정 워크스페이스와 채널 확인 → 이벤트별 Durable Object 저장 → 즉시 수신 응답 → alarm에서 AI 호출 → 원질문 스레드에 답변.

같은 이벤트 재전송은 7일 동안 중복 처리하지 않습니다. 완료 후 질문 본문은 작업 저장소에서 지우고 처리 결과만 보관합니다. Slack 전송 직후 완료 상태 저장 전에 장애가 발생하는 드문 경계에서는 중복 답변이 생길 수 있습니다.

`GET /health`는 `{ "ok": true }`만 반환합니다. 외부에서 회의록이나 AI를 직접 조회할 경로는 없습니다. 봇에게 셸 실행, Git 수정, 다른 서비스 조작 도구를 제공하지 않습니다.

## 설치와 검증

이 디렉터리에서 실행합니다.

```sh
npm ci
npm test
npx wrangler login
npm run deploy
```

Slack 앱은 `slack-app-manifest.json`으로 만듭니다. 앱의 Signing Secret과 Bot User OAuth Token은 터미널 입력으로 아래 Secret에 저장합니다. 채팅, Git, 공개 문서에는 값을 적지 않습니다.

```sh
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
```

팀 ID, 질문 채널 ID, 공지 채널 ID, 공지 시작일, Notion 데이터 소스 ID는 `.dev.vars` 또는 Wrangler 변수로 넣습니다. 예시 키는 `.dev.vars.example`에 있습니다.

Secret을 저장한 뒤 Slack 앱의 Event Subscriptions를 켭니다. 배포된 URL의 `/slack/events`를 Request URL로 지정하고 `app_mention`을 구독합니다. 앱을 질문 채널과 회의 공지 채널에 추가합니다.

`npm run check:ai`는 회의록을 Cloudflare AI로 보내 사용량을 소비하지만 Slack 메시지는 보내지 않습니다. 로컬 인증이 있을 때만 실행합니다.

## 회의록 갱신

봇은 **마지막으로 성공한 배포의 기록**을 읽습니다. `main`의 `AGENTS.md` 또는 `meetings/`를 바꾼 뒤 이 디렉터리에서 `npm run deploy`를 하면 `scripts/build-brain.mjs`가 그 커밋의 회의록만 `src/brain.json`으로 묶습니다. 이 파일은 Git에 넣지 않습니다. 미커밋 변경이 있으면 빌드가 멈춥니다.

- 포함 경로: `meetings/YYYY/MM/*.md`, `AGENTS.md`
- 제외: `sources/`, 개인 파일, YAML이 없거나 날짜·제목·상태가 잘못된 파일
- 상태 값: `confirmed`, `proposed`, `needs-review`, `deferred`, `rejected`, `superseded`
- 출처 링크: `https://github.com/beyejin/team-brain/blob/main/<path>`
- 상한: 묶인 JSON이 100,000자를 넘으면 일부를 빼지 않고 빌드를 중단합니다.

테스트나 배포가 실패하면 새 자료가 반영되지 않고 이전 배포가 계속 사용됩니다.

## 회의 요약 자동 공유

배포된 기록 중 `NOTION_DATA_SOURCE_ID`와 같은 Notion 데이터 소스에서 온 회의만 10분마다 확인합니다. `notion_page`와 `notion_data_source`로 원본을 식별합니다. `SLACK_MEETING_START_DATE`보다 이전 회의는 공유하지 않습니다. 설정이 비어 있으면 전송하지 않습니다.

공지는 회의 개요 마지막 2개와 액션 아이템 첫 2개를 우선 발췌하여 1,500자 이내로 만들고, 검토 상태와 Notion 원본 링크를 붙입니다. 해당 구분이 없으면 일반 목록에서 최대 5개를 발췌합니다. AI 추가 호출이나 날짜·이름의 임의 교정은 하지 않습니다. 상세 내용과 전사 원문은 공지에 복사하지 않습니다.

`MeetingShareJob` Durable Object가 페이지 ID별 Slack 메시지 `ts`와 내용 해시를 보관합니다. 최초에는 한 번 게시하고 원본 내용이 바뀌면 같은 메시지를 `chat.update`로 갱신합니다. 수집 시각만 달라지면 갱신하지 않으며, 공지 채널을 바꾸면 기존 페이지의 자동 재게시를 멈춥니다. 이 경로는 `scheduled` 안에서만 호출하고 공개 HTTP 공유 API는 만들지 않습니다.

최초 게시의 네트워크 응답이 사라지거나 성공 직후 상태 저장이 실패하면 중복을 막기 위해 재게시를 보류하고 `team_brain_meeting_share_failed`를 기록합니다. Slack이 명시적으로 거절한 전송과 기존 메시지 갱신 실패는 다음 주기에 재시도합니다.

바인딩은 `EVENT_JOBS`(`EventJob`)와 `MEETING_SHARES`(`MeetingShareJob`)입니다. 배포 전 `npm test`로 미설정·대상 필터·발췌·최초 게시·동일 메시지 갱신·장애 경계를 확인합니다.

추가 OpenAI API 키는 필요하지 않습니다. 사용량은 Cloudflare 계정의 Workers, Durable Objects, Workers AI 할당량에 포함됩니다.

## 근거 문서

- [Slack 멘션 권한](https://docs.slack.dev/reference/scopes/app_mentions.read/)
- [Slack 요청 서명](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Durable Object alarm](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Workers AI 모델](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/)
- [Workers AI 요금과 무료 할당량](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Slack 메시지 갱신](https://docs.slack.dev/reference/methods/chat.update/)
