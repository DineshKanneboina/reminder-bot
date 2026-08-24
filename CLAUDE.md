# CLAUDE.md — reminder-bot ("Badger")

Personal nagging reminder bot. Telegram bot (@b4dger_bot) on Cloudflare Workers + D1, free tier. Owner: Dinesh (single-user system, timezone America/Chicago). Deployed at https://reminder-bot.dineshkan.workers.dev, cron tick every 60s.

## Commands

- `npm test` — 116 tests, in-memory SQLite shim (test/d1-shim.mjs), no workerd. Run after every change. A pretest hook compiles src/ to build/ for tests.
- `npm run typecheck` — tsc, strict
- `npm run deploy` — gated: `predeploy` runs 8 checks first and a failure stops the deploy; `postdeploy` waits one tick and smoke-tests production afterwards
- `npm run check` — the predeploy checks without the network ones (fast, for mid-work)
- `npm run smoke` — the post-deploy checks without waiting for a tick
- `npm run e2e` — LIVE test against production: creates a [TEST] one-off AND a [TEST] daily, waits for the real cron, verifies both nags, both hints (last_hint), and that the daily's ladder scheduled its next nag; cleans up. `-- --interactive` additionally proves ✅ Done retires the one-off and 🗑 Today closes the day WITHOUT killing the series. Sends two real Telegram messages. Test fixtures must not bait the restatement filter — a title like 'tap nothing' makes the model's obedient answer a droppable restatement.
- Schema changes additionally need: `npx wrangler d1 execute reminder-bot --remote --command "<DDL>"` applied BEFORE deploy. schema.sql is IF NOT EXISTS throughout.

## Architecture (src/)

Two loops over one D1 database:

- `tick.ts` — cron tick, five idempotent phases: (A) materialize occurrences 48h ahead from RRULEs, (B) catch-up digest if the worker was down 2h+, (C) expire / supersede stale chains, (D) claim due instances with a 2-minute lease, route, send, write backoff, (E) reconcile the pinned daily board. Cron does NOT retry failed runs; the DB-driven design self-heals on the next tick.
- `hint.ts` — nag-time "first step" hints. Prompt = title + notes + attempt_count + the user's standing `preferences`. via Workers AI (`env.AI`). Bounded by a hard timeout and a per-tick budget; returns null on absolutely anything going wrong, and null means the nag sends exactly as it did before Phase 2. Never throws.
- `board.ts` — the daily board and the quiet half of routing. Renders due / later today / missed / done, posts one pinned message per local day, edits it in place, unpins yesterday's. Never throws into the tick.
- `index.ts` — webhook entry. Inbound: sender allowlist → dedupe on provider message id → parse (button → keyword → LLM) → applyIntent → reply → save dialog state.
- `parser.ts` — fast keyword/regex paths first (done/snooze/list/questions — these must never cost an API call); Claude Haiku via env.ANTHROPIC_API_KEY only for novel text. Single JSON response schema, strictly normalized.
- `commands.ts` — intent → DB mutation → reply string. Destructive or low-confidence intents go through a two-turn y-confirmation (pending_actions).
- `db.ts` — all SQL. `?N` placeholders are fine (D1 supports them; the test shim rewrites them).
- `channels.ts` — Channel interface; Telegram (buttons), email (signed ack links via ack.ts), Twilio SMS stub. Adapters are non-throwing: one dead channel must never abort the tick.
- `time.ts` / `rrule.ts` — IANA-timezone wall-clock math and a small RFC 5545 expander (DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYDAY ordinals, BYMONTHDAY, COUNT, UNTIL). COUNT=1 encodes one-off reminders.

## Invariants the tests pin (do not break)

