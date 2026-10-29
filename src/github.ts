import { noteToMarkdown } from "./notes.ts";
import type { MeetingNote } from "./types.ts";

export function githubContentsRequest(input: {
  repo: string;
  token: string;
  note: MeetingNote;
  sha?: string;
}): { url: string; init: RequestInit } {
  const body: Record<string, string> = {
    message: `Sync meeting note ${input.note.date} ${input.note.title}`,
    content: bytesToBase64(new TextEncoder().encode(noteToMarkdown(input.note))),
  };
  if (input.sha) body.sha = input.sha;
  return {
    url: `https://api.github.com/repos/${input.repo}/contents/${encodeURI(input.note.path)}`,
    init: {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "team-brain",
      },
      body: JSON.stringify(body),
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
