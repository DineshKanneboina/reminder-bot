import {
  answerCallbackQuery,
  buildChannels,
  parseTelegramUpdate,
  parseTwilioForm,
  resolveTarget,
} from "./channels";
import { ackPage, verifyAck } from "./ack";
import { syncBoard } from "./board";
import { applyIntent } from "./commands";
import { Db } from "./db";
import { parseButton, parseKeyword, parseWithLlm } from "./parser";
import { renderLiveList } from "./render";
import { runTick } from "./tick";
import { Env, InboundMessage } from "./types";

const DEFAULT_TZ = "America/Chicago";

export default {
  /** Cron Trigger. One minute cadence; see wrangler.jsonc. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runTick(env).then(
        (r) => console.log("tick", r),
        (e) => console.error("tick failed", e),
      ),
    );
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      // Any hit on /health doubles as a dead-man's switch for the scheduler.
      // On 25 Aug the platform's cron silently stopped for 80+ minutes (ticks
      // healthy, then simply no invocations — a known free-plan failure whose
      // official fix is "redeploy"). Ticks are idempotent and lease-guarded,
      // so reviving from an unauthenticated endpoint is safe: when cron is
      // healthy this never fires, and when it is dead, any external uptime
      // pinger becomes the backup scheduler.
      ctx.waitUntil(reviveIfStale(env));
      return Response.json({ ok: true, at: new Date().toISOString() });
    }

    // Manual tick, handy while developing. Guarded by the same secret as the
    // Telegram webhook so it isn't an open trigger.
    if (url.pathname === "/tick" && req.method === "POST") {
      if (!secretOk(req, env)) return new Response("forbidden", { status: 403 });
      return Response.json(await runTick(env));
    }

    // One-tap acknowledgment from an escalation email.
    if (url.pathname === "/ack") {
      const token = url.searchParams.get("t");
      if (!token || !env.ACK_SIGNING_KEY) return ackPage("That link isn't valid.", false);
      const claim = await verifyAck(env.ACK_SIGNING_KEY, token);
      if (!claim) return ackPage("That link has expired or been tampered with.", false);

      const db = Db.from(env);
      const inst = await db.instance(claim.instanceId);
      if (!inst) return ackPage("I can't find that reminder.", false);

      if (claim.action === "snooze") {
        const ok = await db.snooze(claim.instanceId, Date.now() + 60 * 60_000);
        return ackPage(ok ? "Snoozed for an hour." : "That one was already closed out.", ok);
      }
      const ok = await db.terminate(
        claim.instanceId,
        claim.action === "done" ? "acknowledged" : "skipped",
        "email-link",
      );
      return ackPage(
        ok
          ? claim.action === "done"
            ? "Marked done."
            : "Skipped."
          : "That one was already closed out.",
        ok,
      );
    }

    if (url.pathname === "/webhook/telegram" && req.method === "POST") {
      // Telegram echoes this header back on every delivery. Without it the
      // endpoint is an open door into your database.
      if (!secretOk(req, env)) return new Response("forbidden", { status: 403 });
      const update = await req.json().catch(() => null);
      const msg = update ? parseTelegramUpdate(update) : null;
      if (!msg) return new Response("ok");
      ctx.waitUntil(handleInbound(msg, env, update));
      ctx.waitUntil(reviveIfStale(env)); // texting the bot also revives a dead scheduler
      return new Response("ok"); // ack fast; Telegram retries on slow replies
    }

    if (url.pathname === "/webhook/twilio" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      const msg = parseTwilioForm(form);
      if (!msg) return twiml("");
      ctx.waitUntil(handleInbound(msg, env));
      return twiml("");
    }

    return new Response("not found", { status: 404 });
  },
};

/** If no tick has run for 3+ minutes, run one now. No-op under a healthy cron. */
async function reviveIfStale(env: Env): Promise<void> {
  try {
    const db = Db.from(env);
    const [last] = await db.recentTicks(1);
    if (last && Date.now() - Date.parse(last.ran_at) < 3 * 60_000) return;
    console.warn("cron appears stale — reviving", { lastTick: last?.ran_at ?? "never" });
    await runTick(env);
  } catch (e) {
    console.error("revive failed", String(e));
  }
}

async function handleInbound(msg: InboundMessage, env: Env, rawUpdate?: any): Promise<void> {
  const db = Db.from(env);

  // Sender allowlist. An unknown sender never touches the parser, so an
  // unauthenticated stranger can't create tasks or burn LLM budget.
  let user = await db.userBySender(msg.channelKind, msg.senderId);

  if (!user) {
    // First-run onboarding: the very first sender who presents the bootstrap
    // token becomes the owner. Only works while the users table is empty, so
    // a leaked token can't be used to add a second account later.
    const token = env.BOOTSTRAP_TOKEN;
    const offered = msg.text.trim();
    if (token && offered === token && (await db.userCount()) === 0) {
      user = await db.bootstrapUser(msg.channelKind, msg.senderId, DEFAULT_TZ);
      const reg = buildChannels(env);
      const ch = reg.get(msg.channelKind);
      if (ch) {
        await ch.send(
          msg.senderId,
          `👋 You're set up. Timezone is <b>${DEFAULT_TZ}</b> — say ` +
            `<code>set timezone to Asia/Tokyo</code> to change it.\n\n` +
            `Try: <code>take out trash every tuesday at 8pm</code>, or <code>help</code>.`,
        );
      }
      return;
    }
    console.warn("rejected inbound from unknown sender", {
      kind: msg.channelKind,
      sender: msg.senderId.slice(0, 6) + "…",
    });
    return;
  }

  // Providers retry deliveries. A doubly-applied snooze is a confusing bug.
  const fresh = await db.claimInbound({
    providerMessageId: msg.providerMessageId,
    channelKind: msg.channelKind,
    senderId: msg.senderId,
    text: msg.text,
  });
  if (!fresh) return;

  const now = Date.now();
  const live = await db.liveForUser(user.id, new Date(now).toISOString());

  // 1. Button payload — unambiguous, carries the instance id.
  // 2. Keyword — deterministic, no latency, no cost.
  // 3. Model — only genuinely novel text gets here.
  let parsed =
    (msg.actionPayload ? parseButton(msg.actionPayload) : null) ??
    parseKeyword(msg.text, live);

  if (!parsed) {
    const tasks = await db.tasksForUser(user.id);
    const lastExchange = await db.getDialog(user.id, now);
    parsed = await parseWithLlm(
      msg.text,
      {
        now,
        timezone: user.timezone,
        live,
        taskTitles: tasks.map((t) => t.title),
        lastExchange,
      },
      env,
    );
  }

  // A message that took a long time to reach us describes a world that no
  // longer exists: "Done with OMSCS" sent at 8:30 and delivered at 9:44 (the
  // worker died on the first attempt) was resolved against 9:44's open list.
  // Buttons are exempt — they carry the exact instance id and terminate() is
  // state-guarded, so a late tap is harmlessly idempotent.
  const STALE_MS = 10 * 60_000;
  const destructive = ["complete", "skip", "snooze", "delete"].includes(parsed.intent);
  if (destructive && parsed.source !== "button" && now - msg.receivedAt > STALE_MS) {
    const mins = Math.round((now - msg.receivedAt) / 60_000);
    const list = renderLiveList(live, now);
    const reply = {
      text:
        `⚠️ That message took ${mins} minutes to reach me, so I haven't acted on it — ` +
        `things may have moved on. Here's what's open now:\n\n${list.text}`,
      actions: list.actions,
    };
    await db.markInboundHandled(msg.providerMessageId);
    await db.putDialog(user.id, msg.text, stripTags(reply.text));
    const reg = buildChannels(env);
    const dest = resolveTarget(msg.channelKind, await db.channels(user.id), reg);
    if (dest) await dest.channel.send(dest.target, reply.text, reply.actions);
    return;
  }

  // A crash past this point used to be perfectly silent: no reply, handled_at
  // never set, and the dedupe swallowing provider retries. Four attempts to
  // attach one note died that way on 26 Aug with nothing to show for it.
  // Whatever throws now costs an apology and a log line, never silence.
  let reply;
  try {
    reply = await applyIntent(parsed, user, db, env, live, now);
  } catch (e) {
    console.error("applyIntent crashed", { intent: parsed.intent, error: String(e) });
    reply = {
      text:
        "⚠️ Something broke while I was handling that — it's logged. " +
        "Try rephrasing, or <code>help</code> for the shapes I know.",
    };
  }
  await db.markInboundHandled(msg.providerMessageId);
  // Remember this exchange so the next message can say "that" and be understood.
  await db.putDialog(user.id, msg.text, stripTags(reply.text));

  const registry = buildChannels(env);
  const channels = await db.channels(user.id);
  const dest = resolveTarget(msg.channelKind, channels, registry);
  if (dest) await dest.channel.send(dest.target, reply.text, reply.actions);

  // The board is edited in place as state changes, and a reply almost always is
  // one. After the reply, so a slow board edit never delays the answer.
  await syncBoard(env, db, user, now).catch((e) => console.error("board sync failed", e));

  // Clear the spinner on the tapped button.
  if (msg.actionPayload && env.TELEGRAM_BOT_TOKEN && rawUpdate?.callback_query?.id) {
    await answerCallbackQuery(
      env.TELEGRAM_BOT_TOKEN,
      rawUpdate.callback_query.id,
      stripTags(reply.text).slice(0, 180),
    );
  }
}

function secretOk(req: Request, env: Env): boolean {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return false;
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  return timingSafeEqual(got, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const twiml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "content-type": "text/xml" },
  });

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");