- A NAMED target that matches nothing live resolves to NOTHING. The single-live fallback is only for messages that named nothing — "Done with OMSCS" must never complete whatever else happens to be open.
- Done on a one-off retires the TASK, every source. There is no tomorrow to keep it for.
- A recurring nag has NO done button: [⏳ 1h] [🗑 Today] [❌ Forever] (owner's decision, 24 Aug). One-offs get [✅ Done] [⏳ 1h]. ❌ goes through intent delete with the instance id; the tap is the confirmation.
- Typed destructive commands older than 10 minutes (msg.receivedAt) are refused with the current open list. Buttons are exempt: exact ids, state-guarded.
- catchUp closes stale items in ONE statement BEFORE sending the digest. Send-then-close repeated the digest every revival when a tick died mid-loop.
- Every tick writes a tick_log row — especially the ones that die. `npm run e2e` and the smoke check read it.
- toLocalParts is memoized per (tz, minute). Uncached, an idle tick cost 22-27ms CPU against the free plan's 10ms and busy ticks were killed mid-flight — that was the weekend outage. Do not add per-tick Intl work outside it.
- The board syncs on activity or every 5th minute, not every tick (CPU). The inbound path syncs directly and is unaffected.
- A claimed-but-unhandled inbound message may be reprocessed by a provider retry after 2 minutes. Handled messages never are.
- Terminal instance states always have next_nag_at NULL — that column IS the state machine; the scheduler queries nothing else.
- Claiming uses a 2-minute lease, never NULL, so a crashed send self-retries.
- The ladder is indexed by `escalation_step - 1`, because the claim already incremented it. Both ladders — timing and channel — must index the same way, or a policy disagrees with itself about which nag it is on.
- Every rung of ladder_minutes is used, in order. A declared [10,20,40,60] nags five times with those exact gaps.
- 08:00 local stays 08:00 local across both DST transitions; spring-forward gap times fire exactly once.
- Supersede runs at fire time, not materialization time (materializing tomorrow must never retire today before it nags).
- liveForUser filters scheduled_for <= now — numbered replies must never reach future occurrences.
- Replayed provider message ids are no-ops.
- Downtime produces one digest, not a nag flood.
- Snooze extends give_up_at.
- A send is never *held* by an LLM call. Hints run on the send path by design, but behind a hard timeout (HINT_TIMEOUT_MS, default 3000) and a per-tick budget, and any failure sends hintless. The inbound parser is still never on the send path at all.
- `TickReport.hinted` exists so a broken model is diagnosable: `sent` above zero with `hinted` stuck at zero is the signature, and hint failures log rather than vanish.
- Hint output is untrusted: dropped if it contains markup or a link, escaped again at render, capped in length. A missing hint is invisible; a mangled one is worse than none.
- Bare "done"/"yes" never guess: done with 2+ live chains asks which; yes only confirms when a pending_action actually exists, else falls to the LLM with dialog context.
- Routing is decided before anything is rendered or sent. A quiet item that hasn't aged out is parked, not sent.
- A one-off pushes at its due time whatever its tier. "Remind me at 10:27" names a moment the user chose; the quiet window is for standing habits, not for a time someone asked for.
- Parking gives back the attempt and escalation step the claim took: waiting on the board is not an attempt, and the first real nag arrives with a full ladder.
- Parking stretches give_up_at past the aging window. A 180-minute give-up must not expire an item before a 4-hour quiet wait lets it speak.
- The quiet wait is pushed past quiet hours, so a 21:00 item does not come alive at 01:00.
- expireOverdue does NOT filter on next_nag_at. A 'notify' item is already NULL there and would otherwise sit on the board forever.
- A policy change never supersedes live instances — they join their policy through the task and pick the new tier up on the next tick.
- The board is a view: a failed post or edit must never cost a nag, and never fails the tick.
- Retiring yesterday's board runs on EVERY sync, never only on the tick that creates today's. Coupled to creation it got one attempt, and one failed unpin stranded yesterday's board pinned all day.
- Pin and unpin failures are logged, not swallowed. Cosmetic does not mean invisible.
- One hint per chain, on the first nag only. Four nudges meant four chances to say something useless.
- Identical board content is not re-edited (fingerprint), or every tick would burn an API call Telegram rejects as unmodified.
- Closing something out re-reads liveForUser rather than filtering the `live` snapshot. That snapshot predates the change, so its numbering is one ahead of what the numbers in the very same reply must resolve to.
- Any list that can carry an item past midnight dates it (whenLabel). A bare clock time under today's heading reads as today.
- The board shows Missed (expired today) above Done. An item that ran out of road is the most useful thing left to report.
- COUNT=1 is described as "once", never by its FREQ. `FREQ=DAILY;COUNT=1` is a one-off and calling it "daily" states the opposite of what will happen.
- A dated one-off anchors dtstart to that local day. The RRULE carries no date, so dtstart IS the date — ignoring start_date fires the reminder today instead.
- Only a ONE-OFF is refused for landing in the past. A recurring rule asked for after today's slot starts at its next one — "daily at 9am" said at 9:05 means tomorrow, not never.
- A note sent in the same message as the reminder is kept. Create and update both read `task.notes`; the predeploy dead-field check cannot see a field consumed in one branch and dropped in another.
- A reminder that would first land in the past is refused, never stored. COUNT=1 gives it one chance, and a spent one is indistinguishable from a scheduled one in the tasks table.
- Converting a recurring task to a one-off re-anchors dtstart to now, or its months-old anchor would spend the single occurrence on save.
- Confirmation prompts never invent a time. An update with no stated time describes the task's real one.
- Spent one-offs are quarantined under "Already happened" in the tasks list. Nothing retires them (active stays 1), so listing them as live makes the whole list untrustworthy.

## Before shipping

Three layers, in order. Each exists because something got past the previous one.

1. **`npm run deploy` is gated** by `scripts/predeploy.mjs`. Every check maps to a bug that actually shipped: an AI model id that didn't exist, a parser field populated and never read, `Date.now()` in a handler against a stated invariant, `schema.sql` drifting ahead of remote D1, stale test counts in these docs. **A check that never fires is worthless — when adding one, verify it by reintroducing the bug.** All eight were verified that way.
2. **`/code-review` on the diff before pushing.** Mechanical checks can't see a ladder indexed two different ways in one function, or a confirmation prompt inventing a default time. Read the diff against the invariants above.
3. **`scripts/postdeploy.mjs` runs automatically after deploy.** Uploading is not working: it waits one cron tick, then checks the worker responds, nothing is overdue past its retry lease, the 48h horizon is still being materialized, and today's board is fresh. Hints are *not* verifiable from outside — every failure returns null by design — so it prints the `wrangler tail` command instead of pretending to check.

## Conventions

- All timestamps stored as ISO-8601 UTC strings; local time computed against IANA zones at use, never stored offsets.
- Clock is injected (`now` param) through commands/tick so tests drive simulated time. Never reach for Date.now() inside handlers — and pass `now` down into db calls that compare against it (pending_actions, dialog_state), or the two clocks silently disagree.
- Owner deploys via patch-and-deploy; keep changes test-covered — every bug fixed so far got a regression test replaying the real conversation that found it.
- Secrets via wrangler secret (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ACK_SIGNING_KEY, BOOTSTRAP_TOKEN, ANTHROPIC_API_KEY, HEARTBEAT_URL). Never print or commit them.

## Phase 1 — board + routing (SHIPPED)

Decisions the owner settled, and what they mean in code:

- **Fresh board message each morning**, chat becomes a daily log. Posted at the first tick past `BOARD_HOUR` (**production runs 00:00** — a plan for the day should be waiting when the day starts) or sooner if there is already something to show; yesterday's is unpinned and left in the chat. Keyed by local date in `boards`. (Option B web /board page still deferred.)
- **Quiet by default**: every tier except `urgent` is board-only until an item ages past `QUIET_AGING_HOURS`, then it nags on its normal ladder. **Production runs 0** (set in wrangler.jsonc): one day of real use showed a 9am task going silent until 1pm was worse than the noise the window avoided, and the board already covers "show me without spamming me". The mechanism stays — it still honours quiet hours at zero — so raising it is a one-line change. This applies to existing tasks — `pol_default` and `pol_gentle` are tier `quiet`. **One-offs are exempt** (settled 19 Aug, after a timed one-off sat silent for four hours): a chosen moment pushes on time, then ladders normally.
- **`notify` tier** = one push, empty ladder, no follow-ups (`pol_notify`).
- Speakable policies work on create and update, via a keyword regex ("make gym urgent") before the LLM ever sees it.
- `BOARD_ENABLED=0` is a kill switch. tick.test.mjs and inbound.test.mjs set it — they pin the escalation machine and a second message per tick would muddy every send count. Board behaviour lives in board.test.mjs.

Deployed schema changes (apply BEFORE deploy — schema.sql only covers fresh DBs):

```
npx wrangler d1 execute reminder-bot --remote --command "ALTER TABLE escalation_policies ADD COLUMN tier TEXT NOT NULL DEFAULT 'quiet'"
npx wrangler d1 execute reminder-bot --remote --command "CREATE TABLE IF NOT EXISTS boards (user_id TEXT NOT NULL, local_date TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, local_date))"
npm run db:seed   # re-seeds the four policies with their tiers
```

## Phase 2 — nag-time hints (SHIPPED)

- Workers AI via the `AI` binding, NOT the Anthropic key and nothing on the owner's Mac. Model overridable with `HINT_MODEL`; default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. **Verify any model id with `npx wrangler ai models` before shipping it** — ids differ per account, and a wrong one produces no hints and no visible error. The first default shipped did not exist.
- Hint prompt = title + notes + attempt_count. Single nags only — a batched message is already a list, and one suggestion for six reminders is worse than none.
- `HINTS_ENABLED=0` kills it; `HINT_BUDGET_PER_TICK` (default 3) bounds how many a single tick will generate.
- What/why capture is an invitation, never a requirement: create suggests `note: ...`, which attaches to the task created in the last hour. `note for <task>: ...` works any time. Both are keyword paths — capturing context must not itself cost a model call.
- Deploy needs no migration; `tasks.notes` already existed and was unused.

## Phase 3 — personalisation (ordered)

The goal: hints that know you without you spelling it out every time. Each step
is better with the previous one in place, which is what fixes the order.

1. **Preferences store — SHIPPED 19 Aug.** Standing facts ("I use Ryse protein",
   "I shop at Costco"), captured from plain messages and injected into every
   hint prompt. No external dependency, no new failure mode, immediate payoff.
   Everything below is more useful once the bot knows these.
2. **Feedback loop.** Record the hint that was shown, correlate with what
   happened next (done fast / snoozed / skipped / expired), feed the winners
   back as examples. This is the part that makes hints *improve* rather than
   just be better-informed. Deliberately second: it needs weeks of real data,
   and there is no point collecting it until hints are worth reacting to.
3. **Apple Shortcuts bridge.** A signed webhook the iPhone can POST to, so
   Shortcuts can push calendar events, location arrivals or Health data on
   triggers the owner chooses. The only genuine route from phone data into the
   bot — TikTok, Safari history and app usage have no API and are not coming.
   Each source is its own small integration, so it waits for a concrete want.
4. **Web enrichment.** A daily pass that looks up real-time facts (a sale on the
   protein brand from step 1) and caches them onto the task, so the nag renders
   something already fetched. Explicitly OFF the send path — a search
   round-trip does not fit in the 1200ms hint budget. Last because it needs a
   paid search key, and its failure mode is the bot confidently citing a deal
   that does not exist.

## Backlog (not yet scheduled)

- Rename list/tasks commands to clearer names (keep old words as aliases).
