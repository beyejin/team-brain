import { answerQuestion } from "./answer.ts";
import { isQuestionForBot, slackMessageBody, stripMention, verifySlackSignature, type SlackEventPayload } from "./slack.ts";
import type { NoteStore } from "./store.ts";
import type { AiRunner } from "./types.ts";

export interface EventDeps {
  signingSecret: string;
  store: NoteStore;
  repoUrl: string;
  botUserId?: string;
  ai?: AiRunner;
  postMessage: (input: { channel: string; text: string; threadTs?: string }) => Promise<void>;
  nowMs?: number;
  nowIso?: string;
}

export async function handleSlackRequest(request: Request, deps: EventDeps): Promise<Response> {
  const body = await request.text();
  const ok = await verifySlackSignature({
    signingSecret: deps.signingSecret,
    timestamp: request.headers.get("x-slack-request-timestamp") ?? "",
    signature: request.headers.get("x-slack-signature") ?? "",
    body,
    nowMs: deps.nowMs,
  });
  if (!ok) return new Response("invalid signature", { status: 401 });

  let payload: SlackEventPayload;
  try {
    payload = JSON.parse(body) as SlackEventPayload;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  if (payload.type === "url_verification" && payload.challenge) {
    return Response.json({ challenge: payload.challenge });
  }

  if (payload.type === "event_callback") {
    await processSlackEvent(payload, deps);
  }
  return new Response("ok");
}

export async function processSlackEvent(payload: SlackEventPayload, deps: EventDeps): Promise<void> {
  const event = payload.event;
  if (!event) return;
  const eventId = payload.event_id ?? `${event.channel ?? "channel"}:${event.ts ?? "ts"}`;
  const claimed = await deps.store.claimEvent(eventId, deps.nowIso ?? new Date().toISOString());
  if (!claimed) return;
  if (!isQuestionForBot(event, deps.botUserId)) return;
  if (!event.channel) return;

  const text = await answerQuestion({
    question: stripMention(event.text ?? ""),
    notes: await deps.store.listNotes(),
    repoUrl: deps.repoUrl,
    ai: deps.ai,
  });
  await deps.postMessage({
    channel: event.channel,
    text,
    threadTs: event.thread_ts ?? event.ts,
  });
}

export function signedSlackHeaders(input: {
  secret: string;
  timestamp: string;
  body: string;
  signature: string;
}): Headers {
  const headers = new Headers();
  headers.set("x-slack-request-timestamp", input.timestamp);
  headers.set("x-slack-signature", input.signature);
  headers.set("content-type", "application/json");
  return headers;
}

export { slackMessageBody };
