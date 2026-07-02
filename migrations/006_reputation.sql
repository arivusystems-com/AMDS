-- Track 6 Phase 2: sender reputation engine

CREATE TABLE IF NOT EXISTS tenant_reputation (
  tenant_id           TEXT PRIMARY KEY,
  score               NUMERIC(5,2) NOT NULL DEFAULT 70.00,
  previous_score      NUMERIC(5,2) NOT NULL DEFAULT 70.00,
  breakdown           JSONB NOT NULL DEFAULT '{}',
  metrics             JSONB NOT NULL DEFAULT '{}',
  admin_override      BOOLEAN NOT NULL DEFAULT false,
  override_reason     TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reputation_signals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
  signal_type     TEXT NOT NULL,
  detail          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reputation_signals_type_check CHECK (
    signal_type IN ('delivered', 'hard_bounce', 'soft_bounce', 'complaint', 'open', 'click')
  )
);

CREATE INDEX IF NOT EXISTS idx_reputation_signals_tenant_time
  ON reputation_signals (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reputation_signals_tenant_type_time
  ON reputation_signals (tenant_id, signal_type, created_at DESC);

CREATE TABLE IF NOT EXISTS reputation_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  score           NUMERIC(5,2) NOT NULL,
  previous_score  NUMERIC(5,2) NOT NULL,
  delta           NUMERIC(5,2) NOT NULL,
  breakdown       JSONB NOT NULL DEFAULT '{}',
  factors         JSONB NOT NULL DEFAULT '[]',
  trigger_signal  TEXT,
  trigger_message_id UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reputation_history_tenant
  ON reputation_history (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reputation_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  detail          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reputation_events_tenant
  ON reputation_events (tenant_id, created_at DESC);
