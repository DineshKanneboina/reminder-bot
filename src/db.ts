import {
  BoardRow,
  ChannelRow,
  ClosedInstance,
  Env,
  InstanceRow,
  LiveInstance,
  PolicyRow,
  TaskRow,
  UserRow,
} from "./types";
import { iso } from "./time";

export const uid = (): string => crypto.randomUUID();

const INSTANCE_JOIN = `
  SELECT i.*, t.title, t.notes, t.rrule, t.local_time, t.timezone,
         p.ladder_minutes, p.channel_ladder, p.quiet_start, p.quiet_end,
         p.give_up_after_minutes, p.max_concurrent, p.tier
    FROM reminder_instances i
    JOIN tasks t  ON t.id = i.task_id
    JOIN escalation_policies p ON p.id = t.policy_id
`;

export class Db {
  constructor(private d1: D1Database) {}

  static from(env: Env): Db {
    return new Db(env.DB);
  }

  // ---- users & channels -------------------------------------------------

  async userBySender(kind: string, senderId: string): Promise<UserRow | null> {
    return this.d1
      .prepare(
        `SELECT u.* FROM users u
           JOIN channels c ON c.user_id = u.id
          WHERE c.kind = ?1 AND c.sender_id = ?2 AND c.active = 1`,
      )
      .bind(kind, senderId)
      .first<UserRow>();
  }

  /** First-run onboarding. Creates the user and binds the sender as primary. */
  async bootstrapUser(kind: string, senderId: string, timezone: string): Promise<UserRow> {
    const id = uid();
    const now = iso(Date.now());
    await this.d1.batch([
      this.d1
        .prepare(`INSERT INTO users (id,timezone,default_policy_id,created_at) VALUES (?1,?2,?3,?4)`)
        .bind(id, timezone, "pol_default", now),
      this.d1
        .prepare(`INSERT INTO channels (id,user_id,kind,sender_id,priority,active) VALUES (?1,?2,?3,?4,0,1)`)
        .bind(uid(), id, kind, senderId),
    ]);
    return (await this.user(id))!;
  }

  /** Is anyone registered at all? Guards the bootstrap token to one use. */
  async userCount(): Promise<number> {
    const r = await this.d1.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
    return r?.n ?? 0;
  }

  async instance(id: string): Promise<InstanceRow | null> {
    return this.d1
      .prepare(`SELECT * FROM reminder_instances WHERE id = ?1`)
      .bind(id)
      .first<InstanceRow>();
  }

  async user(id: string): Promise<UserRow | null> {
    return this.d1.prepare(`SELECT * FROM users WHERE id = ?1`).bind(id).first<UserRow>();
  }

  async allUsers(): Promise<UserRow[]> {
    const r = await this.d1.prepare(`SELECT * FROM users`).all<UserRow>();
    return r.results ?? [];
  }

  async channels(userId: string): Promise<ChannelRow[]> {
    const r = await this.d1
      .prepare(`SELECT * FROM channels WHERE user_id = ?1 AND active = 1 ORDER BY priority`)
      .bind(userId)
      .all<ChannelRow>();
    return r.results ?? [];
  }

  async setTimezone(userId: string, tz: string): Promise<void> {
    await this.d1.batch([
      this.d1.prepare(`UPDATE users SET timezone = ?2 WHERE id = ?1`).bind(userId, tz),
      // Live tasks follow the user. Future occurrences re-materialize in the
      // new zone; already-scheduled ones are left alone so nothing is lost.
      this.d1
        .prepare(`UPDATE tasks SET timezone = ?2, updated_at = ?3 WHERE user_id = ?1 AND active = 1`)
        .bind(userId, tz, iso(Date.now())),
    ]);
  }

  async setPaused(userId: string, untilMs: number | null): Promise<void> {
    await this.d1
      .prepare(`UPDATE users SET paused_until = ?2 WHERE id = ?1`)
      .bind(userId, untilMs === null ? null : iso(untilMs))
      .run();
  }

  // ---- policies ---------------------------------------------------------

  async policy(id: string): Promise<PolicyRow | null> {
    return this.d1
      .prepare(`SELECT * FROM escalation_policies WHERE id = ?1`)
      .bind(id)
      .first<PolicyRow>();
  }

  async policyByName(userId: string, name: string): Promise<PolicyRow | null> {
    return this.d1
      .prepare(
        `SELECT * FROM escalation_policies
          WHERE name = ?2 AND (user_id = ?1 OR user_id IS NULL)
          ORDER BY user_id DESC LIMIT 1`,
      )
      .bind(userId, name)
      .first<PolicyRow>();
  }

