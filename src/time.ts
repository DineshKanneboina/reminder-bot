/**
 * Timezone helpers.
 *
 * Everything is stored as a UTC epoch (ms) or an ISO-8601 UTC string. Local
 * time only ever exists transiently, computed against an IANA zone via Intl.
 * There are no stored offsets anywhere, which is what makes DST work.
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Break a UTC instant into wall-clock parts in the given zone. */
export function toLocalParts(epochMs: number, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // en-US h23 quirk on some ICU builds
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour,
    minute: parseInt(get("minute"), 10),
    weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday"))),
  };
}

/** Offset of `tz` from UTC at a given instant, in ms (positive = east). */
export function zoneOffsetMs(epochMs: number, tz: string): number {
  const p = toLocalParts(epochMs, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  // Round the source to the minute so seconds don't leak into the offset.
  return asIfUtc - Math.floor(epochMs / 60000) * 60000;
}

/**
 * Wall-clock local time -> UTC epoch ms.
 *
 * Two-pass resolution. The first pass guesses an offset using the naive
 * instant, the second re-resolves it at the corrected instant. This is what
 * makes times near a DST boundary land correctly.
 *
 * Fall-back (ambiguous) times resolve to the first occurrence.
 * Spring-forward (nonexistent) times resolve into the hour after the gap,
 * so they still fire exactly once rather than being silently dropped.
 */
export function localToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const guess = naive - zoneOffsetMs(naive, tz);
  const refined = naive - zoneOffsetMs(guess, tz);

  // If the refined instant doesn't render back as the wall clock we asked for,
  // the requested time doesn't exist — we're in the spring-forward gap. Take
  // the later candidate so the reminder shifts forward past the gap rather
  // than backwards to before it.
  const check = toLocalParts(refined, tz);
  if (check.hour !== hour || check.minute !== minute || check.day !== day) {
    return Math.max(guess, refined);
  }
  return refined;
}

/** 'HH:MM' -> [hour, minute]. Throws on garbage so bad data fails loudly. */
export function parseClock(hhmm: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`bad clock value: ${hhmm}`);
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) throw new Error(`bad clock value: ${hhmm}`);
  return [h, min];
}

/** Minutes since local midnight. */
function minutesOfDay(p: LocalParts): number {
  return p.hour * 60 + p.minute;
}

/**
 * Is this instant inside the quiet window? Handles the normal wrap-around
 * case (22:00 -> 07:00 crosses midnight).
 */
export function inQuietHours(
  epochMs: number,
  tz: string,
  quietStart: string | null,
  quietEnd: string | null,
): boolean {
  if (!quietStart || !quietEnd) return false;
  const [sh, sm] = parseClock(quietStart);
  const [eh, em] = parseClock(quietEnd);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  const now = minutesOfDay(toLocalParts(epochMs, tz));
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Push an instant forward to the end of the quiet window it falls in.
 * Returns the input unchanged if it isn't quiet. Idempotent.
 */
export function pushPastQuietHours(
  epochMs: number,
  tz: string,
  quietStart: string | null,
  quietEnd: string | null,
): number {
  if (!inQuietHours(epochMs, tz, quietStart, quietEnd)) return epochMs;
  const [eh, em] = parseClock(quietEnd!);
  const p = toLocalParts(epochMs, tz);
  const todayEnd = localToUtc(p.year, p.month, p.day, eh, em, tz);
  if (todayEnd > epochMs) return todayEnd;
  // Quiet window started before midnight; the end is tomorrow morning.
  const t = toLocalParts(epochMs + 24 * 3600_000, tz);
  return localToUtc(t.year, t.month, t.day, eh, em, tz);
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * Wall-clock times are READ by a person, so they are rendered the way that
 * person says them: "8:00 am", not "08:00". Storage stays 24h ('HH:MM') —
 * this is a presentation concern only.
 */
export function formatClock(hour: number, minute: number): string {
  const suffix = hour < 12 ? "am" : "pm";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${pad(minute)} ${suffix}`;
}

/** 'HH:MM' -> '8:00 am'. Falls back to the raw value rather than throwing. */
export function clockLabel(hhmm: string): string {
  try {
    const [h, m] = parseClock(hhmm);
    return formatClock(h, m);
  } catch {
    return hhmm;
  }
}

/** YYYY-MM-DD as it reads on a wall calendar in `tz`. The board is keyed by this. */
export function localDateString(epochMs: number, tz: string): string {
  const p = toLocalParts(epochMs, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * [start, end) of the local day containing `epochMs`, as UTC epochs.
 *
 * The end is derived by stepping 26 hours off local midnight and re-resolving:
 * a day is not always 24 hours long, and adding 86400000 lands on 23:00 or
 * 01:00 of the wrong day across a DST boundary.
 */
export function localDayBounds(epochMs: number, tz: string): [number, number] {
  const p = toLocalParts(epochMs, tz);
  const start = localToUtc(p.year, p.month, p.day, 0, 0, tz);
  const nextDay = toLocalParts(start + 26 * 3600_000, tz);
  const end = localToUtc(nextDay.year, nextDay.month, nextDay.day, 0, 0, tz);
  return [start, end];
}

/** Minutes since local midnight at this instant. */
export function localMinutesOfDay(epochMs: number, tz: string): number {
  return minutesOfDay(toLocalParts(epochMs, tz));
}

export const iso = (epochMs: number): string => new Date(epochMs).toISOString();
export const ms = (isoStr: string): number => Date.parse(isoStr);
