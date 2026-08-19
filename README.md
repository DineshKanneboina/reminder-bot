# reminder-bot

A task reminder that nags you until you acknowledge it, over Telegram, email, or
SMS. Runs on Cloudflare Workers + D1 on the free tier.

You talk to it in plain English. Most things stay quiet — they land on a pinned
board for the day and only start nagging if you leave them there. Anything you
mark urgent nags straight away, on an escalating ladder, until you answer.

```
you  → book the Thailand flight tomorrow at 9pm
bot  → ✅ book Thailand flight — once, Thu 20 Aug at 9:00 pm

you  → gym every mon/wed/fri at 6:30am
bot  → ✅ gym — Mon/Wed/Fri at 6:30 am

     …Thursday 9:00 pm — the board updates, nothing pings…

     …9:00 pm + 4h, still not done…
bot  → ⏰ book Thailand flight
       due 9:00 pm                      [✅ Done] [⏳ 1h] [🚫 Skip]

you  → [taps Done]
bot  → ✅ Done — book Thailand flight
```

---

# Using it

## Creating reminders

One rule decides everything: **if you use a repeating word, it repeats. If you
don't, it happens once.**

**One-offs** — no "every", no "daily":

```
book the Thailand flight tomorrow at 9pm
doctor's appointment on sept 3 at 2pm
call the bank friday morning
register for class monday at 10am
```

**Recurring** — the repeating word is what does it:

| You say | You get |
|---|---|
| `vitamins daily at 8am` | every day |
| `gym every mon/wed/fri at 6:30am` | those three weekdays |
| `take out trash every tuesday 8pm` | weekly |
| `weigh in every other monday at 7am` | fortnightly |
| `rent on the 1st of the month at 9am` | monthly by date |
| `review finances last friday of the month at 5pm` | monthly by position |
| `renew passport every year on march 2nd` | yearly |

It always confirms which one it made — `once, Thu 3 Sep at 2:00 pm` versus
`daily at 6:30 am`. Read that line: turning your words into a schedule is the
one step that goes through a language model, and everything after it is fixed
logic. If it guessed wrong, say `make book flight a one-off` or
`change gym to every tuesday`.

**Times.** A clock time is used as-is. Vague words map to fixed hours: morning
`9am`, noon, afternoon `3pm`, evening `6pm`, night/tonight `9pm`. Say nothing
and you get `9am`.

**Not supported:** anything sub-daily — "every 3 hours", "twice a day". You'll
get told it couldn't be turned into a schedule rather than a wrong reminder.

## The daily board

One pinned message per day, edited in place as things change. A fresh one is
posted each morning from 07:00 and yesterday's is unpinned and left in the chat
as a record of that day.

```
📋 Wednesday, 19 Aug

Due
1. plan out Thailand with santosh · yesterday 6:00 pm · 11×
2. get mom's Costco card in apple wallet · 8:00 am

Later today
• update resume · 9:00 am
• book Thailand flight · 5:00 pm

Missed
⌛ Build shelf · was 9:00 am

Done
✅ check open positions in JP portal
```

**Due** is open right now — carried-over items say which day they came from, so
last night's 6pm can't be mistaken for tonight's. **Later today** hasn't come
due yet. **Missed** ran out of road: nagged to its give-up time and never
answered. **Done** is closed out.

The numbers are real — `done 1` works, and so do the buttons underneath.

## Answering

| You say | It does |
|---|---|
| `done` · `done 2` | acknowledge, and get what's left of today back |
| `snooze 30m` · `snooze 2 1h` | push it out, reset escalation, extend the give-up window |
| `skip` | close it out without doing it |

Buttons do the same thing and are unambiguous — they carry the exact reminder,
so there's nothing to resolve.

## How loudly

Recurring tasks are quiet by default: they appear on the board and say nothing
for four hours, then nag on their ladder. A one-off is different — you named a
time, so it pushes at that time and then nags normally if you ignore it.

Change any of it per task:

```
make gym urgent      → nags the moment it's due, and keeps at it
make trash gentle    → a nudge every so often
make dishes notify   → one message, never again
make gym quiet       → back to board-first
```

## Better nudges

A reminder with a note attached gets a one-line "first step" suggestion on each
nag, generated at send time. Notes are optional and never asked for twice:

