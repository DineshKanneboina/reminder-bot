-- Default escalation policies.
--
-- Columns are named explicitly: this table gains columns over time (tier), and
-- positional VALUES silently bind to the wrong ones when it does.
--
-- Routing is quiet by default — 'default' and 'gentle' surface on the board and
-- only start nagging once an item has aged past QUIET_AGING_HOURS. Only
-- 'urgent' pushes the moment something comes due.
INSERT OR REPLACE INTO escalation_policies
  (id, user_id, name, ladder_minutes, channel_ladder, give_up_after_minutes, quiet_start, quiet_end, max_concurrent, tier)
VALUES
  ('pol_gentle',  NULL, 'gentle',  '[30,120]',        '["primary","primary"]',                     240, '22:00', '07:00', 4, 'quiet'),
  ('pol_default', NULL, 'default', '[10,20,40,60]',   '["primary","primary","primary","email"]',   180, '22:00', '07:00', 4, 'quiet'),
  ('pol_urgent',  NULL, 'urgent',  '[5,5,10,15,30]',  '["primary","primary","email","sms","sms"]', 120, NULL,    NULL,    6, 'urgent'),
  -- One message, no follow-ups. The empty ladder is what ends the chain after
  -- the first send; give_up_after_minutes then clears it off the board.
  ('pol_notify',  NULL, 'notify',  '[]',              '["primary"]',                               180, '22:00', '07:00', 6, 'notify');
