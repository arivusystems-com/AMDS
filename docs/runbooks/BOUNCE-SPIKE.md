# Bounce spike runbook

**Trigger:** Sudden increase in hard bounces, ISP blocks, or complaint rate alerts.

---

## Detect

Monitor these signals:

```bash
curl -s http://<amds-host>:8080/metrics | grep amds_messages_by_status
# Watch status="bounced" rising

# Or query Postgres
SELECT date_trunc('hour', created_at), count(*)
FROM message_events
WHERE event_type = 'bounced'
GROUP BY 1 ORDER BY 1 DESC LIMIT 24;
```

LiteDesk: spike in `message.bounced` webhooks; agents report delivery failures.

---

## Immediate actions (first 15 minutes)

1. **Pause marketing campaigns** — stop new `POST /v1/campaigns/*/messages` from LiteDesk
2. **Transactional mail continues** — do not blanket-disable gateway unless S1
3. **Check suppression growth:**
   ```sql
   SELECT count(*) FROM suppressions WHERE created_at > now() - interval '1 hour';
   ```
4. **Sample bounce diagnostics:**
   ```sql
   SELECT detail->>'diagnostic', count(*)
   FROM message_events
   WHERE event_type = 'bounced' AND created_at > now() - interval '1 hour'
   GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
   ```

---

## Diagnose root cause

| Pattern | Likely cause | Action |
|---------|--------------|--------|
| `550 5.7.1` / blocklist | IP or domain reputation | Pause bulk; check PTR, SPF, DKIM |
| `550 5.1.1` user unknown | Bad list quality | Scrub contacts; suppress in LiteDesk |
| All recipients fail | SMTP/port 25 blocked | OCI egress / unblock ticket |
| Single domain fails | DNS auth broken | Re-verify domain in AMDS |
| Campaign-only | Content / frequency | Reduce volume; review HTML |

---

## Containment

1. Enable stricter rate limits temporarily (`RATE_LIMIT_MAX` env — requires restart)
2. Add problematic domains to manual review before send
3. For hard bounces — AMDS auto-suppresses; LiteDesk syncs via webhook (Track 3)
4. Do **not** delete suppression entries during spike

---

## Recovery

1. Fix root cause (DNS, list quality, IP warm-up)
2. Resume campaigns at reduced volume (10% → 25% → 50% → 100% over days)
3. Monitor `delivery_rate` via `GET /v1/analytics/summary`
4. Confirm complaint rate < 0.1% before full volume
5. Check platform infra pressure: `GET /v1/admin/infra/status` — if `infra.multiplier` < 1, queue backlog or SMTP failures are throttling all tenants
6. Reputation recovery is capped at **5 points/day** above UTC day-start score — expect gradual recovery, not instant restoration

---

## Reputation suspension (< 20)

When tenant reputation drops below 20:

- All sends return `403 reputation_too_low`
- Transactional mail may still work if separately configured with floor — check AMDS policy
- Use `GET /v1/tenants/:id/reputation/guidance` for remediation steps
- Admin may override via `POST /v1/admin/tenants/:id/reputation` (audit logged)

---

## IP warm-up (new egress IP)

When moving to new OCI public IP:

| Day | Max daily volume |
|-----|------------------|
| 1–3 | 500 |
| 4–7 | 2,000 |
| 8–14 | 10,000 |
| 15+ | Normal limits |

Prioritize transactional queue over campaign queue during warm-up.

---

*Related: [INCIDENT.md](./INCIDENT.md) · [BUILD-TO-DEPLOY.md](../BUILD-TO-DEPLOY.md)*
