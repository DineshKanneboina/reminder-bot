/**
 * Signed acknowledgment links.
 *
 * The default escalation ladder falls through to email at step 4. Without a
 * way to acknowledge from there, escalating to email is a dead end — you get
 * told about the reminder but can only close it out by going back to Telegram.
 *
 * Tokens are HMAC-SHA256 over `instanceId.action.expiry`, so a link can't be
 * forged and can't be replayed a week later out of an old inbox.
 */

const enc = new TextEncoder();

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

const b64url = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export type AckAction = "done" | "skip" | "snooze";

export async function signAck(
  secret: string,
  instanceId: string,
  action: AckAction,
  expiresAtMs: number,
): Promise<string> {
  const body = `${instanceId}.${action}.${expiresAtMs}`;
  const sig = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verifyAck(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<{ instanceId: string; action: AckAction } | null> {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [instanceId, action, expiry, sig] = parts;

  const expected = await signAck(secret, instanceId, action as AckAction, Number(expiry));
  // Constant-time-ish compare on the full token.
  if (expected.length !== token.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  if (diff !== 0) return null;

  if (!Number.isFinite(Number(expiry)) || Number(expiry) < now) return null;
  if (action !== "done" && action !== "skip" && action !== "snooze") return null;
  return { instanceId, action };
}

/** Minimal HTML so the browser tab isn't a raw string. */
export function ackPage(message: string, ok = true): Response {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
     <div style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:32rem;
                 margin:20vh auto;padding:0 1.5rem;text-align:center">
       <div style="font-size:2.5rem">${ok ? "✅" : "⚠️"}</div>
       <p>${message}</p>
       <p style="color:#888;font-size:.875rem">You can close this tab.</p>
     </div>`,
    { headers: { "content-type": "text/html; charset=utf-8" }, status: ok ? 200 : 400 },
  );
}
