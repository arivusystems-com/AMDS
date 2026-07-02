export type WarmupStage =
  | 'disabled'
  | 'not_started'
  | 'day_1'
  | 'week_1'
  | 'week_2'
  | 'week_3'
  | 'established';

export interface WarmupResult {
  multiplier: number;
  stage: WarmupStage;
  active: boolean;
}

export interface ThroughputMultipliers {
  reputation: number;
  warmup: number;
  infra: number;
  combined: number;
  warmup_stage: WarmupStage;
}

export interface ThroughputSnapshot {
  tenant_id: string;
  max_hourly_rate: number;
  max_burst_rate: number;
  effective_hourly_rate: number;
  effective_burst_rate: number;
  multipliers: ThroughputMultipliers;
  reputation_score: number;
  estimated_seconds_per_message: number;
}

/** Reputation multiplier bands from architecture spec. */
export function reputationMultiplier(score: number): number {
  if (score >= 95) return 1;
  if (score >= 90) return 0.9;
  if (score >= 80) return 0.75;
  if (score >= 70) return 0.5;
  if (score >= 60) return 0.3;
  if (score >= 50) return 0.15;
  return 0.05;
}

export function warmupMultiplier(input: {
  firstSendAt: Date | null;
  warmupEnabled: boolean;
  reputationScore: number;
  disableReputationScore: number;
  disableMinDays: number;
  now?: Date;
}): WarmupResult {
  const now = input.now ?? new Date();

  if (!input.warmupEnabled) {
    return { multiplier: 1, stage: 'disabled', active: false };
  }

  if (
    input.firstSendAt &&
    input.reputationScore >= input.disableReputationScore
  ) {
    const daysSinceFirst =
      (now.getTime() - input.firstSendAt.getTime()) / 86_400_000;
    if (daysSinceFirst >= input.disableMinDays) {
      return { multiplier: 1, stage: 'established', active: false };
    }
  }

  if (!input.firstSendAt) {
    return { multiplier: 1, stage: 'not_started', active: false };
  }

  const daysSince = (now.getTime() - input.firstSendAt.getTime()) / 86_400_000;
  if (daysSince < 1) {
    return { multiplier: 0.05, stage: 'day_1', active: true };
  }
  if (daysSince < 7) {
    return { multiplier: 0.2, stage: 'week_1', active: true };
  }
  if (daysSince < 14) {
    return { multiplier: 0.4, stage: 'week_2', active: true };
  }
  if (daysSince < 21) {
    return { multiplier: 0.7, stage: 'week_3', active: true };
  }
  return { multiplier: 1, stage: 'established', active: false };
}

import {
  infraMultiplier as computeInfraMultiplier,
  queueDepthMultiplier,
  smtpFailureMultiplier,
  egressIpDailyCap,
  egressWarmupStage,
  computeSmtpFailureRate,
} from './infra-pressure.js';
export type { InfraPressureInput, EgressWarmupStage } from './infra-pressure.js';
export {
  computeInfraMultiplier,
  queueDepthMultiplier,
  smtpFailureMultiplier,
  egressIpDailyCap,
  egressWarmupStage,
  computeSmtpFailureRate,
};

export function infraMultiplier(queueDepth: number, threshold: number): number {
  return computeInfraMultiplier({
    queueDepth,
    queueDepthThreshold: threshold,
  });
}

export function computeEffectiveRate(
  maxHourly: number,
  multipliers: Pick<ThroughputMultipliers, 'reputation' | 'warmup' | 'infra'>,
  floorMultiplier = 0
): number {
  if (maxHourly <= 0) {
    return 0;
  }
  const combined = Math.max(
    multipliers.reputation * multipliers.warmup * multipliers.infra,
    floorMultiplier
  );
  return Math.max(1, Math.floor(maxHourly * combined));
}

export function estimateCompletionSeconds(
  recipientCount: number,
  effectiveHourlyRate: number
): number | null {
  if (recipientCount <= 0) {
    return 0;
  }
  if (effectiveHourlyRate <= 0) {
    return null;
  }
  return Math.ceil((recipientCount / effectiveHourlyRate) * 3600);
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} seconds`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) {
    return `${minutes} minutes`;
  }
  if (minutes === 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${hours} hour${hours === 1 ? '' : 's'} ${minutes} minutes`;
}

export function isMarketingRestricted(reputationScore: number, minScore: number): boolean {
  return reputationScore < minScore;
}

export function isSendingSuspended(reputationScore: number, minScore: number): boolean {
  return reputationScore < minScore;
}
