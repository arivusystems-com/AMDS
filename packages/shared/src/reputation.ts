export type ReputationSignalType =
  | 'delivered'
  | 'hard_bounce'
  | 'soft_bounce'
  | 'complaint'
  | 'open'
  | 'click'
  | 'blacklist'
  | 'spam_trap';

export interface ReputationMetricsInput {
  delivered30d: number;
  hardBounce30d: number;
  softBounce30d: number;
  complaint7d: number;
  delivered7d: number;
  open30d: number;
  click30d: number;
  consistencyScore: number;
  authScore: number;
}

export interface ReputationComponentScore {
  rate: number | null;
  score: number;
  weight: number;
}

export interface ReputationBreakdown {
  hard_bounce: ReputationComponentScore;
  complaint: ReputationComponentScore;
  delivery: ReputationComponentScore;
  open: ReputationComponentScore;
  click: ReputationComponentScore;
  authentication: ReputationComponentScore;
  consistency: ReputationComponentScore;
}

export interface ReputationCalculation {
  score: number;
  breakdown: ReputationBreakdown;
  metrics: ReputationMetricsInput;
  factors: ReputationFactor[];
}

export interface ReputationFactor {
  signal: string;
  impact: 'positive' | 'negative' | 'neutral';
  message: string;
}

export const REPUTATION_WEIGHTS = {
  hard_bounce: 0.3,
  complaint: 0.3,
  delivery: 0.15,
  open: 0.1,
  click: 0.05,
  authentication: 0.05,
  consistency: 0.05,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function linearScore(rate: number, goodAt: number, badAt: number): number {
  if (rate <= goodAt) return 100;
  if (rate >= badAt) return 0;
  return clamp(100 - ((rate - goodAt) / (badAt - goodAt)) * 100, 0, 100);
}

export function calculateReputationScore(metrics: ReputationMetricsInput): ReputationCalculation {
  const sendAttempts30d = Math.max(metrics.delivered30d + metrics.hardBounce30d + metrics.softBounce30d, 1);
  const hardBounceRate = metrics.hardBounce30d / sendAttempts30d;
  const complaintRate = metrics.complaint7d / Math.max(metrics.delivered7d, 1);
  const deliveryRate = metrics.delivered30d / sendAttempts30d;
  const openRate = metrics.open30d / Math.max(metrics.delivered30d, 1);
  const clickRate = metrics.click30d / Math.max(metrics.delivered30d, 1);

  const breakdown: ReputationBreakdown = {
    hard_bounce: {
      rate: hardBounceRate,
      score: linearScore(hardBounceRate, 0.005, 0.05),
      weight: REPUTATION_WEIGHTS.hard_bounce,
    },
    complaint: {
      rate: complaintRate,
      score: linearScore(complaintRate, 0.0005, 0.005),
      weight: REPUTATION_WEIGHTS.complaint,
    },
    delivery: {
      rate: deliveryRate,
      score: clamp(deliveryRate * 100, 0, 100),
      weight: REPUTATION_WEIGHTS.delivery,
    },
    open: {
      rate: openRate,
      score: clamp(openRate * 400, 0, 100),
      weight: REPUTATION_WEIGHTS.open,
    },
    click: {
      rate: clickRate,
      score: clamp(clickRate * 800, 0, 100),
      weight: REPUTATION_WEIGHTS.click,
    },
    authentication: {
      rate: null,
      score: clamp(metrics.authScore, 0, 100),
      weight: REPUTATION_WEIGHTS.authentication,
    },
    consistency: {
      rate: null,
      score: clamp(metrics.consistencyScore, 0, 100),
      weight: REPUTATION_WEIGHTS.consistency,
    },
  };

  const rawScore =
    breakdown.hard_bounce.score * breakdown.hard_bounce.weight +
    breakdown.complaint.score * breakdown.complaint.weight +
    breakdown.delivery.score * breakdown.delivery.weight +
    breakdown.open.score * breakdown.open.weight +
    breakdown.click.score * breakdown.click.weight +
    breakdown.authentication.score * breakdown.authentication.weight +
    breakdown.consistency.score * breakdown.consistency.weight;

  const factors = buildFactors(breakdown);

  return {
    score: Math.round(rawScore * 100) / 100,
    breakdown,
    metrics,
    factors,
  };
}

function buildFactors(breakdown: ReputationBreakdown): ReputationFactor[] {
  const factors: ReputationFactor[] = [];

  if (breakdown.hard_bounce.score >= 80) {
    factors.push({ signal: 'hard_bounce', impact: 'positive', message: 'Low hard bounce rate' });
  } else if (breakdown.hard_bounce.score < 50) {
    factors.push({ signal: 'hard_bounce', impact: 'negative', message: 'High hard bounce rate' });
  }

  if (breakdown.complaint.score >= 80) {
    factors.push({ signal: 'complaint', impact: 'positive', message: 'Low complaint rate' });
  } else if (breakdown.complaint.score < 50) {
    factors.push({ signal: 'complaint', impact: 'negative', message: 'Elevated spam complaints' });
  }

  if (breakdown.delivery.score >= 90) {
    factors.push({ signal: 'delivery', impact: 'positive', message: 'Strong delivery rate' });
  }

  if (breakdown.open.score >= 60) {
    factors.push({ signal: 'open', impact: 'positive', message: 'Good open engagement' });
  } else if (breakdown.open.score < 30) {
    factors.push({ signal: 'open', impact: 'negative', message: 'Low open engagement' });
  }

  if (breakdown.authentication.score >= 80) {
    factors.push({ signal: 'authentication', impact: 'positive', message: 'Domain authentication in place' });
  } else if (breakdown.authentication.score < 50) {
    factors.push({ signal: 'authentication', impact: 'negative', message: 'Missing SPF/DKIM/DMARC' });
  }

  if (breakdown.consistency.score >= 70) {
    factors.push({ signal: 'consistency', impact: 'positive', message: 'Consistent sending pattern' });
  } else if (breakdown.consistency.score < 40) {
    factors.push({ signal: 'consistency', impact: 'negative', message: 'Irregular sending spikes' });
  }

  return factors;
}

export function applyScoreDeltaCap(
  previousScore: number,
  newScore: number,
  maxDelta = 5
): number {
  const delta = newScore - previousScore;
  if (Math.abs(delta) <= maxDelta) {
    return newScore;
  }
  return Math.round((previousScore + Math.sign(delta) * maxDelta) * 100) / 100;
}

export function computeConsistencyScore(dailyCounts: number[]): number {
  if (dailyCounts.length === 0) {
    return 70;
  }
  if (dailyCounts.length === 1) {
    return 80;
  }

  const mean = dailyCounts.reduce((a, b) => a + b, 0) / dailyCounts.length;
  if (mean === 0) {
    return 50;
  }

  const variance =
    dailyCounts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / dailyCounts.length;
  const cv = Math.sqrt(variance) / mean;
  return clamp(100 - cv * 100, 0, 100);
}

export function computeAuthScore(input: {
  totalDomains: number;
  fullyVerifiedDomains: number;
  partiallyVerifiedDomains: number;
}): number {
  if (input.totalDomains === 0) {
    return 50;
  }
  const full = input.fullyVerifiedDomains / input.totalDomains;
  const partial = input.partiallyVerifiedDomains / input.totalDomains;
  return clamp(full * 100 + partial * 50, 0, 100);
}
