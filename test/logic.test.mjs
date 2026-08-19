import assert from "node:assert/strict";
import { test } from "node:test";
import { localToUtc, toLocalParts, inQuietHours, pushPastQuietHours } from "../build/time.js";
import { occurrencesBetween, parseRRule, describeRRule, oneOffOccurrence } from "../build/rrule.js";
import { renderTaskList } from "../build/render.js";

const TZ = "America/Chicago";
const at = (ms) => {
  const p = toLocalParts(ms, TZ);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

test("localToUtc round-trips wall clock in both DST regimes", () => {
  assert.equal(at(localToUtc(2026, 1, 15, 8, 0, TZ)), "2026-01-15 08:00"); // CST
  assert.equal(at(localToUtc(2026, 7, 15, 8, 0, TZ)), "2026-07-15 08:00"); // CDT
});

test("spring-forward gap resolves into a real instant, fires exactly once", () => {
  // 2026-03-08 02:30 America/Chicago does not exist.
  const t = localToUtc(2026, 3, 8, 2, 30, TZ);
  assert.equal(at(t), "2026-03-08 03:30");
  const occ = occurrencesBetween(
    "FREQ=DAILY", Date.UTC(2026, 2, 1), "02:30", TZ,
    Date.UTC(2026, 2, 8), Date.UTC(2026, 2, 9),
  );
  assert.equal(occ.length, 1);
});

test("08:00 daily stays at 08:00 local across spring forward", () => {
  const occ = occurrencesBetween(
    "FREQ=DAILY", Date.UTC(2026, 2, 1), "08:00", TZ,
    Date.UTC(2026, 2, 6), Date.UTC(2026, 2, 11),
  );
  assert.deepEqual(occ.map(at), [
    "2026-03-06 08:00", "2026-03-07 08:00", "2026-03-08 08:00",
    "2026-03-09 08:00", "2026-03-10 08:00",
  ]);
  // and the underlying UTC instants really do shift by an hour
  assert.equal(occ[2] - occ[1], 23 * 3600_000);
});

test("08:00 daily stays at 08:00 local across fall back", () => {
  const occ = occurrencesBetween(
    "FREQ=DAILY", Date.UTC(2026, 9, 1), "08:00", TZ,
    Date.UTC(2026, 9, 30), Date.UTC(2026, 10, 4),
  );
  assert.deepEqual(occ.map(at), [
    "2026-10-30 08:00", "2026-10-31 08:00",
    "2026-11-01 08:00", "2026-11-02 08:00", "2026-11-03 08:00",
  ]);
  assert.equal(occ[2] - occ[1], 25 * 3600_000); // Oct 31 08:00 -> Nov 1 08:00 spans the fall-back
});

test("FREQ=WEEKLY;BYDAY=MO,WE,FR", () => {
  const occ = occurrencesBetween(
    "FREQ=WEEKLY;BYDAY=MO,WE,FR", Date.UTC(2026, 7, 10), "06:30", TZ,
    Date.UTC(2026, 7, 10), Date.UTC(2026, 7, 17),
  );
  assert.deepEqual(occ.map(at), [
    "2026-08-10 06:30", "2026-08-12 06:30", "2026-08-14 06:30",
  ]); // Mon, Wed, Fri
});

test("every other Tuesday", () => {
  const occ = occurrencesBetween(
    "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", Date.UTC(2026, 7, 11, 17), "12:00", TZ,
    Date.UTC(2026, 7, 10), Date.UTC(2026, 8, 10),
  );
  assert.deepEqual(occ.map(at), [
    "2026-08-11 12:00", "2026-08-25 12:00", "2026-09-08 12:00",
  ]);
});

test("last Friday of the month", () => {
  const occ = occurrencesBetween(
    "FREQ=MONTHLY;BYDAY=-1FR", Date.UTC(2026, 7, 1), "17:00", TZ,
    Date.UTC(2026, 7, 1), Date.UTC(2026, 10, 1),
  );
  assert.deepEqual(occ.map(at), [
    "2026-08-28 17:00", "2026-09-25 17:00", "2026-10-30 17:00",
  ]);
});

test("monthly on the 1st and 15th", () => {
  const occ = occurrencesBetween(
    "FREQ=MONTHLY;BYMONTHDAY=1,15", Date.UTC(2026, 7, 1), "09:00", TZ,
    Date.UTC(2026, 7, 1), Date.UTC(2026, 9, 1),
  );
  assert.deepEqual(occ.map(at), [
    "2026-08-01 09:00", "2026-08-15 09:00",
    "2026-09-01 09:00", "2026-09-15 09:00",
  ]);
});

test("UNTIL and COUNT terminate the series", () => {
  const until = occurrencesBetween(
    "FREQ=DAILY;UNTIL=20260813T235959Z", Date.UTC(2026, 7, 10), "09:00", TZ,
    Date.UTC(2026, 7, 10), Date.UTC(2026, 7, 20),
  );
  assert.equal(until.length, 4);
  const count = occurrencesBetween(
    "FREQ=DAILY;COUNT=3", Date.UTC(2026, 7, 10), "09:00", TZ,
    Date.UTC(2026, 7, 10), Date.UTC(2026, 7, 20),
  );
  assert.equal(count.length, 3);
});

test("occurrences never precede DTSTART", () => {
  const occ = occurrencesBetween(
    "FREQ=DAILY", Date.UTC(2026, 7, 12), "09:00", TZ,
    Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 15),
  );
  assert.deepEqual(occ.map(at), ["2026-08-12 09:00", "2026-08-13 09:00", "2026-08-14 09:00"]);
});

