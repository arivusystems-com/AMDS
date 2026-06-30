-- AMDS initial schema (Phase 0a)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued',
  queue         TEXT NOT NULL DEFAULT 'transaction',
  from_email    TEXT NOT NULL,
  from_name     TEXT,
  to_addresses  JSONB NOT NULL,
  subject       TEXT NOT NULL,
  content_html  TEXT,
  content_text  TEXT,
  metadata      JSONB,
  tags          TEXT[],
  smtp_response TEXT,
  error_message TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at  TIMESTAMPTZ,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_messages_tenant_status ON messages (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    TEXT NOT NULL UNIQUE,
  message_id  UUID NOT NULL REFERENCES messages(id),
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
