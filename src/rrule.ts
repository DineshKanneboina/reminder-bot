/**
 * A deliberately small RFC 5545 RRULE expander.
 *
 * Why not the `rrule` npm package: it expands in UTC or in a fixed offset,
 * and we need every occurrence re-anchored to a wall-clock time in an IANA
 * zone. Doing that on top of a general library means converting back and
 * forth anyway. The subset below covers everything a personal task reminder
 * realistically needs, and it's small enough to test exhaustively.
 *
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY (with optional
 * ordinal prefix for MONTHLY, e.g. -1FR = last Friday), BYMONTHDAY, COUNT,
 * UNTIL.
 */

import { LocalParts, clockLabel, localToUtc, parseClock, toLocalParts } from "./time";

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export interface Rule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byDay: { ordinal: number | null; weekday: number }[];
  byMonthDay: number[];
  count: number | null;
  until: number | null; // UTC epoch ms
}

export function parseRRule(input: string): Rule {
  const rule: Rule = {
    freq: "DAILY",
    interval: 1,
    byDay: [],
    byMonthDay: [],
    count: null,
    until: null,
  };
  let sawFreq = false;

  for (const chunk of input.replace(/^RRULE:/i, "").split(";")) {
    if (!chunk.trim()) continue;
    const [rawKey, rawVal] = chunk.split("=");
    const key = rawKey.trim().toUpperCase();
    const val = (rawVal ?? "").trim();

    switch (key) {
      case "FREQ": {
        const f = val.toUpperCase();
        if (f !== "DAILY" && f !== "WEEKLY" && f !== "MONTHLY" && f !== "YEARLY") {
          throw new Error(`unsupported FREQ: ${val}`);
        }
        rule.freq = f;
        sawFreq = true;
        break;
      }
      case "INTERVAL": {
        const n = parseInt(val, 10);
        if (!Number.isFinite(n) || n < 1) throw new Error(`bad INTERVAL: ${val}`);
        rule.interval = n;
        break;
      }
      case "BYDAY":
        rule.byDay = val
          .split(",")
          .filter(Boolean)
          .map((tok) => {
            const m = /^([+-]?\d)?([A-Za-z]{2})$/.exec(tok.trim());
            if (!m) throw new Error(`bad BYDAY token: ${tok}`);
            const weekday = DAY_CODES.indexOf(m[2].toUpperCase());
            if (weekday < 0) throw new Error(`bad BYDAY token: ${tok}`);
            return { ordinal: m[1] ? parseInt(m[1], 10) : null, weekday };
          });
        break;
      case "BYMONTHDAY":
        rule.byMonthDay = val
          .split(",")
          .filter(Boolean)
          .map((d) => parseInt(d, 10));
        break;
      case "COUNT":
        rule.count = parseInt(val, 10);
        break;
      case "UNTIL": {
        // Accept both basic (20261231T000000Z) and extended ISO form.
        const basic = /^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(val);
        rule.until = basic
          ? Date.UTC(
              +basic[1],
              +basic[2] - 1,
              +basic[3],
              +(basic[5] ?? 0),
              +(basic[6] ?? 0),
              +(basic[7] ?? 0),
            )
          : Date.parse(val);
        if (!Number.isFinite(rule.until)) throw new Error(`bad UNTIL: ${val}`);
        break;
      }
      // DTSTART is stored on the task, not in the rule. Ignore if present.
      case "DTSTART":
      case "WKST":
        break;
      default:
        throw new Error(`unsupported RRULE part: ${key}`);
    }
  }

  if (!sawFreq) throw new Error("RRULE requires FREQ");
  return rule;
}

/** Whole days between two local calendar dates, ignoring time of day. */
function dayIndex(p: LocalParts): number {
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000);
}

/** Sunday-anchored week index, so WEEKLY;INTERVAL=2 counts calendar weeks. */
function weekIndex(p: LocalParts): number {
  return Math.floor((dayIndex(p) - (p.weekday - 4 + 7) % 7) / 7);
}

