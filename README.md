# VMDS — AMDS (Arivu Mail Delivery System)

Cloud-native outbound email infrastructure for LiteDesk.

**Strategy:** Build everything locally (Mailpit), deploy to OCI once at the end — no third-party SMTP providers. See [docs/BUILD-TO-DEPLOY.md](docs/BUILD-TO-DEPLOY.md). Full architecture: [docs/AMDS-END-TO-END-ROADMAP.md](docs/AMDS-END-TO-END-ROADMAP.md).

## Prerequisites

- **Node.js 20+**
- **Docker Desktop** (Postgres, Redis, Mailpit)

## Quick start (Phase 0a — local)

### 1. One-time setup

```bash
cd VMDS
cp .env.example .env
npm run setup          # install deps, start Docker, run migrations
```

### 2. Start AMDS (two terminals, or one with `npm run dev`)

```bash
# Terminal A — gateway + worker together
npm run dev

# Or separately:
npm run dev:gateway    # http://localhost:8080
npm run dev:worker     # consumes queue → Mailpit
```

### 3. Verify health

```bash
curl http://localhost:8080/health
curl http://localhost:8080/ready
```

### 4. Send a test email

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "Authorization: Bearer amds_dev_key" \
  -H "Content-Type: application/json" \
  -d '{
    "idempotency_key": "test-001",
    "tenant_id": "org_local",
    "from": { "email": "support@localhost.test", "name": "AMDS Test" },
    "to": [{ "email": "user@example.com", "name": "Test User" }],
    "subject": "Hello from AMDS",
    "content": {
      "html": "<h1>It works!</h1><p>Sent via local AMDS → Mailpit.</p>",
      "text": "It works! Sent via local AMDS."
    },
    "metadata": { "litedesk_module": "helpdesk", "litedesk_entity_id": "ticket_1" }
  }'
```

Open **Mailpit** to see the email: [http://localhost:8025](http://localhost:8025)

### 5. Check message status

```bash
curl http://localhost:8080/v1/messages/<message_id> \
  -H "Authorization: Bearer amds_dev_key"
```

### 6. Validate Phase 0a (automated)

With gateway + worker running:

```bash
npm run validate:phase-0a
```

See [docs/PHASE-0A-COMPLETE.md](docs/PHASE-0A-COMPLETE.md) for exit criteria and LiteDesk E2E steps.

## Stop all services

**1. Stop AMDS (gateway + worker)**

If you started with `npm run dev`, press **Ctrl+C** in that terminal.

If gateway and worker run in separate terminals, press **Ctrl+C** in each.

**2. Stop Docker (Postgres, Redis, Mailpit)**

```bash
npm run docker:down
```

Or:

```bash
docker compose down
```

**3. Optional — remove Docker volumes (wipes local DB data)**

```bash
docker compose down -v
```

You will need `npm run db:migrate` again after wiping volumes.

| What | Command |
|------|---------|
| Stop Node only | `Ctrl+C` on `npm run dev` |
| Stop Docker infra | `npm run docker:down` |
| Stop everything | `Ctrl+C` then `npm run docker:down` |
| Stop + wipe DB | `Ctrl+C` then `docker compose down -v` |

## Project structure

```
VMDS/
├── packages/shared/     # Config, types, validation schemas
├── services/gateway/    # Fastify API — POST /v1/messages
├── services/worker/     # Queue consumer — SMTP → Mailpit
├── migrations/          # PostgreSQL schema
├── docker-compose.yml   # Postgres, Redis, Mailpit
└── docs/                # Architecture & roadmap
```

## Development strategy (Option A)

| Phase | Where | SMTP |
|-------|-------|------|
| **Tracks 1–4** (current) | Localhost | Mailpit — no real inbox |
| **Deploy** (final) | OCI | Direct MX delivery (port 25) |

Track 1 (core pipeline) is complete. Next: **Track 2** — retry queue, webhook retries, rate limits. Progress: [docs/BUILD-TO-DEPLOY.md](docs/BUILD-TO-DEPLOY.md).

## LiteDesk integration

Phase 0a is **complete** on both AMDS and LiteDesk. See:

- [docs/LITEDESK-INTEGRATION.md](docs/LITEDESK-INTEGRATION.md) — API contract, webhooks, implementation status
- [docs/PHASE-0A-COMPLETE.md](docs/PHASE-0A-COMPLETE.md) — Track 1 exit criteria

Point LiteDesk at `AMDS_BASE_URL=http://localhost:8080` and matching `AMDS_API_KEY` / `AMDS_WEBHOOK_SECRET`.

## Useful commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start gateway + worker |
| `npm run docker:up` | Start Postgres, Redis, Mailpit |
| `npm run docker:down` | Stop Docker services (Postgres, Redis, Mailpit) |
| `npm run db:migrate` | Apply database migrations |
| `npm run build` | Build all packages |
| `npm run validate:phase-0a` | Run Phase 0a exit validation (gateway + worker must be up) |

**Stop everything:** `Ctrl+C` (Node) then `npm run docker:down` (Docker).

## License

MIT — see [LICENSE](LICENSE).
