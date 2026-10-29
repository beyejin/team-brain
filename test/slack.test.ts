import assert from "node:assert/strict";
import test from "node:test";

import { handleSlackRequest, processSlackEvent } from "../src/events.ts";
import { verifySlackSignature } from "../src/slack.ts";
import { createSqlNoteStore } from "../src/store.ts";
import { createMemorySql } from "./memory-sql.ts";
import { loadSampleNotes, repoUrl } from "./samples.ts";

const secret = "sample-signing-secret";

async function signature(timestamp: string, body: string, signingSecret = secret): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const hex = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}

async function storeWithSamples() {
  const store = createSqlNoteStore(createMemorySql());
  await store.upsertNotes(loadSampleNotes(), "2026-04-16T00:00:00.000Z");
  return store;
}

test("slack signatures reject the wrong secret and stale timestamps", async () => {
  const body = "{}";
  const timestamp = "1700000000";
  const good = await signature(timestamp, body);
  assert.equal(
    await verifySlackSignature({
      signingSecret: secret,
      timestamp,
      signature: good,
      body,
      nowMs: 1700000000 * 1000,
    }),
    true,
  );
  assert.equal(
    await verifySlackSignature({
      signingSecret: "other-secret",
      timestamp,
      signature: good,
      body,
      nowMs: 1700000000 * 1000,
    }),
    false,
  );
  assert.equal(
    await verifySlackSignature({
      signingSecret: secret,
      timestamp,
      signature: good,
      body,
      nowMs: 1700000000 * 1000 + 6 * 60 * 1000,
    }),
    false,
  );
});

test("url verification returns the challenge", async () => {
  const body = JSON.stringify({ type: "url_verification", challenge: "sample-challenge" });
  const timestamp = "1700000000";
  const request = new Request("https://team-brain.example/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": await signature(timestamp, body),
    },
    body,
  });
  const response = await handleSlackRequest(request, {
    signingSecret: secret,
    store: createSqlNoteStore(createMemorySql()),
    repoUrl,
    postMessage: async () => {
      throw new Error("should not post");
    },
    nowMs: 1700000000 * 1000,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { challenge: "sample-challenge" });
});

test("a mention is answered in thread and a retry does not answer twice", async () => {
  const store = await storeWithSamples();
  const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const payload = {
    type: "event_callback",
    event_id: "EvSAMPLE1",
    event: {
      type: "app_mention",
      text: "<@UBOTSAMPLE> 팀 이름이 확정됐나요?",
      channel: "CSAMPLECHANNEL",
      ts: "1700000100.000100",
    },
  };
  const deps = {
    signingSecret: secret,
    store,
    repoUrl,
    postMessage: async (message: { channel: string; text: string; threadTs?: string }) => {
      posts.push(message);
    },
    nowIso: "2026-04-16T00:00:00.000Z",
  };
  await processSlackEvent(payload, deps);
  await processSlackEvent(payload, deps);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, "CSAMPLECHANNEL");
  assert.equal(posts[0].threadTs, "1700000100.000100");
  assert.match(posts[0].text, /북극성/);
  assert.match(posts[0].text, /reviewed/);
});

test("invalid signatures are rejected before the body is trusted", async () => {
  const request = new Request("https://team-brain.example/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": "1700000000",
      "x-slack-signature": "v0=deadbeef",
    },
    body: JSON.stringify({ type: "url_verification", challenge: "nope" }),
  });
  const response = await handleSlackRequest(request, {
    signingSecret: secret,
    store: createSqlNoteStore(createMemorySql()),
    repoUrl,
    postMessage: async () => undefined,
    nowMs: 1700000000 * 1000,
  });
  assert.equal(response.status, 401);
});
