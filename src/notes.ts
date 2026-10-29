import type { MeetingNote, ReviewStatus } from "./types.ts";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseReviewStatus(value: string | undefined): ReviewStatus {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "reviewed" || normalized === "done" || normalized === "검토완료") {
    return "reviewed";
  }
  return "needs-review";
}

function frontmatterValue(block: string, key: string): string | undefined {
  const match = block.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!match) return undefined;
  return match[1].trim().replace(/^["']|["']$/g, "");
}

export function parseMeetingMarkdown(path: string, markdown: string): MeetingNote {
  const matched = markdown.match(FRONTMATTER);
  const block = matched?.[1] ?? "";
  const body = (matched ? markdown.slice(matched[0].length) : markdown).trim();
  const date = frontmatterValue(block, "date");
  const title = frontmatterValue(block, "title");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Meeting note ${path} needs a date: YYYY-MM-DD frontmatter field`);
  }
  if (!title) {
    throw new Error(`Meeting note ${path} needs a title frontmatter field`);
  }
  const sourceUrl = frontmatterValue(block, "source_url");
  const transcriptPath = frontmatterValue(block, "transcript");
  return {
    id: path,
    path,
    date,
    title,
    status: parseReviewStatus(frontmatterValue(block, "status")),
    body,
    sourceUrl: sourceUrl || undefined,
    transcriptPath: transcriptPath || undefined,
  };
}

export function noteToMarkdown(note: MeetingNote): string {
  const lines = [
    "---",
    `date: ${note.date}`,
    `title: ${JSON.stringify(note.title)}`,
    `status: ${note.status}`,
  ];
  if (note.sourceUrl) lines.push(`source_url: ${note.sourceUrl}`);
  if (note.transcriptPath) lines.push(`transcript: ${note.transcriptPath}`);
  lines.push("---", "", note.body.trim(), "");
  return lines.join("\n");
}

export function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{Letter}\p{Number}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "note";
}

export function meetingPath(date: string, title: string): string {
  const [year, month] = date.split("-");
  return `meetings/${year}/${month}/${date}-${slugifyTitle(title)}.md`;
}
