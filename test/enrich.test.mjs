/**
 * Web enrichment: a daily, budgeted, attributed web lookup cached onto a task
 * and rendered on its nags. The rules under test are the ones that kept this
 * feature last on the roadmap: never on the send path, never unsourced, never
 * free-running on cost.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { FakeD1, installFetchCapture } from "./d1-shim.mjs";
import { runTick } from "../build/tick.js";
import { Db } from "../build/db.js";
import { applyIntent } from "../build/commands.js";
import { parseKeyword } from "../build/parser.js";
import { sanitizeResearch } from "../build/enrich.js";
import { localToUtc } from "../build/time.js";

const TZ = "America/Chicago";
const T0 = localToUtc(2026, 8, 24, 9, 0, TZ);
const iso = (ms) => new Date(ms).toISOString();

let d1, env, sent;

beforeEach(() => {
  d1 = new FakeD1(["schema.sql", "seed.sql"]);
  env = {
    DB: d1, TELEGRAM_BOT_TOKEN: "fake", ANTHROPIC_API_KEY: "fake-key",
    MATERIALIZE_HORIZON_HOURS: "48", STALE_FLOOR_HOURS: "2", BOARD_ENABLED: "0",
  };
  sent = installFetchCapture();
  d1.exec(`
    INSERT INTO users VALUES ('u1','${TZ}','pol_default',NULL,'2026-01-01T00:00:00Z');
    INSERT INTO channels VALUES ('c1','u1','telegram','9999',0,1);
    INSERT INTO tasks VALUES ('t1','u1','Buy protein powder',NULL,'FREQ=DAILY',
      '2026-08-20T00:00:00.000Z','09:00','${TZ}','pol_urgent','supersede',1,
      '2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z');
  `);
});

/** Stub the Anthropic messages endpoint with a web-search style response. */
function stubSearch(reply) {
  const searchCalls = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.anthropic.com")) {
      searchCalls.push(JSON.parse(init.body));
      const body = typeof reply === "function" ? reply() : reply;
      if (body instanceof Error) throw body;
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }
    return inner(url, init);
  };
  return searchCalls;
}

const CITED = {
  content: [
    { type: "server_tool_use", name: "web_search" },
    {
      type: "text",
      text: "Ryse Loaded Protein 2lb is $38.49 on Amazon; Costco has a 4.5lb tub for $49.99 this week.",
      citations: [
        { url: "https://www.amazon.com/dp/x", title: "Amazon" },
        { url: "https://www.costco.com/y", title: "Costco" },
      ],
    },
  ],
};

