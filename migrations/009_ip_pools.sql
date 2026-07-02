-- Track 6 Phase 6: dedicated IP pools (transaction vs marketing)

CREATE TABLE IF NOT EXISTS ip_pools (
  pool_id       TEXT PRIMARY KEY,
  egress_ip     TEXT NOT NULL,
  description   TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ip_pools_id_check CHECK (pool_id IN ('transaction', 'marketing'))
);

INSERT INTO ip_pools (pool_id, egress_ip, description)
VALUES
  ('transaction', 'default-tx', 'Transactional / helpdesk mail'),
  ('marketing', 'default-mkt', 'Marketing / campaign mail')
ON CONFLICT (pool_id) DO NOTHING;

ALTER TABLE tenant_policies
  ADD COLUMN IF NOT EXISTS ip_pool TEXT;

ALTER TABLE tenant_policies DROP CONSTRAINT IF EXISTS tenant_policies_ip_pool_check;
ALTER TABLE tenant_policies ADD CONSTRAINT tenant_policies_ip_pool_check CHECK (
  ip_pool IS NULL OR ip_pool IN ('transaction', 'marketing')
);
