export type ReviewStatus = "reviewed" | "needs-review";

export interface MeetingNote {
  id: string;
  path: string;
  date: string;
  title: string;
  status: ReviewStatus;
  body: string;
  sourceUrl?: string;
  transcriptPath?: string;
}

export interface Env {
  AI: Ai;
  BRAIN: DurableObjectNamespace<import("./brain.ts").TeamBrain>;
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_BOT_USER_ID?: string;
  SLACK_SUMMARY_CHANNEL?: string;
  NOTION_TOKEN?: string;
  NOTION_DATABASE_ID?: string;
  NOTION_VERSION?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  NOTES_REPO_URL?: string;
}

export interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
