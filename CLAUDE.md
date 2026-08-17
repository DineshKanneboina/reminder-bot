# CLAUDE.md — reminder-bot ("Badger")

Personal nagging reminder bot. Telegram bot (@b4dger_bot) on Cloudflare Workers + D1, free tier. Owner: Dinesh (single-user system, timezone America/Chicago). Deployed at https://reminder-bot.dineshkan.workers.dev, cron tick every 60s.

## Commands

- `npm test` — 63 tests, in-memory SQLite shim (test/d1-shim.mjs), no workerd. Run after every change. A pretest hook compiles src/ to build/ for tests.
- `npm run typecheck` — tsc, strict
- `npm run deploy` — wrangler deploy to production (owner runs this)
- Schema changes additionally need: `npx wrangler d1 execute reminder-bot --remote --command "<DDL>"` applied BEFORE deploy. schema.sql is IF NOT EXISTS throughout.

## Architecture (src/)

Two loops over one D1 database:

- `tick.ts` — cron tick, five idempotent phases: (A) materialize occurrences 48h ahead from RRULEs, (B) catch-up digest if the worker was down 2h+, (C) expire / supersede stale chains, (D) claim due instances with a 2-minute lease, route, send, write backoff, (E) reconcile the pinned daily board. Cron does NOT retry failed runs; the DB-driven design self-heals on the next tick.
- `board.ts` — the daily board and the quiet half of routing. Renders due / later today / done, posts one pinned message per local day, edits it in place, unpins yesterday's. Never throws into the tick.
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
- Routing is decided before anything is rendered or sent. A quiet item that hasn't aged out is parked, not sent.
- Parking gives back the attempt and escalation step the claim took: waiting on the board is not an attempt, and the first real nag arrives with a full ladder.
- Parking stretches give_up_at past the aging window. A 180-minute give-up must not expire an item before a 4-hour quiet wait lets it speak.
- The quiet wait is pushed past quiet hours, so a 21:00 item does not come alive at 01:00.
- expireOverdue does NOT filter on next_nag_at. A 'notify' item is already NULL there and would otherwise sit on the board forever.
- A policy change never supersedes live instances — they join their policy through the task and pick the new tier up on the next tick.
- The board is a view: a failed post or edit must never cost a nag, and never fails the tick.
- Identical board content is not re-edited (fingerprint), or every tick would burn an API call Telegram rejects as unmodified.

## Conventions

- All timestamps stored as ISO-8601 UTC strings; local time computed against IANA zones at use, never stored offsets.
- Clock is injected (`now` param) through commands/tick so tests drive simulated time. Never reach for Date.now() inside handlers.
- Owner deploys via patch-and-deploy; keep changes test-covered — every bug fixed so far got a regression test replaying the real conversation that found it.
- Secrets via wrangler secret (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ACK_SIGNING_KEY, BOOTSTRAP_TOKEN, ANTHROPIC_API_KEY, HEARTBEAT_URL). Never print or commit them.

## Phase 1 — board + routing (SHIPPED)

Decisions the owner settled, and what they mean in code:

- **Fresh board message each morning**, chat becomes a daily log. Posted at the first tick past `BOARD_HOUR` (default 07:00 local) or sooner if there is already something to show; yesterday's is unpinned and left in the chat. Keyed by local date in `boards`. (Option B web /board page still deferred.)
- **Quiet by default**: every tier except `urgent` is board-only until an item ages past `QUIET_AGING_HOURS` (default **4**), then it nags on its normal ladder. This applies to existing tasks — `pol_default` and `pol_gentle` are tier `quiet`.
- **`notify` tier** = one push, empty ladder, no follow-ups (`pol_notify`).
- Speakable policies work on create and update, via a keyword regex ("make gym urgent") before the LLM ever sees it.
- `BOARD_ENABLED=0` is a kill switch. tick.test.mjs and inbound.test.mjs set it — they pin the escalation machine and a second message per tick would muddy every send count. Board behaviour lives in board.test.mjs.

Deployed schema changes (apply BEFORE deploy — schema.sql only covers fresh DBs):

```
npx wrangler d1 execute reminder-bot --remote --command "ALTER TABLE escalation_policies ADD COLUMN tier TEXT NOT NULL DEFAULT 'quiet'"
npx wrangler d1 execute reminder-bot --remote --command "CREATE TABLE IF NOT EXISTS boards (user_id TEXT NOT NULL, local_date TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, local_date))"
npm run db:seed   # re-seeds the four policies with their tiers
```

## Agreed next build (design settled with the owner)

### Phase 2 — nag-time hints

- Per-nag one-liner "first step" suggestions generated at send time via Workers AI (env.AI binding, free tier — NOT the Anthropic key, and explicitly NOT a model on the owner's Mac; the send path must never depend on his laptop).
- Hard rules: short generation timeout, nag sends hintless on any failure, cap tokens, strip newlines, drop suspicious output silently.
- Optional what/why capture: after creating a naggable task, invite (never require) a short description into tasks.notes via dialog state; also "note for <task>: ..." anytime. Hint prompt = title + notes + attempt_count.

## Backlog (not yet scheduled)

- Rename list/tasks commands to clearer names (keep old words as aliases).