  // ---- tasks ------------------------------------------------------------

  async activeTasks(): Promise<TaskRow[]> {
    const r = await this.d1
      .prepare(`SELECT * FROM tasks WHERE active = 1`)
      .all<TaskRow>();
    return r.results ?? [];
  }

  async tasksForUser(userId: string): Promise<TaskRow[]> {
    const r = await this.d1
      .prepare(`SELECT * FROM tasks WHERE user_id = ?1 AND active = 1 ORDER BY local_time`)
      .bind(userId)
      .all<TaskRow>();
    return r.results ?? [];
  }

  /**
   * The task created most recently, for a bare "note: ...". Bounded by age on
   * purpose: attaching a note to something made last week because it happens
   * to be newest would put context on the wrong reminder silently.
   */
  async newestTask(userId: string, sinceIso: string): Promise<TaskRow | null> {
    return this.d1
      .prepare(
        `SELECT * FROM tasks
          WHERE user_id = ?1 AND active = 1 AND created_at >= ?2
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(userId, sinceIso)
      .first<TaskRow>();
  }

  /** Loose title match, used to resolve "the gym one". */
  async findTasks(userId: string, query: string): Promise<TaskRow[]> {
    const r = await this.d1
      .prepare(
        `SELECT * FROM tasks
          WHERE user_id = ?1 AND active = 1 AND lower(title) LIKE '%' || lower(?2) || '%'`,
      )
      .bind(userId, query)
      .all<TaskRow>();
    return r.results ?? [];
  }

  async insertTask(t: TaskRow): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO tasks (id,user_id,title,notes,rrule,dtstart,local_time,timezone,
                            policy_id,overlap,active,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,?11,?11)`,
      )
      .bind(
        t.id, t.user_id, t.title, t.notes, t.rrule, t.dtstart,
        t.local_time, t.timezone, t.policy_id, t.overlap, t.created_at,
      )
      .run();
  }

