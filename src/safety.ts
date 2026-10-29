import type { MeetingNote } from "./types.ts";

export const UNREVIEWED_PREAMBLE =
  "팀원 검토 전 기록을 근거로 한 답변이며, 현재 팀 합의로 확정할 수 없습니다.";

export const NOT_FOUND =
  "회의록에서 이 질문의 근거를 찾지 못했습니다. 기록에 없는 내용은 답하지 않습니다.";

export const UNREVIEWED_CAVEAT =
  "needs-review 상태인 출처는 검토 전 기록이라 팀 합의로 말하지 않습니다.";

const DECISION_SENTENCE =
  /확정되었|확정했|결정되었|결정했|합의로 확정|최종 결정|확정된 사실/;

export function formatCitation(note: MeetingNote, repoUrl: string): string {
  const base = repoUrl.replace(/\/$/, "");
  const href = `${base}/blob/main/${encodeURI(note.path)}`;
  const title = /\s/.test(note.title) ? `"${note.title}"` : note.title;
  const label = `${note.date} / ${note.status} / ${title} / ${note.path}`;
  return `출처: <${href}|${label}>`;
}

function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[\.!?])\s+/))
    .map((part) => part.trim())
    .filter(Boolean);
}

export function dropDecisionSentences(text: string): string {
  return sentences(text)
    .filter((sentence) => !DECISION_SENTENCE.test(sentence))
    .join("\n");
}

function excerpt(body: string): string {
  const lines = body
    .split(/\n+/)
    .map((line) => line.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "").trim())
    .filter((line) => line && !line.startsWith("---"));
  return lines.slice(0, 2).join(" ");
}

export function buildSafeDraft(notes: MeetingNote[]): string {
  return notes
    .map((note) => {
      const snippet = excerpt(note.body);
      if (note.status === "needs-review") {
        return `${note.date} 「${note.title}」는 검토 전 기록입니다. 기록에 남은 문장: ${snippet} 이 내용을 팀 합의로 볼 수는 없습니다.`;
      }
      return `${note.date} 「${note.title}」 회의록(reviewed)에는 이렇게 기록되어 있습니다. ${snippet}`;
    })
    .join("\n\n");
}

export function enforceGrounding(input: {
  draft: string;
  notes: MeetingNote[];
  repoUrl: string;
}): string {
  if (input.notes.length === 0) return NOT_FOUND;

  const unreviewedOnly = input.notes.every((note) => note.status === "needs-review");
  const mixed = !unreviewedOnly && input.notes.some((note) => note.status === "needs-review");
  let body = input.draft.trim();

  if (unreviewedOnly) {
    body = dropDecisionSentences(body);
    if (!body || body === UNREVIEWED_PREAMBLE) body = buildSafeDraft(input.notes);
    if (!body.startsWith(UNREVIEWED_PREAMBLE)) {
      body = `${UNREVIEWED_PREAMBLE}\n\n${body}`;
    }
  } else if (mixed && !body.includes(UNREVIEWED_CAVEAT)) {
    body = `${body}\n\n${UNREVIEWED_CAVEAT}`;
  }

  const citations = input.notes.map((note) => formatCitation(note, input.repoUrl));
  const missing = citations.filter((citation) => !body.includes(citation));
  if (missing.length === 0) return body;
  return `${body}\n\n${missing.join("\n")}`;
}

export function summaryText(note: MeetingNote, repoUrl: string): string {
  const citation = formatCitation(note, repoUrl);
  if (note.status === "needs-review") {
    return [
      "새 회의록이 동기화되었습니다.",
      `${note.date} 「${note.title}」`,
      "상태는 needs-review 입니다. 검토 전 초안이라 본문은 합의된 사실로 안내하지 않습니다.",
      citation,
    ].join("\n");
  }
  return [
    "새 회의록이 동기화되었습니다.",
    `${note.date} 「${note.title}」 (reviewed)`,
    excerpt(note.body),
    citation,
  ].join("\n");
}