```
you  → note for shelf: the wood is already cut
bot  → 📝 Noted on Build shelf. I'll use it when I nudge you.

     …later…
bot  → ⏰ Build shelf
       due 9:00 am · 2nd nudge
       💡 Measure the first bracket.
```

Right after creating something, a bare `note: ...` attaches to it. The hint runs
on Workers AI behind a hard timeout — if it's slow, broken or out of quota the
nag goes out on time without one, which is the normal case rather than an error.

## Everything else

| You say | It does |
|---|---|
| `list` | what's open right now |
| `tasks` | all your reminders, with spent one-offs separated out |
| `pause 2h` · `resume` | mute without losing anything |
| `set timezone to Asia/Tokyo` | existing reminders follow you |
| `delete gym` | asks for confirmation first |
| `note for gym: ...` | context that makes the nudges better |
| `help` | the above, in the chat |

A one-off that has already happened isn't deleted automatically — it moves to
**Already happened** in `tasks` with the phrase that clears it.

---

# How it works

Two loops over one database. A Cron Trigger fires every 60 seconds and runs five
idempotent phases:

| Phase | What it does |
|---|---|
| A — materialize | Expand each task's RRULE 48h ahead into `reminder_instances`. `UNIQUE(task_id, scheduled_for)` makes re-runs a no-op. |
| B — catch up | If the Worker was down 2h+, send one digest instead of firing every missed nag, and close them out. |
| C — expire / supersede | Retire chains past `give_up_at`; collapse older live chains for `overlap='supersede'` tasks. |
| D — route and send | Claim due instances with a 2-minute lease. Quiet items are parked for the board; the rest are sent, then the real backoff is written. |
| E — board | Reconcile the pinned message. Never throws into the tick — a broken view must not cost a nag. |

Inbound messages hit a webhook, get deduped, and are parsed by buttons →
keywords → model, in that order. Only genuinely novel text reaches the model.

**`next_nag_at` is the whole state machine.** It's the only column the scheduler
queries, and every terminal transition nulls it. If it's NULL, the chain is over.

**Parking gives back what the claim took.** A quiet item waiting on the board
has its attempt and escalation step handed back, so when it finally speaks it
arrives with a full ladder rather than halfway up one.

## Escalation policies

Four are seeded. `tier` decides routing; the ladder decides what happens once
routing says push.

| name | tier | ladder (minutes) | channels | gives up | quiet hours |
|---|---|---|---|---|---|
| `gentle` | quiet | 30, 120 | primary | 4h | 22:00–07:00 |
| `default` | quiet | 10, 20, 40, 60 | primary ×3, then email | 3h | 22:00–07:00 |
| `notify` | notify | — | primary | 3h | 22:00–07:00 |
| `urgent` | urgent | 5, 5, 10, 15, 30 | primary ×2, email, sms ×2 | 2h | none |

Two more knobs:

**`overlap`** — when tomorrow's occurrence comes due and today's is still
unacknowledged, `supersede` (the default) retires the old one and `stack` keeps
both. Daily habits want `supersede`; three ignored days otherwise produce an
avalanche and you stop reading the channel. Reserve `stack` for things that
genuinely accumulate, like expense reports.

**`max_concurrent`** — over the cap, nags are consolidated into one message
rather than dropped. You still hear about everything; it just arrives as a list.

## Tuning

Set in `wrangler.jsonc` under `vars`:

| Variable | Default | Meaning |
|---|---|---|
| `HINTS_ENABLED` | on | set to `0` to stop generating first-step hints |
| `HINT_MODEL` | `@cf/meta/llama-3.2-3b-instruct` | Workers AI model for hints — check `npx wrangler ai models` |
| `HINT_BUDGET_PER_TICK` | `3` | most hints one tick will generate |
| `QUIET_AGING_HOURS` | `4` | how long a quiet item sits on the board before it nags |
| `BOARD_HOUR` | `07:00` | when an otherwise-empty board is posted |
| `BOARD_ENABLED` | on | set to `0` to turn the board off entirely |
| `MATERIALIZE_HORIZON_HOURS` | `48` | how far ahead occurrences are created |
| `STALE_FLOOR_HOURS` | `2` | downtime past this produces a digest, not a flood |

---

# Setup

