-- Delivery isolation: reputation-tier pools, IP inventory, dedicated assignments, layered limits

-- Drop legacy 2-pool check; expand to purpose × risk tiers
ALTER TABLE ip_pools DROP CONSTRAINT IF EXISTS ip_pools_id_check;

ALTER TABLE ip_pools
  ADD COLUMN IF NOT EXISTS purpose TEXT,
  ADD COLUMN IF NOT EXISTS risk_tier TEXT,
  ADD COLUMN IF NOT EXISTS hourly_send_limit INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_send_limit INTEGER NOT NULL DEFAULT 0;

UPDATE ip_pools SET purpose = 'transaction', risk_tier = 'healthy' WHERE pool_id = 'transaction';
UPDATE ip_pools SET purpose = 'marketing', risk_tier = 'standard' WHERE pool_id = 'marketing';

INSERT INTO ip_pools (pool_id, egress_ip, description, purpose, risk_tier, hourly_send_limit, daily_send_limit)
VALUES
  ('transaction', 'default-tx', 'Transactional / helpdesk mail', 'transaction', 'healthy', 0, 0),
  ('marketing', 'default-mkt', 'Legacy marketing alias → standard', 'marketing', 'standard', 0, 0),
  ('marketing_healthy', 'default-mkt-healthy', 'Marketing healthy reputation pool', 'marketing', 'healthy', 0, 0),
  ('marketing_standard', 'default-mkt-standard', 'Marketing standard reputation pool', 'marketing', 'standard', 0, 0),
  ('marketing_restricted', 'default-mkt-restricted', 'Marketing restricted / quarantine pool', 'marketing', 'restricted', 0, 0)
ON CONFLICT (pool_id) DO UPDATE SET
  purpose = EXCLUDED.purpose,
  risk_tier = EXCLUDED.risk_tier,
  description = COALESCE(ip_pools.description, EXCLUDED.description),
  updated_at = NOW();

ALTER TABLE ip_pools
  ALTER COLUMN purpose SET NOT NULL,
  ALTER COLUMN risk_tier SET NOT NULL;

ALTER TABLE ip_pools DROP CONSTRAINT IF EXISTS ip_pools_purpose_check;
ALTER TABLE ip_pools ADD CONSTRAINT ip_pools_purpose_check
  CHECK (purpose IN ('transaction', 'marketing'));

ALTER TABLE ip_pools DROP CONSTRAINT IF EXISTS ip_pools_risk_tier_check;
ALTER TABLE ip_pools ADD CONSTRAINT ip_pools_risk_tier_check
  CHECK (risk_tier IN ('healthy', 'standard', 'restricted'));

-- Platform IP inventory (pre-attached OCI IPs)
CREATE TABLE IF NOT EXISTS ip_inventory (
  egress_ip       TEXT PRIMARY KEY,
  state           TEXT NOT NULL DEFAULT 'free',
  purpose         TEXT,
  risk_tier       TEXT,
  attached        BOOLEAN NOT NULL DEFAULT true,
  ptr_configured  BOOLEAN NOT NULL DEFAULT false,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ip_inventory_state_check CHECK (
    state IN ('free', 'assigned', 'quarantine', 'warming', 'shared')
  ),
  CONSTRAINT ip_inventory_purpose_check CHECK (
    purpose IS NULL OR purpose IN ('transaction', 'marketing')
  ),
  CONSTRAINT ip_inventory_risk_tier_check CHECK (
    risk_tier IS NULL OR risk_tier IN ('healthy', 'standard', 'restricted')
  )
);

INSERT INTO ip_inventory (egress_ip, state, purpose, risk_tier, attached, notes)
VALUES
  ('default-tx', 'shared', 'transaction', 'healthy', true, 'Shared transactional'),
  ('default-mkt-healthy', 'shared', 'marketing', 'healthy', true, 'Shared marketing healthy'),
  ('default-mkt-standard', 'shared', 'marketing', 'standard', true, 'Shared marketing standard'),
  ('default-mkt', 'shared', 'marketing', 'standard', true, 'Legacy marketing alias'),
  ('default-mkt-restricted', 'shared', 'marketing', 'restricted', true, 'Shared marketing restricted')
ON CONFLICT (egress_ip) DO NOTHING;

-- Dedicated per-tenant egress (tx + marketing)
CREATE TABLE IF NOT EXISTS tenant_egress_assignments (
  tenant_id    TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  egress_ip    TEXT NOT NULL REFERENCES ip_inventory (egress_ip),
  source       TEXT NOT NULL DEFAULT 'dedicated',
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, purpose),
  CONSTRAINT tenant_egress_purpose_check CHECK (purpose IN ('transaction', 'marketing')),
  CONSTRAINT tenant_egress_source_check CHECK (source IN ('dedicated', 'shared_tier'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_egress_ip ON tenant_egress_assignments (egress_ip);

-- Tenant policy override: allow tier pool pins
ALTER TABLE tenant_policies DROP CONSTRAINT IF EXISTS tenant_policies_ip_pool_check;
ALTER TABLE tenant_policies ADD CONSTRAINT tenant_policies_ip_pool_check CHECK (
  ip_pool IS NULL OR ip_pool IN (
    'transaction',
    'marketing',
    'marketing_healthy',
    'marketing_standard',
    'marketing_restricted'
  )
);

-- Provider (MX) rate limit config
CREATE TABLE IF NOT EXISTS provider_rate_limits (
  provider_key       TEXT PRIMARY KEY,
  hourly_send_limit  INTEGER NOT NULL DEFAULT 0,
  description        TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO provider_rate_limits (provider_key, hourly_send_limit, description)
VALUES
  ('gmail', 8000, 'Gmail / Google Workspace'),
  ('microsoft', 8000, 'Outlook / Hotmail / Office365'),
  ('yahoo', 4000, 'Yahoo / AOL'),
  ('other', 0, 'Default / uncapped')
ON CONFLICT (provider_key) DO NOTHING;

-- Last selected pool snapshot on messages (audit)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS egress_ip TEXT,
  ADD COLUMN IF NOT EXISTS ip_pool_id TEXT,
  ADD COLUMN IF NOT EXISTS failure_class TEXT;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_failure_class_check;
ALTER TABLE messages ADD CONSTRAINT messages_failure_class_check CHECK (
  failure_class IS NULL OR failure_class IN ('infra', 'tenant', 'recipient')
);

-- Allow unsubscribe (+ existing admin negative signals if present)
ALTER TABLE reputation_signals DROP CONSTRAINT IF EXISTS reputation_signals_type_check;
ALTER TABLE reputation_signals ADD CONSTRAINT reputation_signals_type_check CHECK (
  signal_type IN (
    'delivered',
    'hard_bounce',
    'soft_bounce',
    'complaint',
    'open',
    'click',
    'unsubscribe',
    'blacklist',
    'spam_trap'
  )
);
