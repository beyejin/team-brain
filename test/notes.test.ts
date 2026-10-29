import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { meetingPath, noteToMarkdown, parseMeetingMarkdown } from "../src/notes.ts";
import { loadSampleNotes, root } from "./samples.ts";

test("sample notes are short fictional records with both review states", () => {
  const notes = loadSampleNotes();
  assert.equal(notes.length, 3);
  assert.deepEqual(
    notes.map((note) => note.status).sort(),
    ["needs-review", "reviewed", "reviewed"],
  );
  const kickoff = notes.find((note) => note.title === "킥오프");
  if (!kickoff?.transcriptPath) throw new Error("missing kickoff transcript");
  assert.match(kickoff.body, /북극성/);
  assert.equal(kickoff.transcriptPath, "sources/meetings/2026/04/2026-04-02-kickoff.md");
  const transcript = readFileSync(join(root, kickoff.transcriptPath), "utf8");
  assert.match(transcript, /북극성/);
});

test("meeting paths use the date and a slug, not an external id", () => {
  assert.equal(meetingPath("2026-04-09", "데모 범위 초안"), "meetings/2026/04/2026-04-09-데모-범위-초안.md");
});

test("markdown round trip keeps status and drops nothing from the body", () => {
  const note = parseMeetingMarkdown(
    "meetings/2026/04/2026-04-09-demo-scope.md",
    readFileSync(join(root, "meetings/2026/04/2026-04-09-demo-scope.md"), "utf8"),
  );
  const again = parseMeetingMarkdown(note.path, noteToMarkdown(note));
  assert.equal(again.status, "needs-review");
  assert.equal(again.title, note.title);
  assert.match(again.body, /결론은 적히지 않았다/);
});
