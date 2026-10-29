import assert from "node:assert/strict";
import test from "node:test";

import {
  NOT_FOUND,
  UNREVIEWED_PREAMBLE,
  enforceGrounding,
  summaryText,
} from "../src/safety.ts";
import { loadSampleNotes, repoUrl } from "./samples.ts";

const samples = loadSampleNotes();
const kickoff = samples.find((note) => note.title === "킥오프");
const draft = samples.find((note) => note.status === "needs-review");
const showcase = samples.find((note) => note.title === "발표 일정");
if (!kickoff || !draft || !showcase) throw new Error("sample notes missing");

test("no supporting notes become a refusal, ignoring the draft", () => {
  const text = enforceGrounding({
    draft: "예산은 120만원으로 확정되었습니다.",
    notes: [],
    repoUrl,
  });
  assert.equal(text, NOT_FOUND);
  assert.doesNotMatch(text, /120만/);
});

test("needs-review evidence is not restated as a decision", () => {
  const text = enforceGrounding({
    draft: "데모 범위는 회의록 검색으로 확정되었습니다.",
    notes: [draft],
    repoUrl,
  });
  assert.match(text, new RegExp(UNREVIEWED_PREAMBLE));
  assert.doesNotMatch(text, /확정되었습니다|결정되었습니다/);
  assert.match(text, /needs-review/);
  assert.match(text, /2026-04-09/);
  assert.match(text, /meetings\/2026\/04\/2026-04-09-demo-scope\.md/);
});

test("reviewed evidence can state the recorded decision and cites the file", () => {
  const text = enforceGrounding({
    draft: "2026-04-02 회의록에는 팀 이름을 북극성으로 확정했다고 적혀 있습니다.",
    notes: [kickoff],
    repoUrl,
  });
  assert.match(text, /북극성/);
  assert.doesNotMatch(text, new RegExp(UNREVIEWED_PREAMBLE));
  assert.match(text, /reviewed/);
  assert.match(text, new RegExp(`https://github.com/beyejin/team-brain/blob/main/${kickoff.path}`));
});

test("mixed evidence keeps a caveat for the unreviewed source", () => {
  const text = enforceGrounding({
    draft: "팀 이름은 북극성으로 기록되어 있습니다.",
    notes: [kickoff, draft],
    repoUrl,
  });
  assert.match(text, /needs-review 상태인 출처는 검토 전 기록/);
  assert.match(text, /킥오프/);
  assert.match(text, /데모 범위 초안/);
});

test("summary of an unreviewed note does not quote the draft as fact", () => {
  const unreviewed = summaryText(draft, repoUrl);
  assert.match(unreviewed, /검토 전 초안/);
  assert.doesNotMatch(unreviewed, /회의록 검색/);
  const reviewed = summaryText(showcase, repoUrl);
  assert.match(reviewed, /2026-04-30/);
  assert.match(reviewed, /reviewed/);
});
