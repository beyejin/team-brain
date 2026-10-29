import { answerQuestion } from "./answer.ts";
import { TeamBrain } from "./brain.ts";
import { handleSlackRequest, slackMessageBody } from "./events.ts";
import { bundledSampleNotes } from "./sample-notes.ts";
import { runSync } from "./sync.ts";
import type { Env } from "./types.ts";

export { TeamBrain };

const SAMPLE_SEED_TIME = "2026-04-16T00:00:00.000Z";

function repoUrl(env: Env): string {
  return env.NOTES_REPO_URL || "https://github.com/beyejin/team-brain";
}

function brainStub(env: Env): DurableObjectStub<TeamBrain> {
  return env.BRAIN.get(env.BRAIN.idFromName("team"));
}

async function prepare(env: Env): Promise<DurableObjectStub<TeamBrain>> {
  const stub = brainStub(env);
  if (!env.NOTION_TOKEN || !env.NOTION_DATABASE_ID) {
    await stub.seedSamples(bundledSampleNotes(), SAMPLE_SEED_TIME);
  }
  return stub;
}

async function postSlack(
  token: string,
  message: { channel: string; text: string; threadTs?: string },
): Promise<void> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(slackMessageBody(message)),
  });
  if (!response.ok) throw new Error(`Slack post failed (${response.status})`);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json({
        ok: true,
        service: "team-brain",
        model: "@cf/openai/gpt-oss-120b",
      });
    }

    if (request.method === "POST" && url.pathname === "/slack/events") {
      if (!env.SLACK_SIGNING_SECRET) {
        return new Response("SLACK_SIGNING_SECRET is not configured", { status: 500 });
      }
      const stub = await prepare(env);
      return handleSlackRequest(request, {
        signingSecret: env.SLACK_SIGNING_SECRET,
        store: {
          listNotes: () => stub.listNotes(),
          upsertNotes: (notes, nowIso) => stub.upsertNotes(notes, nowIso),
          claimEvent: (eventId, nowIso) => stub.claimEvent(eventId, nowIso),
          listUnannounced: () => stub.listUnannounced(),
          markAnnounced: (ids, nowIso) => stub.markAnnounced(ids, nowIso),
        },
        repoUrl: repoUrl(env),
        botUserId: env.SLACK_BOT_USER_ID,
        ai: env.AI,
        postMessage: async (message) => {
          if (!env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is not configured");
          await postSlack(env.SLACK_BOT_TOKEN, message);
        },
      });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const stub = await prepare(env);
        try {
          await runSync({
            store: {
              listNotes: () => stub.listNotes(),
              upsertNotes: (notes, nowIso) => stub.upsertNotes(notes, nowIso),
              claimEvent: (eventId, nowIso) => stub.claimEvent(eventId, nowIso),
              listUnannounced: () => stub.listUnannounced(),
              markAnnounced: (ids, nowIso) => stub.markAnnounced(ids, nowIso),
            },
            repoUrl: repoUrl(env),
            notion:
              env.NOTION_TOKEN && env.NOTION_DATABASE_ID
                ? {
                    token: env.NOTION_TOKEN,
                    databaseId: env.NOTION_DATABASE_ID,
                    version: env.NOTION_VERSION,
                  }
                : undefined,
            github:
              env.GITHUB_TOKEN && env.GITHUB_REPO
                ? { token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO }
                : undefined,
            summaryChannel: env.SLACK_SUMMARY_CHANNEL,
            postMessage: env.SLACK_BOT_TOKEN
              ? async (message) => {
                  await postSlack(env.SLACK_BOT_TOKEN as string, message);
                }
              : undefined,
          });
        } catch (error) {
          console.error(error instanceof Error ? error.message : "sync failed");
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

export { answerQuestion };
