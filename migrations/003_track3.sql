-- Track 3: domains, suppressions, scheduling, bounces

CREATE TABLE IF NOT EXISTS domains (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  domain          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  dkim_selector   TEXT NOT NULL DEFAULT 'amds1',
  dkim_private_key TEXT NOT NULL,
  dkim_public_key TEXT NOT NULL,
  spf_verified    BOOLEAN NOT NULL DEFAULT false,
  dkim_verified   BOOLEAN NOT NULL DEFAULT false,
  dmarc_verified  BOOLEAN NOT NULL DEFAULT false,
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_domains_tenant ON domains (tenant_id);
CREATE INDEX IF NOT EXISTS idx_domains_status ON domains (tenant_id, status);

CREATE TABLE IF NOT EXISTS suppressions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL,
  email             TEXT NOT NULL,
  reason            TEXT NOT NULL,
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_suppressions_tenant ON suppressions (tenant_id, created_at DESC);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
