-- Track 6 Phase 1: tenant policies, credit ledger, reservations

CREATE TABLE IF NOT EXISTS tenant_policies (
  tenant_id           TEXT PRIMARY KEY,
  status              TEXT NOT NULL DEFAULT 'active',
  monthly_credits     BIGINT NOT NULL DEFAULT 0,
  credits_remaining   BIGINT NOT NULL DEFAULT 0,
  credits_reserved    BIGINT NOT NULL DEFAULT 0,
  daily_send_limit    INT NOT NULL DEFAULT 0,
  max_hourly_rate     INT NOT NULL DEFAULT 0,
  burst_rate_per_min  INT NOT NULL DEFAULT 0,
  max_campaign_size   INT NOT NULL DEFAULT 0,
  warmup_enabled      BOOLEAN NOT NULL DEFAULT true,
  reputation_enabled  BOOLEAN NOT NULL DEFAULT true,
  first_send_at       TIMESTAMPTZ,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_policies_status_check CHECK (status IN ('active', 'suspended'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_policies_status ON tenant_policies (status);

CREATE TABLE IF NOT EXISTS credit_reservations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL,
  message_id  UUID NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  amount      INT NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'reserved',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT credit_reservations_status_check CHECK (status IN ('reserved', 'consumed', 'released'))
);

CREATE INDEX IF NOT EXISTS idx_credit_reservations_tenant
  ON credit_reservations (tenant_id, status);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  amount          INT NOT NULL DEFAULT 1,
  balance_after   BIGINT NOT NULL,
  reserved_after  BIGINT NOT NULL DEFAULT 0,
  detail          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT credit_ledger_action_check CHECK (action IN ('allocate', 'reserve', 'consume', 'release'))
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant ON credit_ledger (tenant_id, created_at DESC);

-- Tenant-level webhooks may not have a message_id
ALTER TABLE webhook_outbox
  ALTER COLUMN message_id DROP NOT NULL;
