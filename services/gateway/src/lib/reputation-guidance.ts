import type { Pool } from 'pg';
import { buildReputationGuidance, type ReputationBreakdown } from '@vmds/shared';
import { getTenantReputation, getReputationHistory } from './reputation-engine.js';

function isBreakdownPopulated(breakdown: unknown): breakdown is ReputationBreakdown {
  if (!breakdown || typeof breakdown !== 'object') {
    return false;
  }
  return Object.keys(breakdown as Record<string, unknown>).length > 0;
}

export async function getReputationGuidance(pool: Pool, tenantId: string) {
  const current = await getTenantReputation(pool, tenantId);
  const history = await getReputationHistory(pool, tenantId, 10);

  const previousEntry = history.find(
    (row) =>
      row.id !== undefined &&
      isBreakdownPopulated(row.breakdown) &&
      row.trigger_signal !== 'admin_override'
  );

  const previousBreakdown = previousEntry?.breakdown as ReputationBreakdown | undefined;
  const { reasons, recommendations } = buildReputationGuidance({
    score: current.score,
    previousScore: current.previous_score,
    breakdown: current.breakdown,
    previousBreakdown: previousBreakdown ?? null,
  });

  return {
    tenant_id: tenantId,
    score: current.score,
    previous_score: current.previous_score,
    delta: Math.round((current.score - current.previous_score) * 100) / 100,
    breakdown: current.breakdown,
    reasons,
    recommendations,
    updated_at: current.updated_at.toISOString(),
  };
}