  async updateTask(id: string, fields: Partial<TaskRow>): Promise<void> {
    const allowed = ["title", "notes", "rrule", "dtstart", "local_time", "policy_id", "overlap", "active"];
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = ?${sets.length + 1}`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(iso(Date.now()), id);
    await this.d1
      .prepare(
        `UPDATE tasks SET ${sets.join(", ")}, updated_at = ?${vals.length - 1} WHERE id = ?${vals.length}`,
      )
      .bind(...vals)
      .run();
  }

  /** Soft delete: keeps history, stops all future and live nagging. */
  async deactivateTask(id: string): Promise<void> {
    await this.d1.batch([
      this.d1.prepare(`UPDATE tasks SET active = 0, updated_at = ?2 WHERE id = ?1`)
        .bind(id, iso(Date.now())),
      this.d1
        .prepare(
          `UPDATE reminder_instances SET state = 'superseded', next_nag_at = NULL
            WHERE task_id = ?1 AND state IN ('pending','notified')`,
        )
        .bind(id),
    ]);
  }

  // ---- instances --------------------------------------------------------

  async insertInstanceIfAbsent(row: InstanceRow): Promise<boolean> {
    const r = await this.d1
      .prepare(
        `INSERT OR IGNORE INTO reminder_instances
           (id,task_id,user_id,scheduled_for,state,attempt_count,escalation_step,
            next_nag_at,give_up_at)
         VALUES (?1,?2,?3,?4,'pending',0,0,?5,?6)`,
      )
      .bind(row.id, row.task_id, row.user_id, row.scheduled_for, row.next_nag_at, row.give_up_at)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /** Retire every live instance of a task — used when a task is edited or deleted. */
  async supersedeAll(taskId: string): Promise<void> {
    await this.d1
      .prepare(
        `UPDATE reminder_instances
            SET state = 'superseded', next_nag_at = NULL
          WHERE task_id = ?1 AND state IN ('pending','notified')`,
      )
      .bind(taskId)
      .run();
  }

  /**
   * Collapse overlapping chains: for tasks marked 'supersede', keep only the
   * newest instance that has actually come due, and retire older live ones.
   *
   * This deliberately runs at fire time, not at materialization time. We
   * materialize 48h ahead, so superseding on creation would have tomorrow's
   * occurrence retire today's before it ever nagged. Future-dated instances
   * are never touched here.
   */
  async supersedeStaleChains(nowIso: string): Promise<number> {
    const r = await this.d1
      .prepare(
        `UPDATE reminder_instances
            SET state = 'superseded', next_nag_at = NULL
          WHERE state IN ('pending','notified')
            AND scheduled_for <= ?1
            AND task_id IN (SELECT id FROM tasks WHERE overlap = 'supersede')
            AND scheduled_for < (
              SELECT MAX(i2.scheduled_for) FROM reminder_instances i2
               WHERE i2.task_id = reminder_instances.task_id
                 AND i2.state IN ('pending','notified')
                 AND i2.scheduled_for <= ?1
            )`,
      )
      .bind(nowIso)
      .run();
    return r.meta?.changes ?? 0;
  }

  /**
   * Deliberately does NOT require next_nag_at IS NOT NULL. A 'notify' item has
   * an empty ladder, so it goes next_nag_at NULL after its single send while
   * staying in a live state — without this it would sit on the board forever.
   * give_up_at is the one thing nothing outlives.
   */
  async expireOverdue(nowIso: string): Promise<number> {
    const r = await this.d1
      .prepare(
        `UPDATE reminder_instances
            SET state = 'expired', next_nag_at = NULL
          WHERE state IN ('pending','notified')
            AND give_up_at <= ?1`,
      )
      .bind(nowIso)
      .run();
    return r.meta?.changes ?? 0;
  }

  /**
   * Rewind a claim for an item whose policy says "don't push yet".
   *
   * claimDue has already burned an attempt and an escalation step; a quiet item
   * that waits four hours on the board must arrive at its first real nag with a
   * full ladder, so both are given back. next_nag_at moves to the instant the
   * item becomes pushable, and give_up_at is stretched past it — otherwise a
   * 180-minute give-up window would expire the item before a 4-hour quiet
   * window ever let it speak.
   */
  async parkQuiet(id: string, untilIso: string, giveUpIso: string): Promise<void> {
    await this.d1
      .prepare(
        `UPDATE reminder_instances
            SET state = 'pending',
                attempt_count   = MAX(attempt_count - 1, 0),
                escalation_step = MAX(escalation_step - 1, 0),
                next_nag_at = ?2,
                give_up_at  = MAX(give_up_at, ?3)
          WHERE id = ?1 AND state IN ('pending','notified')`,
      )
      .bind(id, untilIso, giveUpIso)
      .run();
  }

  /**
   * Atomically claim due instances with a short lease. The lease (rather than
   * NULL) is what makes a crashed send self-heal instead of stranding the row.
   */
  async claimDue(nowIso: string, staleFloorIso: string, leaseIso: string, limit = 20) {
    const r = await this.d1
      .prepare(
        `UPDATE reminder_instances
            SET state = 'notified',
                attempt_count = attempt_count + 1,
                escalation_step = escalation_step + 1,
                next_nag_at = ?3
          WHERE id IN (
            SELECT id FROM reminder_instances
             WHERE next_nag_at IS NOT NULL
               AND next_nag_at <= ?1
               AND next_nag_at > ?2
               AND state IN ('pending','notified')
             ORDER BY next_nag_at ASC
             LIMIT ?4
          )
          RETURNING id`,
      )
      .bind(nowIso, staleFloorIso, leaseIso, limit)
      .all<{ id: string }>();
    const ids = (r.results ?? []).map((x) => x.id);
    return ids.length ? this.hydrate(ids) : [];
  }

  /** Instances the tick skipped because the Worker was down. */
  async stale(staleFloorIso: string): Promise<LiveInstance[]> {
    const r = await this.d1
      .prepare(
        `${INSTANCE_JOIN}
          WHERE i.next_nag_at IS NOT NULL
            AND i.next_nag_at <= ?1
            AND i.state IN ('pending','notified')`,
      )
      .bind(staleFloorIso)
      .all<LiveInstance>();
    return r.results ?? [];
  }

  async hydrate(ids: string[]): Promise<LiveInstance[]> {
    const marks = ids.map((_, i) => `?${i + 1}`).join(",");
    const r = await this.d1
      .prepare(`${INSTANCE_JOIN} WHERE i.id IN (${marks})`)
      .bind(...ids)
      .all<LiveInstance>();
    return r.results ?? [];
  }

  /**
   * Instances that are actually open right now.
   *
   * The scheduled_for filter matters: we materialize 48 hours ahead, so
   * without it "list" and the reply numbering would include reminders that
   * haven't come due yet — and `done 2` would silently acknowledge tomorrow.
   */
  async liveForUser(userId: string, nowIso = iso(Date.now())): Promise<LiveInstance[]> {
    const r = await this.d1
      .prepare(
        `${INSTANCE_JOIN}
          WHERE i.user_id = ?1
            AND i.state IN ('pending','notified')
            AND i.scheduled_for <= ?2
          ORDER BY i.scheduled_for ASC`,
      )
      .bind(userId, nowIso)
      .all<LiveInstance>();
    return r.results ?? [];
  }

  /**
   * Still-to-come instances inside the current local day. The board's "later
   * today" section — deliberately bounded by the day, not by the 48h
   * materialization horizon, or a daily board would show tomorrow twice.
   */
  async upcomingForUser(userId: string, afterIso: string, untilIso: string): Promise<LiveInstance[]> {
    const r = await this.d1
      .prepare(
        `${INSTANCE_JOIN}
          WHERE i.user_id = ?1
            AND i.state IN ('pending','notified')
            AND i.scheduled_for > ?2
            AND i.scheduled_for < ?3
          ORDER BY i.scheduled_for ASC`,
      )
      .bind(userId, afterIso, untilIso)
      .all<LiveInstance>();
    return r.results ?? [];
  }

  /**
   * Everything that reached a terminal state during the local day, for the
   * board's log sections. Includes 'expired': an item that ran out of road
   * today is the single most useful thing a nagging bot can still tell you,
   * and dropping it would make the day's record silently incomplete.
   */
  async settledForUser(userId: string, fromIso: string, untilIso: string): Promise<ClosedInstance[]> {
    const r = await this.d1
      .prepare(
        `SELECT i.id, i.state, i.scheduled_for, t.title, t.timezone
           FROM reminder_instances i
           JOIN tasks t ON t.id = i.task_id
          WHERE i.user_id = ?1
            AND i.state IN ('acknowledged','skipped','expired')
            AND i.scheduled_for >= ?2
            AND i.scheduled_for < ?3
          ORDER BY i.scheduled_for ASC`,
      )
      .bind(userId, fromIso, untilIso)
      .all<ClosedInstance>();
    return r.results ?? [];
  }

  // ---- boards -----------------------------------------------------------

  async board(userId: string, localDate: string): Promise<BoardRow | null> {
    return this.d1
      .prepare(`SELECT * FROM boards WHERE user_id = ?1 AND local_date = ?2`)
      .bind(userId, localDate)
      .first<BoardRow>();
  }

  /** Every board except today's — yesterday's, to be unpinned and forgotten. */
  async staleBoards(userId: string, localDate: string): Promise<BoardRow[]> {
    const r = await this.d1
      .prepare(`SELECT * FROM boards WHERE user_id = ?1 AND local_date <> ?2`)
      .bind(userId, localDate)
      .all<BoardRow>();
    return r.results ?? [];
  }

  async putBoard(row: BoardRow): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO boards (user_id, local_date, chat_id, message_id, fingerprint, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6)
         ON CONFLICT(user_id, local_date) DO UPDATE SET
           chat_id = excluded.chat_id,
           message_id = excluded.message_id,
           fingerprint = excluded.fingerprint,
           updated_at = excluded.updated_at`,
      )
      .bind(row.user_id, row.local_date, row.chat_id, row.message_id, row.fingerprint, row.updated_at)
      .run();
  }

  async setBoardFingerprint(userId: string, localDate: string, fp: string, nowIso: string): Promise<void> {
    await this.d1
      .prepare(
        `UPDATE boards SET fingerprint = ?3, updated_at = ?4
          WHERE user_id = ?1 AND local_date = ?2`,
      )
      .bind(userId, localDate, fp, nowIso)
      .run();
  }

  async deleteBoard(userId: string, localDate: string): Promise<void> {
    await this.d1
      .prepare(`DELETE FROM boards WHERE user_id = ?1 AND local_date = ?2`)
      .bind(userId, localDate)
      .run();
  }

  async setNextNag(id: string, nextIso: string | null): Promise<void> {
    await this.d1
      .prepare(`UPDATE reminder_instances SET next_nag_at = ?2 WHERE id = ?1`)
      .bind(id, nextIso)
      .run();
  }

  /** Terminal transition. Nulling next_nag_at is what actually stops nagging. */
  async terminate(
    id: string,
    state: "acknowledged" | "skipped" | "expired" | "superseded",
    source: string,
  ): Promise<boolean> {
    const r = await this.d1
      .prepare(
        `UPDATE reminder_instances
            SET state = ?2, acknowledged_at = ?3, ack_source = ?4, next_nag_at = NULL
          WHERE id = ?1 AND state IN ('pending','notified')`,
      )
      .bind(id, state, iso(Date.now()), source)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /**
   * Snoozing also pushes give_up_at out. Without this, "snooze 4h" on a policy
   * that gives up after 3h silently kills the reminder — the user explicitly
   * asked to be reminded later and would simply never hear about it again.
   */
  async snooze(id: string, untilMs: number): Promise<boolean> {
    const r = await this.d1
      .prepare(
        `UPDATE reminder_instances
            SET next_nag_at = ?2,
                escalation_step = 0,
                give_up_at = MAX(give_up_at, ?3)
          WHERE id = ?1 AND state IN ('pending','notified')`,
      )
      .bind(id, iso(untilMs), iso(untilMs + 60 * 60_000))
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  // ---- inbound dedupe & confirmations ------------------------------------

  /** Returns false if we've already seen this provider message id. */
  async claimInbound(msg: {
    providerMessageId: string;
    channelKind: string;
    senderId: string;
    text: string;
  }): Promise<boolean> {
    const r = await this.d1
      .prepare(
        `INSERT OR IGNORE INTO inbound_messages
           (provider_message_id, channel_kind, sender_id, body, received_at)
         VALUES (?1,?2,?3,?4,?5)`,
      )
      .bind(msg.providerMessageId, msg.channelKind, msg.senderId, msg.text, iso(Date.now()))
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  async markInboundHandled(providerMessageId: string): Promise<void> {
    await this.d1
      .prepare(`UPDATE inbound_messages SET handled_at = ?2 WHERE provider_message_id = ?1`)
      .bind(providerMessageId, iso(Date.now()))
      .run();
  }

  /** The previous exchange, if recent enough to still be "what we were just
   *  talking about". Stale context is worse than none — a 10-minute-old
   *  message should not silently become the referent of "that". */
  async getDialog(
    userId: string,
    now = Date.now(),
    maxAgeMs = 10 * 60_000,
  ): Promise<{ user: string; bot: string } | null> {
    const row = await this.d1
      .prepare(`SELECT last_user_msg, last_bot_reply, updated_at FROM dialog_state WHERE user_id = ?1`)
      .bind(userId)
      .first<{ last_user_msg: string; last_bot_reply: string; updated_at: string }>();
    if (!row?.last_user_msg) return null;
    if (now - Date.parse(row.updated_at) > maxAgeMs) return null;
    return { user: row.last_user_msg, bot: row.last_bot_reply ?? "" };
  }

  async putDialog(userId: string, userMsg: string, botReply: string): Promise<void> {
    await this.d1
      .prepare(
        `INSERT INTO dialog_state (user_id, last_user_msg, last_bot_reply, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id) DO UPDATE SET
           last_user_msg = excluded.last_user_msg,
           last_bot_reply = excluded.last_bot_reply,
           updated_at = excluded.updated_at`,
      )
      .bind(userId, userMsg.slice(0, 1000), botReply.slice(0, 1000), iso(Date.now()))
      .run();
  }

  async putPendingAction(
    userId: string,
    payload: unknown,
    summary: string,
    ttlMs = 300_000,
    now: number = Date.now(),
  ) {
    await this.d1
      .prepare(
        `INSERT INTO pending_actions (user_id,payload,summary,expires_at)
         VALUES (?1,?2,?3,?4)
         ON CONFLICT(user_id) DO UPDATE SET
           payload = excluded.payload, summary = excluded.summary,
           expires_at = excluded.expires_at`,
      )
      .bind(userId, JSON.stringify(payload), summary, iso(now + ttlMs))
      .run();
  }

  async takePendingAction(
    userId: string,
    now: number = Date.now(),
  ): Promise<{ payload: any; summary: string } | null> {
    const row = await this.d1
      .prepare(`SELECT * FROM pending_actions WHERE user_id = ?1`)
      .bind(userId)
      .first<{ payload: string; summary: string; expires_at: string }>();
    await this.d1.prepare(`DELETE FROM pending_actions WHERE user_id = ?1`).bind(userId).run();
    if (!row) return null;
    if (Date.parse(row.expires_at) < now) return null;
    return { payload: JSON.parse(row.payload), summary: row.summary };
  }
}
