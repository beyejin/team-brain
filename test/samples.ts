import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseMeetingMarkdown } from "../src/notes.ts";
import type { MeetingNote } from "../src/types.ts";

export const root = process.cwd();
export const repoUrl = "https://github.com/beyejin/team-brain";

export function loadSampleNotes(): MeetingNote[] {
  const dir = join(root, "meetings/2026/04");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const path = `meetings/2026/04/${file}`;
      return parseMeetingMarkdown(path, readFileSync(join(root, path), "utf8"));
    });
}
