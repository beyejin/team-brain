import { githubContentsRequest } from "./github.ts";
import { notionBlocksRequest, notionPageToNote, notionQueryRequest, type NotionBlock, type NotionPage } from "./notion.ts";
import { summaryText } from "./safety.ts";
import type { NoteStore } from "./store.ts";
import type { MeetingNote } from "./types.ts";

export interface SyncDeps {
  store: NoteStore;
  repoUrl: string;
  nowIso?: string;
  notion?: { token: string; databaseId: string; version?: string };
  github?: { token: string; repo: string };
  summaryChannel?: string;
  postMessage?: (input: { channel: string; text: string }) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export async function runSync(deps: SyncDeps): Promise<{ inserted: number; announced: number }> {
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const fetchImpl = deps.fetchImpl ?? fetch;
  let inserted: MeetingNote[] = [];

  if (deps.notion?.token && deps.notion.databaseId) {
    try {
      const notes = await fetchNotionNotes(deps.notion, fetchImpl);
      inserted = await deps.store.upsertNotes(notes, nowIso);
      if (deps.github?.token && deps.github.repo) {
        for (const note of inserted) {
          await writeNoteToGithub(deps.github, note, fetchImpl);
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : "notion sync failed");
    }
  }

  if (!deps.summaryChannel || !deps.postMessage) {
    return { inserted: inserted.length, announced: 0 };
  }

  const pending = await deps.store.listUnannounced();
  let announced = 0;
  for (const note of pending) {
    await deps.postMessage({
      channel: deps.summaryChannel,
      text: summaryText(note, deps.repoUrl),
    });
    await deps.store.markAnnounced([note.id], nowIso);
    announced += 1;
  }
  return { inserted: inserted.length, announced };
}

async function fetchNotionNotes(
  notion: { token: string; databaseId: string; version?: string },
  fetchImpl: typeof fetch,
): Promise<MeetingNote[]> {
  const query = notionQueryRequest(notion.databaseId, notion.token, notion.version);
  const response = await fetchImpl(query.url, query.init);
  if (!response.ok) {
    throw new Error(`Notion query failed (${response.status})`);
  }
  const payload = (await response.json()) as { results?: NotionPage[] };
  const notes: MeetingNote[] = [];
  for (const page of payload.results ?? []) {
    if (!page.id) continue;
    const blocksRequest = notionBlocksRequest(page.id, notion.token, notion.version);
    const blocksResponse = await fetchImpl(blocksRequest.url, blocksRequest.init);
    if (!blocksResponse.ok) continue;
    const blocksPayload = (await blocksResponse.json()) as { results?: NotionBlock[] };
    const note = notionPageToNote(page, blocksPayload.results ?? []);
    if (note) notes.push(note);
  }
  return notes;
}

async function writeNoteToGithub(
  github: { token: string; repo: string },
  note: MeetingNote,
  fetchImpl: typeof fetch,
): Promise<void> {
  const lookupUrl = `https://api.github.com/repos/${github.repo}/contents/${encodeURI(note.path)}`;
  const lookup = await fetchImpl(lookupUrl, {
    headers: {
      Authorization: `Bearer ${github.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "team-brain",
    },
  });
  let sha: string | undefined;
  if (lookup.ok) {
    const existing = (await lookup.json()) as { sha?: string };
    sha = existing.sha;
  }
  const write = githubContentsRequest({ repo: github.repo, token: github.token, note, sha });
  const written = await fetchImpl(write.url, write.init);
  if (!written.ok) throw new Error(`GitHub write failed (${written.status})`);
}
