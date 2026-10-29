import { retrieveNotes } from "./retrieve.ts";
import { enforceGrounding, buildSafeDraft } from "./safety.ts";
import type { AiRunner, MeetingNote } from "./types.ts";

export const MODEL = "@cf/openai/gpt-oss-120b";

const SYSTEM = [
  "너는 팀 회의록만 보고 답하는 슬랙 봇이다.",
  "제공된 회의록 밖에 있는 사실은 만들지 마라.",
  "status가 needs-review인 문서는 팀 합의나 확정된 사실로 말하지 마라. 기록에 남아 있다는 수준으로만 말하라.",
  "status가 reviewed인 문서만 기록된 결정으로 말하라.",
  "답은 한국어로 짧게 쓰고 날짜를 남겨라.",
  "출처 줄은 따로 붙으니 링크를 지어내지 마라.",
].join("\n");

export function parseAiText(payload: unknown): string {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (typeof record.response === "string") return record.response;
  if (typeof record.result === "string") return record.result;
  if (record.result && typeof record.result === "object") {
    const nested = record.result as Record<string, unknown>;
    if (typeof nested.response === "string") return nested.response;
  }
  if (Array.isArray(record.choices)) {
    const first = record.choices[0];
    if (first && typeof first === "object") {
      const message = (first as { message?: { content?: unknown } }).message;
      if (typeof message?.content === "string") return message.content;
    }
  }
  if (!Array.isArray(record.output)) return "";
  const texts: string[] = [];
  for (const item of record.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (typeof content === "string") texts.push(content);
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        texts.push((part as { text: string }).text);
      }
    }
  }
  return texts.join("\n").trim();
}

function promptFor(question: string, notes: MeetingNote[]): string {
  const blocks = notes.map((note) =>
    [
      `[status=${note.status} date=${note.date} title=${note.title} path=${note.path}]`,
      note.body,
    ].join("\n"),
  );
  return `질문: ${question}\n\n회의록:\n${blocks.join("\n\n")}`;
}

export async function answerQuestion(input: {
  question: string;
  notes: MeetingNote[];
  repoUrl: string;
  ai?: AiRunner;
}): Promise<string> {
  const question = input.question.trim();
  const selected = question ? retrieveNotes(question, input.notes) : [];
  if (selected.length === 0) {
    return enforceGrounding({ draft: "", notes: [], repoUrl: input.repoUrl });
  }

  let draft = "";
  if (input.ai) {
    try {
      const payload = await input.ai.run(MODEL, {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: promptFor(question, selected) },
        ],
        max_tokens: 800,
        temperature: 0.2,
      });
      draft = parseAiText(payload).trim();
    } catch {
      draft = "";
    }
  }
  if (!draft) draft = buildSafeDraft(selected);
  return enforceGrounding({ draft, notes: selected, repoUrl: input.repoUrl });
}
