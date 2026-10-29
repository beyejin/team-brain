import kickoff from "../meetings/2026/04/2026-04-02-kickoff.md";
import demoScope from "../meetings/2026/04/2026-04-09-demo-scope.md";
import showcase from "../meetings/2026/04/2026-04-16-showcase.md";
import { parseMeetingMarkdown } from "./notes.ts";
import type { MeetingNote } from "./types.ts";

const FILES: Array<{ path: string; markdown: string }> = [
  { path: "meetings/2026/04/2026-04-02-kickoff.md", markdown: kickoff },
  { path: "meetings/2026/04/2026-04-09-demo-scope.md", markdown: demoScope },
  { path: "meetings/2026/04/2026-04-16-showcase.md", markdown: showcase },
];

export function bundledSampleNotes(): MeetingNote[] {
  return FILES.map((file) => parseMeetingMarkdown(file.path, file.markdown));
}
