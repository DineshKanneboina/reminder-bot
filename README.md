# reminder-bot

A recurring task reminder that nags you until you acknowledge it, over Telegram,
email, or SMS. Runs on Cloudflare Workers + D1 on the free tier.

You talk to it in plain English. It nags on an escalating ladder, respects quiet
hours, and stops the moment you say done.

```
you  → gym every mon/wed/fri at 6:30am
bot  → ✅ gym — Mon/Wed/Fri at 06:30

     …Monday 06:30…
bot  → ⏰ gym
       due 06:30                        [✅ Done] [⏳ 1h] [🚫 Skip]

     …no reply, 06:40…
bot  → ⏰ gym
       due 06:30 · 2nd nudge            [✅ Done] [⏳ 1h] [🚫 Skip]

you  → [taps Done]
bot  → ✅ Done — gym
```

## How it works

Two loops over one table. A Cron Trigger fires every 60 seconds and runs four
idempotent phases:

| Phase | What it does |
|---|---|
| A — materialize | Expand each task's RRULE 48h ahead into `reminder_instances`. `UNIQUE(task_id, scheduled_for)` makes re-runs a no-op. |
| B — catch up | If the Worker was down 2h+, send one digest instead of firing every missed nag, and close them out. |
| C — expire / supersede | Retire chains past `give_up_at`; collapse older live chains for `overlap='supersede'` tasks. |
| D — claim and send | Atomically claim due instances with a 2-minute lease, send, then write the real backoff. |

Inbound messages hit a webhook, get deduped, and are parsed by buttons → keywords
→ model, in that order. Only genuinely novel text reaches the model.

**`next_nag_at` is the whole state machine.** It's the only column the scheduler
queries, and every terminal transition nulls it. If it's NULL, the chain is over.

## Setup

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
npm run db:seed    # the three default escalation policies
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

## Commands

| You say | It does |
|---|---|
| `gym every mon/wed/fri at 6:30am` | creates a reminder |
| `review finances last friday of the month at 5pm` | monthly with an ordinal weekday |
| `done` · `done 2` | acknowledge (bare `done` asks which, if several are open) |
| `snooze 30m` · `snooze 2 1h` | push it out, reset escalation |
| `skip` | close it out without doing it |
| `list` | what's open right now |
| `tasks` | all your reminders |
| `pause 2h` · `resume` | mute without losing anything |
| `set timezone to Asia/Tokyo` | reminders follow you |
| `delete gym` | asks for confirmation first |

## Escalation policies

Three are seeded. Everything points at `default` unless you change `policy_id`.

| name | ladder (minutes) | channels | gives up | quiet hours |
|---|---|---|---|---|
| `gentle` | 30, 120 | primary | 4h | 22:00–07:00 |
| `default` | 10, 20, 40, 60 | primary ×3, then email | 3h | 22:00–07:00 |
| `urgent` | 5, 5, 10, 15, 30 | primary ×2, email, sms ×2 | 2h | none |

Two knobs worth understanding:

**`overlap`** — when tomorrow's occurrence comes due and today's is still
unacknowledged, `supersede` (the default) retires the old one and `stack` keeps
both. Daily habits want `supersede`; three ignored days otherwise produce an
avalanche and you stop reading the channel. Reserve `stack` for things that
genuinely accumulate, like expense reports.

**`max_concurrent`** — over the cap, nags are consolidated into one message
rather than dropped. You still hear about everything; it just arrives as a list.

## Development

```bash
npm test          # 45 tests: date logic, tick lifecycle, inbound webhooks
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

## Known gaps

- The weekly review digest (completion rates, "you've snoozed this four weeks
  running") isn't built. Deliberately — run the base loop for a few weeks first
  so the suggestions have real data behind them.
- Editing escalation policies has no command; change them with SQL.
- Inbound email isn't handled, only outbound plus signed ack links.
