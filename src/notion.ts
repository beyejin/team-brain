import { meetingPath, parseReviewStatus } from "./notes.ts";
import type { MeetingNote } from "./types.ts";

interface RichText {
  plain_text?: string;
}

interface NotionProperty {
  type?: string;
  title?: RichText[];
  rich_text?: RichText[];
  date?: { start?: string | null } | null;
  status?: { name?: string | null } | null;
  select?: { name?: string | null } | null;
}

export interface NotionPage {
  id?: string;
  properties?: Record<string, NotionProperty>;
}

export interface NotionBlock {
  type?: string;
  paragraph?: { rich_text?: RichText[] };
  heading_1?: { rich_text?: RichText[] };
  heading_2?: { rich_text?: RichText[] };
  heading_3?: { rich_text?: RichText[] };
  bulleted_list_item?: { rich_text?: RichText[] };
  numbered_list_item?: { rich_text?: RichText[] };
}

function plain(items: RichText[] | undefined): string {
  return (items ?? []).map((item) => item.plain_text ?? "").join("").trim();
}

function propertyText(property: NotionProperty | undefined): string {
  if (!property) return "";
  if (property.type === "title") return plain(property.title);
  if (property.type === "rich_text") return plain(property.rich_text);
  if (property.type === "status") return property.status?.name ?? "";
  if (property.type === "select") return property.select?.name ?? "";
  if (property.type === "date") return property.date?.start?.slice(0, 10) ?? "";
  return "";
}

function findProperty(
  properties: Record<string, NotionProperty>,
  type: string,
  names: string[],
): NotionProperty | undefined {
  for (const name of names) {
    const property = properties[name];
    if (property?.type === type) return property;
  }
  return Object.values(properties).find((property) => property.type === type);
}

export function blocksToMarkdown(blocks: NotionBlock[]): string {
  const lines: string[] = [];
  let number = 1;
  for (const block of blocks) {
    if (block.type === "heading_1") lines.push(`# ${plain(block.heading_1?.rich_text)}`);
    else if (block.type === "heading_2") lines.push(`## ${plain(block.heading_2?.rich_text)}`);
    else if (block.type === "heading_3") lines.push(`### ${plain(block.heading_3?.rich_text)}`);
    else if (block.type === "bulleted_list_item") {
      lines.push(`- ${plain(block.bulleted_list_item?.rich_text)}`);
      number = 1;
    } else if (block.type === "numbered_list_item") {
      lines.push(`${number}. ${plain(block.numbered_list_item?.rich_text)}`);
      number += 1;
    } else if (block.type === "paragraph") {
      const text = plain(block.paragraph?.rich_text);
      if (text) lines.push(text);
      number = 1;
    }
  }
  return lines.filter(Boolean).join("\n");
}

export function notionPageToNote(page: NotionPage, blocks: NotionBlock[]): MeetingNote | null {
  const properties = page.properties ?? {};
  const title = propertyText(findProperty(properties, "title", ["이름", "Name", "title"]));
  const date = propertyText(findProperty(properties, "date", ["날짜", "Date", "date"]));
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const statusRaw =
    propertyText(findProperty(properties, "status", ["상태", "Status", "status"])) ||
    propertyText(findProperty(properties, "select", ["상태", "Status", "status"]));
  const sourceUrl = propertyText(
    findProperty(properties, "rich_text", ["source_url", "공개링크", "link"]),
  );
  const path = meetingPath(date, title);
  return {
    id: path,
    path,
    date,
    title,
    status: parseReviewStatus(statusRaw),
    body: blocksToMarkdown(blocks),
    sourceUrl: sourceUrl || undefined,
  };
}

export function notionQueryRequest(databaseId: string, token: string, version = "2022-06-28"): {
  url: string;
  init: RequestInit;
} {
  return {
    url: `https://api.notion.com/v1/databases/${encodeURIComponent(databaseId)}/query`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": version,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100 }),
    },
  };
}

export function notionBlocksRequest(pageId: string, token: string, version = "2022-06-28"): {
  url: string;
  init: RequestInit;
} {
  return {
    url: `https://api.notion.com/v1/blocks/${encodeURIComponent(pageId)}/children?page_size=100`,
    init: {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": version,
      },
    },
  };
}
