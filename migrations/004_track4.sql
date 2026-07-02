-- Track 4: campaigns, open/click tracking, analytics

CREATE TABLE IF NOT EXISTS campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  message_count   INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns (tenant_id, external_id);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tracking_opens BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tracking_clicks BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_messages_campaign ON messages (campaign_id)
  WHERE campaign_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tracking_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token           TEXT NOT NULL UNIQUE,
  tenant_id       TEXT NOT NULL,
  message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  token_type      TEXT NOT NULL,
  target_url      TEXT,
  hit_count       INT NOT NULL DEFAULT 0,
  first_hit_at    TIMESTAMPTZ,
  last_hit_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracking_tokens_message ON tracking_tokens (message_id);
CREATE INDEX IF NOT EXISTS idx_tracking_tokens_tenant ON tracking_tokens (tenant_id, token_type);
