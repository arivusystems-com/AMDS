# Track 6 — Sender Reputation & Dynamic Rate Limiting (AMDS Complete)

**Status:** Complete (AMDS local — July 2026)  
**Spec:** [SENDER-REPUTATION-ROADMAP.md](./SENDER-REPUTATION-ROADMAP.md)

---

## Phases

| Phase | Scope | Doc | Validation |
|-------|--------|-----|------------|
| 1 | Tenant policies & credits | [TRACK-6-PHASE1-COMPLETE.md](./TRACK-6-PHASE1-COMPLETE.md) | `npm run validate:track-6a` |
| 2 | Reputation engine | [TRACK-6-PHASE2-COMPLETE.md](./TRACK-6-PHASE2-COMPLETE.md) | `npm run validate:track-6b` |
| 3 | Dynamic throughput & warm-up | [TRACK-6-PHASE3-COMPLETE.md](./TRACK-6-PHASE3-COMPLETE.md) | `npm run validate:track-6c` |
| 4 | Campaign health & guidance | [TRACK-6-PHASE4-COMPLETE.md](./TRACK-6-PHASE4-COMPLETE.md) | `npm run validate:track-6d` |
| 5 | Infra protection & recovery | [TRACK-6-PHASE5-COMPLETE.md](./TRACK-6-PHASE5-COMPLETE.md) | `npm run validate:track-6e` |
| 6 | Enterprise hardening | [TRACK-6-PHASE6-COMPLETE.md](./TRACK-6-PHASE6-COMPLETE.md) | `npm run validate:track-6f` |

**Run all:** `npm run validate:track-6`

---

## LiteDesk integration

Parallel implementation guides:

- [LITEDESK-TRACK-6-PHASE1-DRAFT.md](./LITEDESK-TRACK-6-PHASE1-DRAFT.md) … [PHASE5](./LITEDESK-TRACK-6-PHASE5-DRAFT.md)
- Audit checklist: [LITEDESK-INTEGRATION-AUDIT-CHECKLIST.md](./LITEDESK-INTEGRATION-AUDIT-CHECKLIST.md)

---

## API reference

- OpenAPI: `GET /v1/openapi.yaml` (public)
- Full integration contract: [LITEDESK-INTEGRATION.md](./LITEDESK-INTEGRATION.md)

---

## Not in Track 6 (post-local)

| Item | Notes |
|------|--------|
| OCI production deploy | [BUILD-TO-DEPLOY.md](./BUILD-TO-DEPLOY.md) |
| Live inbound bounce SMTP | Phase 0 prerequisite |
| Live FBL / complaints | Phase 0 prerequisite |
| LiteDesk Track 6 UI | Separate repo |

---

*Last updated: July 2, 2026*
