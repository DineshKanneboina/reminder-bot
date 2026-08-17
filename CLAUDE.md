# CLAUDE.md — reminder-bot ("Badger")

Personal nagging reminder bot. Telegram bot (@b4dger_bot) on Cloudflare Workers + D1, free tier. Owner: Dinesh (single-user system, timezone America/Chicago). Deployed at https://reminder-bot.dineshkan.workers.dev, cron tick every 60s.

## Commands

- `npm test` — 56 tests, in-memory SQLite shim (test/d1-shim.mjs), no workerd. Run after every change. A pretest hook compiles src/ to build/ for tests.
- `npm run typecheck` — tsc, strict
- `npm run deploy` — wrangler deploy to production (owner runs this)
- Schema changes additionally need: `npx wrangler d1 execute reminder-bot --remote --command "<DDL>"` applied BEFORE deploy. schema.sql is IF NOT EXISTS throughout.

## Architecture (src/)

Two loops over one D1 database:

- `tick.ts` — cron tick, four idempotent phases: (A) materialize occurrences 48h ahead from RRULEs, (B) catch-up digest if the worker was down 2h+, (C) expire / supersede stale chains, (D) claim due instances with a 2-minute lease, send, write backoff. Cron does NOT retry failed runs; the DB-driven design self-heals on the next tick.
- `index.ts` — webhook entry. Inbound: sender allowlist → dedupe on provider message id → parse (button → keyword → LLM) → applyIntent → reply → save dialog state.
- `parser.ts` — fast keyword/regex paths first (done/snooze/list/questions — these must never cost an API call); Claude Haiku via env.ANTHROPIC_API_KEY only for novel text. Single JSON response schema, strictly normalized.
- `commands.ts` — intent → DB mutation → reply string. Destructive or low-confidence intents go through a two-turn y-confirmation (pending_actions).
- `db.ts` — all SQL. `?N` placeholders are fine (D1 supports them; the test shim rewrites them).
- `channels.ts` — Channel interface; Telegram (buttons), email (signed ack links via ack.ts), Twilio SMS stub. Adapters are non-throwing: one dead channel must never abort the tick.
- `time.ts` / `rrule.ts` — IANA-timezone wall-clock math and a small RFC 5545 expander (DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYDAY ordinals, BYMONTHDAY, COUNT, UNTIL). COUNT=1 encodes one-off reminders.

## Invariants the tests pin (do not break)

- Terminal instance states always have next_nag_at NULL — that column IS the state machine; the scheduler queries nothing else.
- Claiming uses a 2-minute lease, never NULL, so a crashed send self-retries.
- 08:00 local stays 08:00 local across both DST transitions; spring-forward gap times fire exactly once.
- Supersede runs at fire time, not materialization time (materializing tomorrow must never retire today before it nags).
- liveForUser filters scheduled_for <= now — numbered replies must never reach future occurrences.
- Replayed provider message ids are no-ops.
- Downtime produces one digest, not a nag flood.
- Snooze extends give_up_at.
- Sends never block on any LLM call.
- Bare "done"/"yes" never guess: done with 2+ live chains asks which; yes only confirms when a pending_action actually exists, else falls to the LLM with dialog context.

## Conventions

- All timestamps stored as ISO-8601 UTC strings; local time computed against IANA zones at use, never stored offsets.
- Clock is injected (`now` param) through commands/tick so tests drive simulated time. Never reach for Date.now() inside handlers.
- Owner deploys via patch-and-deploy; keep changes test-covered — every bug fixed so far got a regression test replaying the real conversation that found it.
- Secrets via wrangler secret (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ACK_SIGNING_KEY, BOOTSTRAP_TOKEN, ANTHROPIC_API_KEY, HEARTBEAT_URL). Never print or commit them.

## Agreed next build (design settled with the owner)

### Phase 1 — board + routing

- Option A board: one pinned Telegram message per day showing due/open/upcoming with buttons, edited in place via editMessageText as state changes. (Option B web /board page deliberately deferred.)
- OPEN QUESTION (ask owner first): fresh board message each morning (chat becomes a daily log) vs one eternal mutating message.
- Quiet-by-default routing: board items don't push individual nags unless policy is urgent or the item ages past a threshold; new `notify` policy tier = single message, empty ladder, no follow-ups.
- Parser: speakable policies ("remind me gently", "just notify me", "make X urgent") on create and update.

### Phase 2 — nag-time hints

- Per-nag one-liner "first step" suggestions generated at send time via Workers AI (env.AI binding, free tier — NOT the Anthropic key, and explicitly NOT a model on the owner's Mac; the send path must never depend on his laptop).
- Hard rules: short generation timeout, nag sends hintless on any failure, cap tokens, strip newlines, drop suspicious output silently.
- Optional what/why capture: after creating a naggable task, invite (never require) a short description into tasks.notes via dialog state; also "note for <task>: ..." anytime. Hint prompt = title + notes + attempt_count.

## Backlog (not yet scheduled)

- Rename list/tasks commands to clearer names (keep old words as aliases).
