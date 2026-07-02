-- Track 6 Phase 5: infrastructure protection & egress IP warm-up

CREATE TABLE IF NOT EXISTS egress_ip_state (
  ip_address      TEXT PRIMARY KEY,
  first_send_at   TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_egress_ip_state_first_send
  ON egress_ip_state (first_send_at);

ALTER TABLE reputation_signals DROP CONSTRAINT IF EXISTS reputation_signals_type_check;
ALTER TABLE reputation_signals ADD CONSTRAINT reputation_signals_type_check CHECK (
  signal_type IN (
    'delivered', 'hard_bounce', 'soft_bounce', 'complaint', 'open', 'click',
    'blacklist', 'spam_trap'
  )
);
