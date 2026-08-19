#!/usr/bin/env node
/**
 * Deploy gate. npm runs this before `npm run deploy`; a non-zero exit stops
 * the deploy.
 *
 * Every check here exists because something actually shipped broken. They are
 * deliberately specific to this project rather than generic lint — the bugs
 * that reached production were things like a Workers AI model id that did not
 * exist, and a parser field that was populated and then never read.
 *
 *   node scripts/predeploy.mjs            full run
 *   SKIP_REMOTE=1 node scripts/predeploy.mjs   skip the checks that need network
 */

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const skipRemote = process.env.SKIP_REMOTE === "1";
const results = [];
let testCount = null;

const read = (p) => readFileSync(p, "utf8");
const srcFiles = () => readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const allSrc = () => srcFiles().map((f) => ({ file: f, body: read(join(SRC, f)) }));

/**
 * Comments discuss code without being it. Without this, commenting a line out
 * still reads as "consumed" — which is exactly how a dead field hides.
 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

/** Run a command, returning {ok, out}. Never throws. */
function run(cmd, args = []) {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** One remote D1 query, as rows. Throws if wrangler or the parse fails. */
function d1(sql) {
  const out = execSync(
    `npx wrangler d1 execute reminder-bot --remote --json --command ${JSON.stringify(sql)}`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const start = out.indexOf("[");
  if (start < 0) throw new Error("no JSON in wrangler output");
  return JSON.parse(out.slice(start))[0].results ?? [];
}

function check(name, why, fn) {
  process.stdout.write(`  ${name} … `);
  let failure;
  try {
    failure = fn();
  } catch (e) {
    failure = `check itself failed: ${String(e).split("\n")[0]}`;
  }
  results.push({ name, why, failure: failure ?? null });
  console.log(failure ? "FAIL" : "ok");
  if (failure) console.log(`      ${failure.replace(/\n/g, "\n      ")}`);
}

console.log("\npredeploy checks\n");

// ---------------------------------------------------------------- correctness

check("typecheck", "strict tsc is the cheapest bug filter there is", () => {
  const r = run("npx", ["tsc", "--noEmit"]);
  return r.ok ? null : r.out.trim().split("\n").slice(0, 6).join("\n");
});

check("tests", "the suite encodes every bug fixed so far; deploying past it discards that", () => {
  const r = run("npm", ["test"]);
  const m = /^# pass (\d+)/m.exec(r.out);
  if (m) testCount = Number(m[1]);
  if (r.ok) return null;
  const failing = r.out.split("\n").filter((l) => /^not ok/.test(l)).slice(0, 8);
  return failing.length ? failing.join("\n") : r.out.trim().split("\n").slice(-8).join("\n");
});

// ------------------------------------------------------------- dead config
// The start_date bug: the parser populated it for weeks and applyIntent never
// read it, so every dated one-off fired on the day it was asked for.

check("no unread parser fields", "a field that is parsed but never consumed is a silent feature gap", () => {
  const parser = read(join(SRC, "parser.ts"));
  const block = /task: \{([\s\S]*?)\n  \};/.exec(parser);
  if (!block) return "could not find the Parsed.task interface — update this check";
  const fields = [...block[1].matchAll(/^\s*([a-z_]+)\??:/gim)].map((m) => m[1]);
  const consumers = stripComments(["commands.ts"].map((f) => read(join(SRC, f))).join("\n"));
  const dead = fields.filter((f) => !consumers.includes(`task.${f}`));
  return dead.length ? `parsed but never read in commands.ts: ${dead.join(", ")}` : null;
});

check("no unread env vars", "declared-and-never-read config reads as a working feature", () => {
  const types = read(join(SRC, "types.ts"));
  const block = /export interface Env \{([\s\S]*?)\n\}/.exec(types);
  if (!block) return "could not find the Env interface — update this check";
  const keys = [...block[1].matchAll(/^\s*([A-Z][A-Z0-9_]*)\??:/gm)].map((m) => m[1]);
  const body = stripComments(allSrc().filter((f) => f.file !== "types.ts").map((f) => f.body).join("\n"));
  const dead = keys.filter((k) => !new RegExp(`env\\.${k}\\b`).test(body));
  return dead.length ? `declared in Env but never read: ${dead.join(", ")}` : null;
});

// ------------------------------------------------------------ injected clock
// CLAUDE.md: "Never reach for Date.now() inside handlers." Violated anyway, in
// the confirm path, which made a test pass or fail by time of day.

check("injected clock in handlers", "a handler reading the wall clock cannot be driven by tests", () => {
  // db.ts stamps record timestamps; index.ts is the real-time entry point.
  const policed = ["commands.ts", "tick.ts", "board.ts", "hint.ts", "render.ts", "parser.ts", "rrule.ts"];
  const bad = [];
  for (const file of policed) {
    read(join(SRC, file)).split("\n").forEach((line, i) => {
      if (!line.includes("Date.now()")) return;
      const t = line.trim();
      // Comments discuss the rule; they don't break it.
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      // `now = Date.now()` as a default parameter IS the injection seam.
      if (/\bnow\s*(:\s*number\s*)?=\s*Date\.now\(\)/.test(t)) return;
      bad.push(`${file}:${i + 1}  ${t}`);
    });
  }
  return bad.length ? bad.join("\n") : null;
});

// ------------------------------------------------------------------- docs

check("doc test counts", "a stale count is a small lie that makes the rest less trustworthy", () => {
  if (testCount === null) return "tests did not report a count";
  const wrong = [];
  for (const f of ["CLAUDE.md", "README.md"]) {
    for (const m of read(f).matchAll(/(\d+) tests/g)) {
      if (Number(m[1]) !== testCount) wrong.push(`${f} says ${m[1]}, actual ${testCount}`);
    }
  }
  return wrong.length ? wrong.join("\n") : null;
});

// ------------------------------------------------------------------ remote

if (skipRemote) {
  console.log("  (skipping remote checks: SKIP_REMOTE=1)");
} else {
  check("AI model exists", "a wrong model id produces no hints and no error — invisible", () => {
    const wrangler = read("wrangler.jsonc");
    if (!/"ai"\s*:/.test(wrangler)) return null; // no binding, nothing to check
    const hint = read(join(SRC, "hint.ts"));
    const dflt = /DEFAULT_MODEL = "([^"]+)"/.exec(hint)?.[1];
    const override = /"HINT_MODEL"\s*:\s*"([^"]+)"/.exec(wrangler)?.[1];
    const want = override ?? dflt;
    if (!want) return "could not determine the model id — update this check";
    const r = run("npx", ["wrangler", "ai", "models"]);
    if (!r.ok) return `could not list models: ${r.out.trim().split("\n")[0]}`;
    return new RegExp(`${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|\\|)`).test(r.out)
      ? null
      : `${want} is not available on this account (npx wrangler ai models)`;
  });

  check("schema matches remote D1", "schema.sql is IF NOT EXISTS, so it never migrates an existing database", () => {
    const schema = read("schema.sql");
    const wanted = new Map();
    for (const m of schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
      const cols = m[2]
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("--") && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(l))
        .map((l) => l.split(/\s+/)[0])
        .filter((c) => /^\w+$/.test(c));
      wanted.set(m[1], cols);
    }
    const live = new Set(d1("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
    const problems = [];
    for (const [table, cols] of wanted) {
      if (!live.has(table)) {
        problems.push(`table "${table}" missing on remote — apply its CREATE TABLE before deploying`);
        continue;
      }
      const have = new Set(d1(`PRAGMA table_info(${table})`).map((r) => r.name));
      const missing = cols.filter((c) => !have.has(c));
      if (missing.length) {
        problems.push(
          `${table} is missing ${missing.join(", ")} on remote — ` +
            `npx wrangler d1 execute reminder-bot --remote --command "ALTER TABLE ${table} ADD COLUMN ${missing[0]} ..."`,
        );
      }
    }
    return problems.length ? problems.join("\n") : null;
  });
}

// ------------------------------------------------------------------ verdict

const failed = results.filter((r) => r.failure);
console.log("");
if (failed.length === 0) {
  console.log(`all ${results.length} checks passed — deploying\n`);
  process.exit(0);
}
console.log(`${failed.length} of ${results.length} checks failed — deploy stopped\n`);
for (const f of failed) console.log(`  ${f.name}: ${f.why}`);
console.log("");
process.exit(1);
