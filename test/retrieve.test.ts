import assert from "node:assert/strict";
import test from "node:test";

import { retrieveNotes } from "../src/retrieve.ts";
import { loadSampleNotes } from "./samples.ts";

test("team-name question hits the reviewed kickoff note", () => {
  const notes = retrieveNotes("팀 이름이 확정됐나요?", loadSampleNotes());
  assert.equal(notes[0]?.title, "킥오프");
  assert.equal(notes[0]?.status, "reviewed");
});

test("demo-scope question hits only the unreviewed draft", () => {
  const notes = retrieveNotes("데모 범위를 줄이자고 했나요?", loadSampleNotes());
  assert.deepEqual(
    notes.map((note) => note.title),
    ["데모 범위 초안"],
  );
});

test("unknown topics retrieve nothing", () => {
  assert.deepEqual(retrieveNotes("양자 컴퓨터 예산은 얼마인가요?", loadSampleNotes()), []);
});
