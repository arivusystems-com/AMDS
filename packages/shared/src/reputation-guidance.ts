import type { ReputationBreakdown, ReputationFactor } from './reputation.js';

export type GuidanceReasonStatus = 'passed' | 'failed' | 'warning';

export interface GuidanceReason {
  signal: string;
  status: GuidanceReasonStatus;
  message: string;
  score: number;
  previous_score?: number;
  delta?: number;
}

export interface GuidanceRecommendation {
  priority: 'high' | 'medium' | 'low';
  category: string;
  message: string;
}

export interface ReputationGuidanceInput {
  score: number;
  previousScore: number;
  breakdown: ReputationBreakdown;
  previousBreakdown?: ReputationBreakdown | null;
  factors?: ReputationFactor[];
}

const SIGNAL_LABELS: Record<string, string> = {
  hard_bounce: 'Hard bounce rate',
  complaint: 'Complaint rate',
  delivery: 'Delivery rate',
  open: 'Open engagement',
  click: 'Click engagement',
  authentication: 'Domain authentication',
  consistency: 'Sending consistency',
};

function reasonStatus(score: number): GuidanceReasonStatus {
  if (score >= 70) return 'passed';
  if (score >= 45) return 'warning';
  return 'failed';
}

function reasonMessage(signal: string, score: number, delta?: number): string {
  const label = SIGNAL_LABELS[signal] ?? signal;
  if (delta !== undefined && Math.abs(delta) >= 5) {
    const direction = delta > 0 ? 'improved' : 'declined';
    return `${label} ${direction} (${Math.round(delta)} pts)`;
  }
  if (score >= 70) {
    return `${label} is healthy`;
  }
  if (score >= 45) {
    return `${label} needs attention`;
  }
  return `${label} is hurting sender reputation`;
}

export function buildReputationGuidance(input: ReputationGuidanceInput): {
  reasons: GuidanceReason[];
  recommendations: GuidanceRecommendation[];
} {
  const reasons: GuidanceReason[] = [];
  const signals = Object.keys(input.breakdown) as (keyof ReputationBreakdown)[];

  for (const signal of signals) {
    const current = input.breakdown[signal];
    const previous = input.previousBreakdown?.[signal];
    const delta =
      previous !== undefined ? Math.round((current.score - previous.score) * 100) / 100 : undefined;

    reasons.push({
      signal,
      status: reasonStatus(current.score),
      message: reasonMessage(signal, current.score, delta),
      score: current.score,
      previous_score: previous?.score,
      delta,
    });
  }

  const recommendations = buildRecommendations(input);
  return { reasons, recommendations };
}

function buildRecommendations(input: ReputationGuidanceInput): GuidanceRecommendation[] {
  const recs: GuidanceRecommendation[] = [];
  const { breakdown, score } = input;

  if (score < 20) {
    recs.push({
      priority: 'high',
      category: 'sending_status',
      message: 'Sending is suspended. Contact support to review your account before resuming.',
    });
  } else if (score < 40) {
    recs.push({
      priority: 'high',
      category: 'marketing',
      message: 'Marketing campaigns are restricted. Focus on transactional mail until reputation improves.',
    });
  }

  if (breakdown.hard_bounce.score < 50) {
    recs.push({
      priority: 'high',
      category: 'list_hygiene',
      message: 'Remove invalid or stale addresses. Hard bounces are the largest reputation risk.',
    });
  }

  if (breakdown.complaint.score < 50) {
    recs.push({
      priority: 'high',
      category: 'consent',
      message: 'Review opt-in consent and make unsubscribe links prominent in every marketing message.',
    });
  }

  if (breakdown.authentication.score < 50) {
    recs.push({
      priority: 'medium',
      category: 'authentication',
      message: 'Configure SPF, DKIM, and DMARC for all sending domains.',
    });
  }

  if (breakdown.consistency.score < 50) {
    recs.push({
      priority: 'medium',
      category: 'volume',
      message: 'Avoid sudden send-volume spikes. Ramp campaigns gradually to protect reputation.',
    });
  }

  if (breakdown.open.score < 30) {
    recs.push({
      priority: 'low',
      category: 'content',
      message: 'Test subject lines and preview text to improve open rates.',
    });
  }

  if (breakdown.click.score < 30) {
    recs.push({
      priority: 'low',
      category: 'content',
      message: 'Improve call-to-action placement and relevance to boost click engagement.',
    });
  }

  if (recs.length === 0 && score >= 80) {
    recs.push({
      priority: 'low',
      category: 'maintenance',
      message: 'Reputation is healthy. Keep list hygiene and authentication current.',
    });
  }

  return recs;
}
