import assert from "node:assert/strict";
import test from "node:test";

import { githubContentsRequest } from "../src/github.ts";
import { notionPageToNote, notionQueryRequest } from "../src/notion.ts";
import { runSync } from "../src/sync.ts";
import { createSqlNoteStore, seedSamples } from "../src/store.ts";
import type { MeetingNote } from "../src/types.ts";
import { createMemorySql } from "./memory-sql.ts";
import { loadSampleNotes, repoUrl } from "./samples.ts";

const notionPage = {
  id: "sample-page",
  properties: {
    이름: { type: "title", title: [{ plain_text: "샘플 회고" }] },
    날짜: { type: "date", date: { start: "2026-04-20" } },
    상태: { type: "status", status: { name: "needs-review" } },
    source_url: { type: "rich_text", rich_text: [{ plain_text: "https://notes.example/sample/retro" }] },
  },
};

const notionBlocks = [
  { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "다음 회의 안건은 데모 순서다." }] } },
];

test("notion pages without a status stay needs-review and pages without a date are skipped", () => {
  const note = notionPageToNote(notionPage, notionBlocks);
  if (!note) throw new Error("expected a note");
  assert.equal(note.status, "needs-review");
  assert.equal(note.date, "2026-04-20");
  assert.match(note.body, /데모 순서/);
  assert.equal(note.sourceUrl, "https://notes.example/sample/retro");
  assert.equal(
    notionPageToNote(
      { properties: { 이름: { type: "title", title: [{ plain_text: "날짜 없음" }] } } },
      [],
    ),
    null,
  );
});

test("notion query uses the placeholder database id and bearer token", () => {
  const request = notionQueryRequest("SAMPLE_DATABASE_ID", "SAMPLE_TOKEN");
  assert.equal(request.url, "https://api.notion.com/v1/databases/SAMPLE_DATABASE_ID/query");
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("Authorization"), "Bearer SAMPLE_TOKEN");
});

test("sync inserts a note, posts one summary, and does not repeat it", async () => {
  const store = createSqlNoteStore(createMemorySql());
  const posts: string[] = [];
  const fetches: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    fetches.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/query")) {
      return Response.json({ results: [notionPage] });
    }
    if (url.includes("/blocks/")) return Response.json({ results: notionBlocks });
    if (url.includes("api.github.com") && (init?.method ?? "GET") === "GET") {
      return new Response("missing", { status: 404 });
    }
    if (url.includes("api.github.com") && init?.method === "PUT") return Response.json({ ok: true });
    return new Response("unexpected", { status: 500 });
  };

  const deps = {
    store,
    repoUrl,
    nowIso: "2026-04-20T00:00:00.000Z",
    notion: { token: "SAMPLE_TOKEN", databaseId: "SAMPLE_DATABASE_ID" },
    github: { token: "SAMPLE_GITHUB_TOKEN", repo: "beyejin/team-brain" },
    summaryChannel: "CSAMPLESUMMARY",
    postMessage: async (message: { text: string }) => {
      posts.push(message.text);
    },
    fetchImpl,
  };

  const first = await runSync(deps);
  const second = await runSync(deps);
  assert.equal(first.inserted, 1);
  assert.equal(first.announced, 1);
  assert.equal(second.inserted, 0);
  assert.equal(second.announced, 0);
  assert.match(posts[0], /needs-review/);
  assert.match(posts[0], /검토 전 초안/);
  assert.doesNotMatch(posts[0], /데모 순서/);

  const put = fetches.find((call) => call.method === "PUT");
  if (!put) throw new Error("expected a GitHub write");
  assert.match(put.url, /repos\/beyejin\/team-brain\/contents\/meetings\/2026\/04\//);
  const body = JSON.parse(put.body ?? "{}") as { content?: string; message?: string };
  assert.equal(body.content?.includes("SAMPLE_GITHUB_TOKEN"), false);
  const decoded = Buffer.from(body.content ?? "", "base64").toString("utf8");
  assert.match(decoded, /status: needs-review/);
  assert.doesNotMatch(decoded, /SAMPLE_TOKEN|SAMPLE_GITHUB_TOKEN/);
});

test("a failed notion fetch does not throw or announce", async () => {
  const store = createSqlNoteStore(createMemorySql());
  const result = await runSync({
    store,
    repoUrl,
    notion: { token: "SAMPLE_TOKEN", databaseId: "SAMPLE_DATABASE_ID" },
    summaryChannel: "CSAMPLESUMMARY",
    postMessage: async () => {
      throw new Error("should not post");
    },
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  assert.deepEqual(result, { inserted: 0, announced: 0 });
});

test("seeded samples are searchable and are not announced again", async () => {
  const store = createSqlNoteStore(createMemorySql());
  await seedSamples(store, loadSampleNotes(), "2026-04-16T00:00:00.000Z");
  assert.equal((await store.listNotes()).length, 3);
  assert.deepEqual(await store.listUnannounced(), []);
  const again = await store.upsertNotes(loadSampleNotes(), "2026-04-17T00:00:00.000Z");
  assert.deepEqual(again, []);
});

test("github write request carries the note and optional sha", () => {
  const note: MeetingNote = {
    id: "meetings/2026/04/2026-04-20-샘플-회고.md",
    path: "meetings/2026/04/2026-04-20-샘플-회고.md",
    date: "2026-04-20",
    title: "샘플 회고",
    status: "reviewed",
    body: "기록만 남긴다.",
  };
  const request = githubContentsRequest({
    repo: "beyejin/team-brain",
    token: "SAMPLE_GITHUB_TOKEN",
    note,
    sha: "abc123",
  });
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("Authorization"), "Bearer SAMPLE_GITHUB_TOKEN");
  const body = JSON.parse(String(request.init.body)) as { sha?: string; content: string };
  assert.equal(body.sha, "abc123");
  assert.doesNotMatch(body.content, /SAMPLE_GITHUB_TOKEN/);
});
