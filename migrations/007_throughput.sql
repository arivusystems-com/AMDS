-- Track 6 Phase 3: dynamic throughput cache

CREATE TABLE IF NOT EXISTS tenant_throughput (
  tenant_id               TEXT PRIMARY KEY,
  max_hourly_rate         INT NOT NULL DEFAULT 0,
  max_burst_rate          INT NOT NULL DEFAULT 0,
  effective_hourly_rate   INT NOT NULL DEFAULT 0,
  effective_burst_rate    INT NOT NULL DEFAULT 0,
  reputation_multiplier   NUMERIC(5,3) NOT NULL DEFAULT 1.000,
  warmup_multiplier       NUMERIC(5,3) NOT NULL DEFAULT 1.000,
  infra_multiplier        NUMERIC(5,3) NOT NULL DEFAULT 1.000,
  combined_multiplier     NUMERIC(5,3) NOT NULL DEFAULT 1.000,
  warmup_stage            TEXT NOT NULL DEFAULT 'not_started',
  reputation_score        NUMERIC(5,2) NOT NULL DEFAULT 70.00,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_throughput_updated
  ON tenant_throughput (updated_at DESC);
