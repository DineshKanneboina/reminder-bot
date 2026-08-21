/**
 * Channel adapters.
 *
 * The core never knows which pipe it's on. Everything talks in
 * `send(target, text, actions)` and normalized `InboundMessage`.
 *
 * `actions` degrades per channel:
 *   telegram -> inline keyboard buttons carrying the exact instance id
 *   sms/whatsapp -> appended "reply `done 1`" hint text
 *   email -> signed ack links
 */

import { AckAction, signAck } from "./ack";
import { ChannelKind, ChannelRow, Env, InboundMessage, OutboundAction } from "./types";

/**
 * Never throws. A channel returning an HTML error page (gateway error, proxy
 * block, provider outage) must degrade to a failed SendResult — if it throws,
 * it takes down the whole tick for every user, not just this one send.
 */
async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

/**
 * `edit`, `pin` and `unpin` are optional: they exist for the board, and only a
 * channel with a mutable message log can honour them. Callers must treat their
 * absence as "this channel can't carry a board" rather than as an error — an
 * email board would be an inbox full of near-identical messages.
 */
export interface Channel {
  kind: ChannelKind;
  send(target: string, text: string, actions?: OutboundAction[]): Promise<SendResult>;
  edit?(
    target: string,
    messageId: string,
    text: string,
    actions?: OutboundAction[],
  ): Promise<SendResult>;
  pin?(target: string, messageId: string): Promise<SendResult>;
  unpin?(target: string, messageId: string): Promise<SendResult>;
}

// ---------------------------------------------------------------- telegram

class TelegramChannel implements Channel {
  kind: ChannelKind = "telegram";
  constructor(private token: string) {}

  private async call(method: string, body: Record<string, unknown>): Promise<SendResult> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await safeJson(res);
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.description ?? `HTTP ${res.status}` };
    }
    return { ok: true, providerMessageId: String(json.result?.message_id ?? "") };
  }

  private static markup(actions?: OutboundAction[]): Record<string, unknown> {
    if (!actions?.length) return {};
    return {
      reply_markup: {
        inline_keyboard: chunk(
          actions.map((a) => ({ text: a.label, callback_data: a.payload.slice(0, 64) })),
          2,
        ),
      },
    };
  }

  async send(target: string, text: string, actions?: OutboundAction[]): Promise<SendResult> {
    return this.call("sendMessage", {
      chat_id: target,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...TelegramChannel.markup(actions),
    });
  }

  async edit(
    target: string,
    messageId: string,
    text: string,
    actions?: OutboundAction[],
  ): Promise<SendResult> {
    // An edit with no reply_markup leaves the OLD keyboard in place, so a board
    // that drops to zero buttons would keep stale ones. Send an explicit empty
    // keyboard instead of omitting the field.
    const markup = TelegramChannel.markup(actions);
    return this.call("editMessageText", {
      chat_id: target,
      message_id: Number(messageId),
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: markup.reply_markup ?? { inline_keyboard: [] },
    });
  }

  async pin(target: string, messageId: string): Promise<SendResult> {
    // disable_notification: the board sits at the top of the chat, it doesn't buzz.
    return this.call("pinChatMessage", {
      chat_id: target,
      message_id: Number(messageId),
      disable_notification: true,
    });
  }

  async unpin(target: string, messageId: string): Promise<SendResult> {
    return this.call("unpinChatMessage", { chat_id: target, message_id: Number(messageId) });
  }
}

// ------------------------------------------------------------------- email

class EmailChannel implements Channel {
  kind: ChannelKind = "email";
  constructor(
    private apiKey: string,
    private from: string,
    private publicUrl?: string,
    private signingKey?: string,
  ) {}

  async send(target: string, text: string, actions?: OutboundAction[]): Promise<SendResult> {
    // Turn button payloads into signed one-tap links. Without a signing key or
    // public URL we omit them rather than emit dead "#" hrefs.
    let links = "";
    if (this.publicUrl && this.signingKey && actions?.length) {
      const parts: string[] = [];
      for (const a of actions) {
        const [verb, instanceId] = a.payload.split(":");
        if (!instanceId || (verb !== "done" && verb !== "skip" && verb !== "snooze")) continue;
        const token = await signAck(
          this.signingKey,
          instanceId,
          verb as AckAction,
          Date.now() + 7 * 86400_000,
        );
        parts.push(
          `<a href="${this.publicUrl}/ack?t=${encodeURIComponent(token)}" ` +
            `style="display:inline-block;margin:.5rem .75rem 0 0;padding:.5rem .9rem;` +
            `border:1px solid #ccc;border-radius:6px;text-decoration:none">${a.label}</a>`,
        );
      }
      links = parts.length ? `<p style="margin-top:1rem">${parts.join("")}</p>` : "";
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [target],
        subject: firstLine(text),
        html: `<div style="font:15px/1.5 -apple-system,sans-serif">${escapeHtml(text).replace(/\n/g, "<br>")}${links}</div>`,
      }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await safeJson(res);
    return { ok: true, providerMessageId: json?.id };
  }
}

// --------------------------------------------------------------------- sms

