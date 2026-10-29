const FIVE_MINUTES_MS = 5 * 60 * 1000;

export interface SlackEvent {
  type?: string;
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

export interface SlackEventPayload {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: SlackEvent;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string;
  signature: string;
  body: string;
  nowMs?: number;
}): Promise<boolean> {
  if (!input.signingSecret || !input.timestamp || !input.signature) return false;
  const timestampMs = Number(input.timestamp) * 1000;
  if (!Number.isFinite(timestampMs)) return false;
  const now = input.nowMs ?? Date.now();
  if (Math.abs(now - timestampMs) > FIVE_MINUTES_MS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${input.timestamp}:${input.body}`),
  );
  return timingSafeEqual(input.signature, `v0=${hex(mac)}`);
}

export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function isQuestionForBot(event: SlackEvent, botUserId?: string): boolean {
  if (event.bot_id || event.subtype === "bot_message") return false;
  if (event.type === "app_mention") return true;
  if (!botUserId || !event.text) return false;
  return event.text.includes(`<@${botUserId}>`);
}

export function slackMessageBody(input: {
  channel: string;
  text: string;
  threadTs?: string;
}): Record<string, string> {
  const body: Record<string, string> = {
    channel: input.channel,
    text: input.text,
  };
  if (input.threadTs) body.thread_ts = input.threadTs;
  return body;
}