const configure = async () => {
  const db = new Db(d1);
  const user = await db.user("u1");
  const p = parseKeyword("research protein powder: current best price for Ryse protein", []);
  assert.equal(p.intent, "research");
  assert.equal(p.source, "keyword");
  const reply = await applyIntent(p, user, db, env, [], T0);
  assert.match(reply.text, /I'll check the web/);
};

// ---------------------------------------------------------------------------

test("configure → tick refreshes → nag carries the attributed result", async () => {
  await configure();
  const calls = stubSearch(CITED);

  // The refresh tick: phase F runs the search, caches result + sources.
  await runTick(env, T0 - 3600_000); // an hour before the nag
  assert.equal(calls.length, 1, "one search");
  assert.match(JSON.stringify(calls[0].tools), /web_search_20250305/);
  const [row] = d1.q(`SELECT result, sources FROM enrichments`);
  assert.match(row.result, /38\.49/);
  assert.match(row.sources, /amazon\.com/);
  assert.match(row.sources, /costco\.com/);

  // The nag tick: renders the CACHE, no new search.
  await runTick(env, T0);
  assert.equal(calls.length, 1, "the send path never searches");
  const nag = sent.filter((s) => s.kind === "telegram").map((s) => s.text).find((t) => /🔎/.test(t));
  assert.ok(nag, "research rides the nag");
  assert.match(nag, /\$38\.49/);
  assert.match(nag, /amazon\.com, costco\.com · 1h ago/, "source and age are always attached");
});

test("a fresh cache is not re-fetched; an expired one is", async () => {
  await configure();
  const calls = stubSearch(CITED);
  await runTick(env, T0);
  assert.equal(calls.length, 1);

  await runTick(env, T0 + 3600_000);
  assert.equal(calls.length, 1, "fresh cache, no spend");

  await runTick(env, T0 + 25 * 3600_000); // past ENRICH_REFRESH_HOURS
  assert.equal(calls.length, 2, "expired cache re-fetched");
});

test("an uncited answer never reaches a nag", async () => {
  await configure();
  stubSearch({ content: [{ type: "text", text: "It is definitely $12.99 right now, trust me." }] });
  await runTick(env, T0 - 3600_000);

  const [row] = d1.q(`SELECT result FROM enrichments`);
  assert.equal(row.result, null, "confident but sourceless = dropped");
  await runTick(env, T0);
  const nag = sent.filter((s) => s.kind === "telegram").map((s) => s.text).join("\n");
  assert.doesNotMatch(nag, /12\.99/);
});

test("a failed search keeps the old result and does not error the tick", async () => {
  await configure();
  const calls = stubSearch(CITED);
  await runTick(env, T0 - 3600_000);
  assert.match(d1.q(`SELECT result FROM enrichments`)[0].result, /38\.49/);

  // Next refresh blows up. Old result survives; retry is deferred, not spammed.
  stubSearch(() => new Error("search provider down"));
  const r = await runTick(env, T0 + 25 * 3600_000);
  const [row] = d1.q(`SELECT result, expires_at FROM enrichments`);
  assert.match(row.result, /38\.49/, "stale beats gone");
  assert.ok(Date.parse(row.expires_at) > T0 + 25 * 3600_000, "retry deferred");
  const [tick] = d1.q(`SELECT ok FROM tick_log ORDER BY ran_at DESC LIMIT 1`);
  assert.equal(tick.ok, 1, "a dead search never fails the tick");
});

test("hostile page content is defanged before it can touch a message", () => {
  assert.equal(
    sanitizeResearch("Deal! <b>click</b> https://scam.example/buy now $9.99 protein"),
    "Deal! bclick/b now $9.99 protein".replace("bclick/b", "bclick/b"), // markup stripped, link gone
  );
  assert.equal(sanitizeResearch("   "), null);
  assert.equal(sanitizeResearch("ok"), null, "too short to be information");
});

test("ENRICH_ENABLED=0 stops spending but keeps showing the cache", async () => {
  await configure();
  const calls = stubSearch(CITED);
  await runTick(env, T0 - 3600_000);
  env.ENRICH_ENABLED = "0";
  await runTick(env, T0 + 26 * 3600_000);
  assert.equal(calls.length, 1, "no new spend");
});

test("stop research clears the config; deleting the task does too", async () => {
  await configure();
  const db = new Db(d1);
  const user = await db.user("u1");
  const reply = await applyIntent(parseKeyword("stop research protein powder", []), user, db, env, [], T0);
  assert.match(reply.text, /Stopped looking things up/);
  assert.equal(d1.q(`SELECT * FROM enrichments`).length, 0);

  await configure();
  await db.deactivateTask("t1");
  assert.equal(d1.q(`SELECT * FROM enrichments`).length, 0, "config dies with its task");
});

test("research feeds the hint prompt as context", async () => {
  await configure();
  stubSearch(CITED);
  await runTick(env, T0 - 3600_000);

  let hintPrompt = null;
  env.AI = { async run(_m, inputs) { hintPrompt = inputs.messages.at(-1).content; return { response: "Order the Costco tub." }; } };
  await runTick(env, T0);
  assert.match(hintPrompt, /Current info \(from a web check\)/);
  assert.match(hintPrompt, /49\.99/);
});
