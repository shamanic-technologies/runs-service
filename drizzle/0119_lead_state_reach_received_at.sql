-- TODAY-MEETINGS-1117: every lead-state Unit a client stated counts on the ledger, whatever its date.
-- received_at = when this ledger first received the reach from lead-service (never moved by a later sync).
-- A reach lead-service serves with NO date counts its Unit on that day; a reach dated before the ledger's
-- first stored day (the first day of spend) counts on that first day (opening balance).
-- Existing rows: the earliest instant we hold for them. Rows whose Unit moves under the new rule are touched
-- (changed_at) so the refresher re-stales the day they now count on.
-- Tiny table (~1.8k rows): boot-window safe.
ALTER TABLE lead_state_reaches ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
UPDATE lead_state_reaches SET received_at = LEAST(changed_at, synced_at, received_at);
--> statement-breakpoint
UPDATE lead_state_reaches SET changed_at = now()
WHERE removed_at IS NULL
  AND (reached_at IS NULL OR reached_at < (SELECT date_trunc('day', MIN(created_at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' FROM runs_costs));
