import assert from "node:assert/strict";
import test from "node:test";

import { MODEL, answerQuestion, parseAiText } from "../src/answer.ts";
import { NOT_FOUND, UNREVIEWED_PREAMBLE } from "../src/safety.ts";
import { loadSampleNotes, repoUrl } from "./samples.ts";

test("answers without a model still cite the reviewed note", async () => {
  const text = await answerQuestion({
    question: "팀 이름이 확정됐나요?",
    notes: loadSampleNotes(),
    repoUrl,
  });
  assert.match(text, /북극성/);
  assert.match(text, /2026-04-02 \/ reviewed/);
  assert.doesNotMatch(text, new RegExp(UNREVIEWED_PREAMBLE));
});

test("a model that overclaims an unreviewed note is corrected", async () => {
  const text = await answerQuestion({
    question: "데모 범위를 줄이자고 했나요?",
    notes: loadSampleNotes(),
    repoUrl,
    ai: {
      async run(model) {
        assert.equal(model, MODEL);
        return { response: "데모 범위는 회의록 검색으로 확정되었습니다." };
      },
    },
  });
  assert.match(text, new RegExp(UNREVIEWED_PREAMBLE));
  assert.doesNotMatch(text, /확정되었습니다/);
  assert.match(text, /needs-review/);
});

test("questions outside the notes are refused even if the model invents an answer", async () => {
  const text = await answerQuestion({
    question: "양자 컴퓨터 예산은 얼마인가요?",
    notes: loadSampleNotes(),
    repoUrl,
    ai: {
      async run() {
        throw new Error("model should not be called");
      },
    },
  });
  assert.equal(text, NOT_FOUND);
});

test("parses workers ai response shapes", () => {
  assert.equal(parseAiText({ response: "안녕" }), "안녕");
  assert.equal(
    parseAiText({ choices: [{ message: { content: "선택" } }] }),
    "선택",
  );
  assert.equal(
    parseAiText({ output: [{ content: [{ text: "출력" }] }] }),
    "출력",
  );
});