test("quiet hours wrap midnight", () => {
  const q = ["22:00", "07:00"];
  assert.equal(inQuietHours(localToUtc(2026, 8, 1, 23, 30, TZ), TZ, ...q), true);
  assert.equal(inQuietHours(localToUtc(2026, 8, 1, 3, 0, TZ), TZ, ...q), true);
  assert.equal(inQuietHours(localToUtc(2026, 8, 1, 12, 0, TZ), TZ, ...q), false);
  assert.equal(inQuietHours(localToUtc(2026, 8, 1, 21, 59, TZ), TZ, ...q), false);
  assert.equal(inQuietHours(localToUtc(2026, 8, 1, 7, 0, TZ), TZ, ...q), false);
});

test("pushPastQuietHours lands on quiet_end and is idempotent", () => {
  const q = ["22:00", "07:00"];
  const late = localToUtc(2026, 8, 1, 23, 30, TZ);
  const pushed = pushPastQuietHours(late, TZ, ...q);
  assert.equal(at(pushed), "2026-08-02 07:00");
  assert.equal(pushPastQuietHours(pushed, TZ, ...q), pushed);

  const early = localToUtc(2026, 8, 2, 3, 0, TZ);
  assert.equal(at(pushPastQuietHours(early, TZ, ...q)), "2026-08-02 07:00");

  const noon = localToUtc(2026, 8, 2, 12, 0, TZ);
  assert.equal(pushPastQuietHours(noon, TZ, ...q), noon);
});

test("timezone travel: same rule, different zone", () => {
  const tokyo = occurrencesBetween(
    "FREQ=DAILY", Date.UTC(2026, 10, 10), "08:00", "Asia/Tokyo",
    Date.UTC(2026, 10, 12), Date.UTC(2026, 10, 13),
  );
  const p = toLocalParts(tokyo[0], "Asia/Tokyo");
  assert.equal(`${p.hour}:${String(p.minute).padStart(2, "0")}`, "8:00");
  assert.equal(toLocalParts(tokyo[0], TZ).hour, 17); // 08:00 JST = 17:00 CST prev day
});

test("rrule parser rejects garbage loudly", () => {
  assert.throws(() => parseRRule("FREQ=FORTNIGHTLY"));
  assert.throws(() => parseRRule("BYDAY=MO"), /requires FREQ/);
  assert.throws(() => parseRRule("FREQ=DAILY;BYDAY=XX"));
  assert.throws(() => parseRRule("FREQ=DAILY;INTERVAL=0"));
});

test("describeRRule is readable", () => {
  assert.equal(describeRRule("FREQ=WEEKLY;BYDAY=MO,WE,FR", "06:30"), "Mon/Wed/Fri at 6:30 am");
  assert.equal(describeRRule("FREQ=DAILY", "08:00"), "daily at 8:00 am");
});

test("a one-off is never described as recurring", () => {
  // COUNT=1 is how the parser encodes "remind me to X tomorrow". Calling that
  // "daily" tells the user the opposite of what will happen.
  assert.equal(describeRRule("FREQ=DAILY;COUNT=1", "18:00"), "once at 6:00 pm");
  assert.equal(describeRRule("FREQ=WEEKLY;BYDAY=TH;COUNT=1", "18:00"), "once at 6:00 pm");
});

test("oneOffOccurrence finds the single landing, and only for one-offs", () => {
  // Created 10:49, due 18:00 the same day.
  const sameDay = localToUtc(2026, 8, 13, 10, 49, TZ);
  assert.equal(
    oneOffOccurrence("FREQ=DAILY;COUNT=1", sameDay, "18:00", TZ),
    localToUtc(2026, 8, 13, 18, 0, TZ),
  );

  // Created after that time of day has already passed: it lands tomorrow. This
  // is why a 09:00 task made at 10:05 has nothing on today's board.
  const tooLate = localToUtc(2026, 8, 17, 10, 5, TZ);
  assert.equal(
    oneOffOccurrence("FREQ=DAILY;COUNT=1", tooLate, "09:00", TZ),
    localToUtc(2026, 8, 18, 9, 0, TZ),
  );

  assert.equal(oneOffOccurrence("FREQ=DAILY", sameDay, "18:00", TZ), null, "not a one-off");
});

test("the tasks list separates what will happen again from what already did", () => {
  const task = (title, rrule, dtstartMs) => ({
    title,
    rrule,
    dtstart: new Date(dtstartMs).toISOString(),
    local_time: "18:00",
    timezone: TZ,
  });
  const now = localToUtc(2026, 8, 17, 13, 0, TZ);

  const out = renderTaskList(
    [
      task("water plants", "FREQ=DAILY", localToUtc(2026, 8, 1, 9, 0, TZ)),
      task("find Cindy", "FREQ=DAILY;COUNT=1", localToUtc(2026, 8, 13, 10, 49, TZ)),
      task("book flight", "FREQ=DAILY;COUNT=1", localToUtc(2026, 8, 17, 10, 0, TZ)),
    ],
    now,
  );

  assert.match(out, /water plants<\/b> — daily at 6:00 pm/);
  assert.match(out, /book flight<\/b> — once, Mon 17 Aug at 6:00 pm/);

  // The one that already fired is quarantined, not listed as if it were live.
  assert.match(out, /<b>Already happened<\/b>/);
  assert.match(out, /<s>find Cindy<\/s> — was Thu 13 Aug/);
  assert.doesNotMatch(out, /<b>find Cindy<\/b>/);
  assert.match(out, /delete find Cindy/, "and it says how to clear it");
});
