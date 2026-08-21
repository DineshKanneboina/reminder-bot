export interface Env {
  DB: D1Database;

  // Channels
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM?: string;

  // Parser
  ANTHROPIC_API_KEY?: string;
  PARSER_MODEL?: string;

  // Ops
  HEARTBEAT_URL?: string;
  ACK_SIGNING_KEY?: string;
  PUBLIC_URL?: string;
  BOOTSTRAP_TOKEN?: string;
  MATERIALIZE_HORIZON_HOURS?: string;
  STALE_FLOOR_HOURS?: string;

  /**
   * Workers AI, for nag-time hints. Deliberately a binding rather than an API
   * key: the send path must not depend on a paid key or anything off-platform.
   * Typed structurally so it doesn't pin a @cloudflare/workers-types version.
   */
  AI?: { run(model: string, inputs: Record<string, unknown>): Promise<unknown> };
  /** "0" disables hints even when AI is bound. */
  HINTS_ENABLED?: string;
  HINT_MODEL?: string;
  /** Max hints generated in one tick. Default 3. */
  HINT_BUDGET_PER_TICK?: string;
  /** How long a hint may take before the nag goes without one. Default 3000. */
  HINT_TIMEOUT_MS?: string;

  // Board & routing
  /** "0" disables the daily board entirely. Anything else (or unset) enables it. */
  BOARD_ENABLED?: string;
  /** Local HH:MM at which an otherwise-empty board is posted. Default 07:00. */
  BOARD_HOUR?: string;
  /** How long a quiet item sits on the board before it starts nagging. Default 4. */
  QUIET_AGING_HOURS?: string;
}

export type ChannelKind = "telegram" | "whatsapp" | "sms" | "email";

export type InstanceState =
  | "pending"
  | "notified"
  | "acknowledged"
  | "expired"
  | "superseded"
  | "skipped";

export interface UserRow {
  id: string;
  timezone: string;
  default_policy_id: string;
  paused_until: string | null;
  created_at: string;
}

export interface ChannelRow {
  id: string;
  user_id: string;
  kind: ChannelKind;
  sender_id: string;
  priority: number;
  active: number;
}

/**
 * How an item is ROUTED when it comes due, independent of how it escalates
 * afterwards. See the schema comment on escalation_policies.
 */
export type PolicyTier = "quiet" | "notify" | "urgent";

export interface PolicyRow {
  id: string;
  user_id: string | null;
  name: string;
  ladder_minutes: string; // JSON number[]
  channel_ladder: string; // JSON string[]  ("primary" | ChannelKind)
  give_up_after_minutes: number;
  quiet_start: string | null;
  quiet_end: string | null;
  max_concurrent: number;
  tier: PolicyTier;
}

export interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  rrule: string;
  dtstart: string;
  local_time: string;
  timezone: string;
  policy_id: string;
  overlap: "supersede" | "stack";
  active: number;
  created_at: string;
  updated_at: string;
}

export interface InstanceRow {
  id: string;
  task_id: string;
  user_id: string;
  scheduled_for: string;
  state: InstanceState;
  attempt_count: number;
  escalation_step: number;
  next_nag_at: string | null;
  give_up_at: string;
  acknowledged_at: string | null;
  ack_source: string | null;
}

/** An instance joined to the fields we need to render, route and escalate it. */
export interface LiveInstance extends InstanceRow {
  title: string;
  /** The task's what/why, if captured. Feeds the nag-time hint. */
  notes: string | null;
  /** Needed for routing: a one-off is a chosen moment, not a standing habit. */
  rrule: string;
  local_time: string;
  timezone: string;
  ladder_minutes: string;
  channel_ladder: string;
  quiet_start: string | null;
  quiet_end: string | null;
  give_up_after_minutes: number;
  max_concurrent: number;
  tier: PolicyTier;
}

/** A closed-out instance, for the "done today" section of the board. */
export interface ClosedInstance {
  id: string;
  title: string;
  state: InstanceState;
  scheduled_for: string;
  timezone: string;
}

/** One standing fact about the owner, fed to hint prompts verbatim. */
export interface PreferenceRow {
  id: string;
  user_id: string;
  text: string;
  created_at: string;
}

export interface BoardRow {
  user_id: string;
  local_date: string;
  chat_id: string;
  message_id: string;
  fingerprint: string;
  updated_at: string;
}

/** Normalized inbound message — every channel adapter produces this shape. */
export interface InboundMessage {
  channelKind: ChannelKind;
  senderId: string;
  text: string;
  providerMessageId: string;
  /** Set when the user tapped a button; carries the exact instance id. */
  actionPayload?: string;
  receivedAt: number;
}

export interface OutboundAction {
  label: string;
  payload: string;
}