function nthWeekdayOfMonth(p: LocalParts): number {
  return Math.floor((p.day - 1) / 7) + 1;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdaysRemainingInMonth(p: LocalParts): number {
  return Math.ceil((daysInMonth(p.year, p.month) - p.day + 1) / 7);
}

/** Does this local calendar day match the rule, given the rule's start day? */
function matchesDay(rule: Rule, start: LocalParts, day: LocalParts): boolean {
  if (dayIndex(day) < dayIndex(start)) return false;

  switch (rule.freq) {
    case "DAILY":
      return (dayIndex(day) - dayIndex(start)) % rule.interval === 0;

    case "WEEKLY": {
      if ((weekIndex(day) - weekIndex(start)) % rule.interval !== 0) return false;
      if (rule.byDay.length === 0) return day.weekday === start.weekday;
      return rule.byDay.some((d) => d.weekday === day.weekday);
    }

    case "MONTHLY": {
      const months =
        (day.year - start.year) * 12 + (day.month - start.month);
      if (months % rule.interval !== 0) return false;
      if (rule.byMonthDay.length > 0) {
        return rule.byMonthDay.some((d) =>
          d > 0 ? day.day === d : day.day === daysInMonth(day.year, day.month) + 1 + d,
        );
      }
      if (rule.byDay.length > 0) {
        return rule.byDay.some((bd) => {
          if (bd.weekday !== day.weekday) return false;
          if (bd.ordinal === null) return true;
          return bd.ordinal > 0
            ? nthWeekdayOfMonth(day) === bd.ordinal
            : weekdaysRemainingInMonth(day) === -bd.ordinal;
        });
      }
      return day.day === start.day;
    }

    case "YEARLY": {
      if ((day.year - start.year) % rule.interval !== 0) return false;
      return day.month === start.month && day.day === start.day;
    }
  }
}

/**
 * Every occurrence in [fromMs, toMs), as UTC epoch ms.
 *
 * `localTime` ('HH:MM') is re-applied in `tz` for each occurrence, which is
 * the whole point: an 08:00 reminder stays at 08:00 local across a DST
 * boundary instead of drifting to 07:00.
 */
export function occurrencesBetween(
  rruleStr: string,
  dtstartMs: number,
  localTime: string,
  tz: string,
  fromMs: number,
  toMs: number,
  hardLimit = 512,
): number[] {
  const rule = parseRRule(rruleStr);
  const [hh, mm] = parseClock(localTime);
  const start = toLocalParts(dtstartMs, tz);
  const out: number[] = [];

  // Walk local calendar days. Step back one day from `from` so an occurrence
  // whose local day began before the window but lands inside it is caught.
  let cursor = fromMs - 36 * 3600_000;
  const endWalk = toMs + 24 * 3600_000;
  let guard = 0;
  let emitted = 0;

  while (cursor <= endWalk && guard++ < hardLimit) {
    const day = toLocalParts(cursor, tz);
    if (matchesDay(rule, start, day)) {
      const at = localToUtc(day.year, day.month, day.day, hh, mm, tz);
      if (at >= dtstartMs && (rule.until === null || at <= rule.until)) {
        if (at >= fromMs && at < toMs && !out.includes(at)) out.push(at);
        emitted++;
        if (rule.count !== null && emitted >= rule.count) break;
      }
    }
    // Advance ~1 local day. Adding 24h to a UTC instant can land on the same
    // local day across a DST fall-back, so normalise to local noon.
    const next = toLocalParts(cursor + 24 * 3600_000, tz);
    cursor = localToUtc(next.year, next.month, next.day, 12, 0, tz);
  }

  return out.sort((a, b) => a - b);
}

/**
 * When a one-off actually lands, or null if this rule isn't a one-off.
 *
 * COUNT=1 is how the parser encodes "remind me to X tomorrow", so a task with
 * that rule has exactly one occurrence, ever — and once it has passed the task
 * is spent, however alive it still looks in the tasks table.
 */
export function oneOffOccurrence(
  rruleStr: string,
  dtstartMs: number,
  localTime: string,
  tz: string,
): number | null {
  let rule: Rule;
  try {
    rule = parseRRule(rruleStr);
  } catch {
    return null;
  }
  if (rule.count !== 1) return null;
  // COUNT=1 stops the walk at the first match, so the window can be generous.
  const occ = occurrencesBetween(
    rruleStr, dtstartMs, localTime, tz, dtstartMs, dtstartMs + 400 * 86400_000,
  );
  return occ.length ? occ[0] : null;
}

/** Human-readable summary of a rule, for confirmation messages. */
export function describeRRule(rruleStr: string, localTime: string): string {
  const r = parseRRule(rruleStr);
  // Describing a one-off by its FREQ says the opposite of what will happen:
  // "FREQ=DAILY;COUNT=1" is not "daily", it is exactly once.
  if (r.count === 1) return `once at ${clockLabel(localTime)}`;
  const days = r.byDay
    .map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.weekday])
    .join("/");
  const every = r.interval === 1 ? "every" : `every ${r.interval}`;
  let base: string;
  switch (r.freq) {
    case "DAILY":
      base = r.interval === 1 ? "daily" : `every ${r.interval} days`;
      break;
    case "WEEKLY":
      base = days ? `${every === "every" ? "" : every + " weeks on "}${days}` : `${every} week`;
      break;
    case "MONTHLY":
      base = r.byMonthDay.length
        ? `monthly on day ${r.byMonthDay.join(", ")}`
        : days
          ? `monthly on ${days}`
          : "monthly";
      break;
    case "YEARLY":
      base = "yearly";
      break;
  }
  return `${base.trim()} at ${clockLabel(localTime)}`;
}