You need a Cloudflare account (free) and a Telegram bot. Everything else is
optional.

### 1. Create the bot

Message [@BotFather](https://t.me/botfather) on Telegram, send `/newbot`, and
keep the token it gives you.

### 2. Create the database

```bash
npm install
npx wrangler d1 create reminder-bot
```

Copy the `database_id` it prints into `wrangler.jsonc`, then:

```bash
npm run db:init    # schema
npm run db:seed    # the four default escalation policies
```

### 3. Set secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN       # from BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # any long random string
npx wrangler secret put ACK_SIGNING_KEY          # any long random string
npx wrangler secret put BOOTSTRAP_TOKEN          # a phrase you'll text once
npx wrangler secret put ANTHROPIC_API_KEY        # for natural-language parsing
```

Generate the random ones with `openssl rand -hex 32`.

### 4. Deploy and register the webhook

```bash
npm run deploy
```

Put the deployed URL into `PUBLIC_URL` in `wrangler.jsonc`, redeploy, then point
Telegram at it:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://reminder-bot.<subdomain>.workers.dev/webhook/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

### 5. Claim your account

Message your bot with the exact `BOOTSTRAP_TOKEN` phrase. It creates your user,
binds your chat as the primary channel, and then **stops working** — the token
only functions while the users table is empty, so a leak can't add a second
account later.

Then set your timezone:

```
set timezone to America/Chicago
```

## Schema changes on an existing database

`schema.sql` is `IF NOT EXISTS` throughout, so it only covers fresh databases.
An existing one needs the DDL applied by hand **before** deploying the code that
depends on it:

```bash
npx wrangler d1 execute reminder-bot --remote --command "<DDL>"
```

## Optional extras

**Email escalation.** The `default` policy falls through to email on the fourth
nudge. Set `RESEND_API_KEY` and `EMAIL_FROM`, then add a channel row:

```bash
npx wrangler d1 execute reminder-bot --remote --command \
  "INSERT INTO channels VALUES ('ch_email','<your-user-id>','email','you@example.com',1,1);"
```

Escalation emails carry HMAC-signed one-tap Done / Snooze / Skip links, so you
can close things out without switching back to Telegram.

**SMS.** Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` and point
Twilio's inbound webhook at `/webhook/twilio`. Note that US A2P traffic requires
10DLC registration before carriers will deliver reliably — this is the reason
Telegram is the default rather than SMS.

**Dead man's switch.** Set `HEARTBEAT_URL` to a Healthchecks.io or Better Stack
ping URL. Every successful tick pings it, and you get alerted when the ticks
stop. Worth doing: once you trust this thing, silence is indistinguishable from
"nothing due."

---

# Development

```bash
npm test          # 93 tests: date logic, tick lifecycle, board, one-offs, hints, webhooks
npm run typecheck
npm run dev       # local worker + local D1
```

Tests run against an in-memory SQLite shim (`test/d1-shim.mjs`) rather than
workerd, so the whole suite runs in about a second and the tick can be driven
with simulated time.

### Invariants the tests hold

- A terminal state always has `next_nag_at IS NULL`.
- A reminder at 08:00 local fires at 08:00 local on both sides of a DST boundary.
- A reminder inside the spring-forward gap fires exactly once.
- Replaying a provider message id changes nothing.
- A channel returning an HTML error page fails that send and no others.
- Six hours of downtime produces one digest, not forty nags.
- An explicit snooze extends `give_up_at` rather than being silently killed by it.
- A quiet item waiting on the board keeps its full ladder, and its give-up window
  is stretched past the wait rather than consumed by it.
- Every rung of a policy's ladder is used, in the order it is written.
- The board is a view: a failed post or edit never costs a nag or fails the tick.
- A dated one-off lands on its date, and one whose date has passed is refused
  rather than stored where it can never fire.

## Known gaps

- The weekly review digest (completion rates, "you've snoozed this four weeks
  running") isn't built. Deliberately — run the base loop for a few weeks first
  so the suggestions have real data behind them.
- Editing escalation policies has no command; change them with SQL. Assigning
  one to a task does have a command (`make gym urgent`).
- Inbound email isn't handled, only outbound plus signed ack links.
- A spent one-off is never retired automatically; it sits under "Already
  happened" until you delete it.