class TwilioChannel implements Channel {
  kind: ChannelKind = "sms";
  constructor(private sid: string, private token: string, private from: string) {}

  async send(target: string, text: string, actions?: OutboundAction[]): Promise<SendResult> {
    // No rich actions on SMS — fold them into the body as reply keywords.
    const hint = actions?.length
      ? "\n" + actions.map((a) => `${a.label}: reply ${keywordFor(a.payload)}`).join(" · ")
      : "";
    const form = new URLSearchParams({
      To: target,
      From: this.from,
      Body: (text + hint).slice(0, 1500),
    });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: "Basic " + btoa(`${this.sid}:${this.token}`),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
      },
    );
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await safeJson(res);
    return { ok: true, providerMessageId: json?.sid };
  }
}

// ------------------------------------------------------------------ registry

/**
 * Wraps an adapter so a thrown fetch (DNS failure, socket reset) becomes a
 * failed SendResult. Defence in depth alongside safeJson.
 */
function nonThrowing(ch: Channel): Channel {
  const wrapped: Channel = {
    kind: ch.kind,
    async send(target, text, actions) {
      try {
        return await ch.send(target, text, actions);
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  };
  if (ch.edit) {
    wrapped.edit = async (target, messageId, text, actions) => {
      try {
        return await ch.edit!(target, messageId, text, actions);
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    };
  }
  // Pinning never blocks a board, but it is no longer silent: a swallowed pin
  // failure is how yesterday's board stayed pinned for a whole day with no
  // trace of why.
  if (ch.pin) {
    wrapped.pin = async (target, messageId) => {
      try {
        return await ch.pin!(target, messageId);
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    };
  }
  if (ch.unpin) {
    wrapped.unpin = async (target, messageId) => {
      try {
        return await ch.unpin!(target, messageId);
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    };
  }
  return wrapped;
}

export function buildChannels(env: Env): Map<ChannelKind, Channel> {
  const m = new Map<ChannelKind, Channel>();
  if (env.TELEGRAM_BOT_TOKEN) m.set("telegram", nonThrowing(new TelegramChannel(env.TELEGRAM_BOT_TOKEN)));
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    m.set(
      "email",
      nonThrowing(
        new EmailChannel(env.RESEND_API_KEY, env.EMAIL_FROM, env.PUBLIC_URL, env.ACK_SIGNING_KEY),
      ),
    );
  }
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) {
    m.set("sms", nonThrowing(new TwilioChannel(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_FROM)));
  }
  return m;
}

/**
 * Resolve a ladder entry ("primary" or an explicit kind) to a real channel.
 * Falls back to the user's primary if the requested kind isn't configured, so
 * a half-configured escalation ladder degrades instead of silently dropping.
 */
export function resolveTarget(
  want: string,
  userChannels: ChannelRow[],
  registry: Map<ChannelKind, Channel>,
): { channel: Channel; target: string } | null {
  const primary = userChannels[0];
  const pick =
    want === "primary"
      ? primary
      : (userChannels.find((c) => c.kind === want && registry.has(c.kind)) ?? primary);
  if (!pick || !registry.has(pick.kind)) {
    const fallback = userChannels.find((c) => registry.has(c.kind));
    if (!fallback) return null;
    return { channel: registry.get(fallback.kind)!, target: fallback.sender_id };
  }
  return { channel: registry.get(pick.kind)!, target: pick.sender_id };
}

// ------------------------------------------------------------------ inbound

/** Telegram update -> InboundMessage. Returns null for updates we ignore. */
export function parseTelegramUpdate(update: any): InboundMessage | null {
  if (update.callback_query) {
    const cq = update.callback_query;
    return {
      channelKind: "telegram",
      senderId: String(cq.message?.chat?.id ?? cq.from?.id),
      text: cq.data ?? "",
      actionPayload: cq.data,
      providerMessageId: `cb:${cq.id}`,
      receivedAt: Date.now(),
    };
  }
  const msg = update.message ?? update.edited_message;
  if (!msg?.text) return null;
  return {
    channelKind: "telegram",
    senderId: String(msg.chat.id),
    text: msg.text,
    providerMessageId: `msg:${msg.chat.id}:${msg.message_id}`,
    receivedAt: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
  };
}

/** Twilio inbound webhook form body -> InboundMessage. */
export function parseTwilioForm(form: URLSearchParams): InboundMessage | null {
  const from = form.get("From");
  const body = form.get("Body");
  const sid = form.get("MessageSid");
  if (!from || !body || !sid) return null;
  return {
    channelKind: from.startsWith("whatsapp:") ? "whatsapp" : "sms",
    senderId: from,
    text: body,
    providerMessageId: sid,
    receivedAt: Date.now(),
  };
}

export async function answerCallbackQuery(token: string, id: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: id.replace(/^cb:/, ""), text }),
  }).catch(() => {});
}

// ------------------------------------------------------------------ helpers

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function firstLine(s: string): string {
  return s.split("\n")[0].slice(0, 120) || "Reminder";
}

function keywordFor(payload: string): string {
  const [verb, , idx] = payload.split(":");
  return idx ? `${verb} ${idx}` : verb;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}
