-- Track 2: message events, dead letter queue, webhook outbox

CREATE TABLE IF NOT EXISTS message_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_events_message_id
  ON message_events (message_id, created_at ASC);

CREATE TABLE IF NOT EXISTS dead_letter_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      UUID NOT NULL UNIQUE REFERENCES messages(id),
  tenant_id       TEXT NOT NULL,
  failure_reason  TEXT NOT NULL,
  attempt_count   INT NOT NULL,
  job_payload     JSONB NOT NULL,
  moved_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_tenant
  ON dead_letter_messages (tenant_id, moved_at DESC);

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        TEXT NOT NULL UNIQUE,
  message_id      UUID NOT NULL REFERENCES messages(id),
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempt_count   INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_pending
  ON webhook_outbox (next_attempt_at ASC)
  WHERE status = 'pending';
