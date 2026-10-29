import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { root } from "./samples.ts";

test("wrangler template has the cron, durable object, and workers ai binding", () => {
  const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8")) as {
    account_id?: string;
    ai?: { binding?: string };
    durable_objects?: { bindings?: Array<{ name: string; class_name: string }> };
    migrations?: Array<{ new_sqlite_classes?: string[] }>;
    triggers?: { crons?: string[] };
    vars?: Record<string, string>;
  };
  assert.equal(config.account_id, undefined);
  assert.equal(config.ai?.binding, "AI");
  assert.equal(config.durable_objects?.bindings?.[0]?.class_name, "TeamBrain");
  assert.deepEqual(config.migrations?.[0]?.new_sqlite_classes, ["TeamBrain"]);
  assert.deepEqual(config.triggers?.crons, ["*/10 * * * *"]);
  assert.equal(config.vars?.NOTES_REPO_URL, "https://github.com/beyejin/team-brain");
  assert.equal(JSON.stringify(config).includes("SLACK_BOT_TOKEN"), false);
});

test("env example documents placeholders and does not fill secrets", () => {
  const example = readFileSync(join(root, ".env.example"), "utf8");
  for (const name of [
    "SLACK_SIGNING_SECRET=",
    "SLACK_BOT_TOKEN=",
    "NOTION_TOKEN=",
    "NOTION_DATABASE_ID=",
    "GITHUB_TOKEN=",
  ]) {
    assert.equal(example.includes(name), true);
  }
  assert.doesNotMatch(example, /=xox|=ghp_|=github_pat_/);
});
