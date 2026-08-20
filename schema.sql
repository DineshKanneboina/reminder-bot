-- Reminder bot schema (D1 / SQLite)

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  timezone          TEXT NOT NULL DEFAULT 'America/Chicago',
  default_policy_id TEXT NOT NULL,
  paused_until      TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL REFERENCES users(id),
  kind      TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  priority  INTEGER NOT NULL DEFAULT 0,
  active    INTEGER NOT NULL DEFAULT 1,
  UNIQUE(kind, sender_id)
);

-- tier drives ROUTING; the ladder drives escalation once routing says "push".
--   quiet  — board only until the item ages past QUIET_AGING_HOURS, then ladders
--   notify — one push when due, then nothing (pair with an empty ladder)
--   urgent — pushes the moment it comes due, ladders immediately
-- Quiet is the default: a new policy that says nothing about routing should not
-- start pushing notifications on its own.
CREATE TABLE IF NOT EXISTS escalation_policies (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT REFERENCES users(id),
  name                  TEXT NOT NULL,
  ladder_minutes        TEXT NOT NULL,
  channel_ladder        TEXT NOT NULL,
  give_up_after_minutes INTEGER NOT NULL,
  quiet_start           TEXT,
  quiet_end             TEXT,
  max_concurrent        INTEGER NOT NULL DEFAULT 4,
  tier                  TEXT NOT NULL DEFAULT 'quiet'
);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  notes      TEXT,
  rrule      TEXT NOT NULL,
  dtstart    TEXT NOT NULL,
  local_time TEXT NOT NULL,
  timezone   TEXT NOT NULL,
  policy_id  TEXT NOT NULL REFERENCES escalation_policies(id),
  overlap    TEXT NOT NULL DEFAULT 'supersede',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(active);

CREATE TABLE IF NOT EXISTS reminder_instances (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  user_id         TEXT NOT NULL,
  scheduled_for   TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending',
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  escalation_step INTEGER NOT NULL DEFAULT 0,
  next_nag_at     TEXT,
  give_up_at      TEXT NOT NULL,
  acknowledged_at TEXT,
  ack_source      TEXT,
  UNIQUE(task_id, scheduled_for)
);
-- Partial index: the hot path only ever scans live rows.
CREATE INDEX IF NOT EXISTS idx_instances_due
  ON reminder_instances(next_nag_at) WHERE next_nag_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_instances_user_state
  ON reminder_instances(user_id, state);

CREATE TABLE IF NOT EXISTS inbound_messages (
  provider_message_id TEXT PRIMARY KEY,
  channel_kind        TEXT NOT NULL,
  sender_id           TEXT NOT NULL,
  body                TEXT,
  received_at         TEXT NOT NULL,
  handled_at          TEXT
);

CREATE TABLE IF NOT EXISTS pending_actions (
  user_id    TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  summary    TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Last exchange per user, so follow-ups ("make that in the evening", answers
-- to clarifying questions) can be resolved against what was just discussed.
CREATE TABLE IF NOT EXISTS dialog_state (
  user_id        TEXT PRIMARY KEY,
  last_user_msg  TEXT,
  last_bot_reply TEXT,
  updated_at     TEXT NOT NULL
);

-- One pinned board message per user per local day, edited in place as state
-- changes. Keyed by local_date because the board is a day's log: a new one is
-- posted each morning and the previous day's is unpinned and left as history.
-- `fingerprint` is the hash of the last rendered content — without it every
-- tick would issue an editMessageText that Telegram rejects as unmodified.
CREATE TABLE IF NOT EXISTS boards (
  user_id     TEXT NOT NULL REFERENCES users(id),
  local_date  TEXT NOT NULL,
  chat_id     TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, local_date)
);

-- Standing facts about the owner, injected into nag-time hint prompts. Free
-- text rather than key/value: the consumer is a language model, and "I use Ryse
-- protein" carries more than any schema I'd invent for it would.
CREATE TABLE IF NOT EXISTS preferences (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preferences_user ON preferences(user_id);
