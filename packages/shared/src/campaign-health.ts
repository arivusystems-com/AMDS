export interface CampaignMetricsInput {
  total: number;
  delivered: number;
  hardBounced: number;
  softBounced: number;
  complaints: number;
  uniqueOpens: number;
  uniqueClicks: number;
}

export interface CampaignHealthComponentScore {
  rate: number | null;
  score: number;
  weight: number;
}

export interface CampaignHealthBreakdown {
  hard_bounce: CampaignHealthComponentScore;
  complaint: CampaignHealthComponentScore;
  delivery: CampaignHealthComponentScore;
  open: CampaignHealthComponentScore;
  click: CampaignHealthComponentScore;
}

export interface CampaignHealthFactor {
  signal: string;
  impact: 'positive' | 'negative' | 'neutral';
  message: string;
}

export interface CampaignHealthCalculation {
  score: number;
  breakdown: CampaignHealthBreakdown;
  metrics: CampaignMetricsInput;
  factors: CampaignHealthFactor[];
}

export const CAMPAIGN_HEALTH_WEIGHTS = {
  hard_bounce: 0.35,
  complaint: 0.35,
  delivery: 0.15,
  open: 0.1,
  click: 0.05,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function linearScore(rate: number, goodAt: number, badAt: number): number {
  if (rate <= goodAt) return 100;
  if (rate >= badAt) return 0;
  return clamp(100 - ((rate - goodAt) / (badAt - goodAt)) * 100, 0, 100);
}

function buildCampaignFactors(breakdown: CampaignHealthBreakdown): CampaignHealthFactor[] {
  const factors: CampaignHealthFactor[] = [];

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
  } else if (breakdown.delivery.score < 70) {
    factors.push({ signal: 'delivery', impact: 'negative', message: 'Delivery rate below target' });
  }

  if (breakdown.open.score >= 60) {
    factors.push({ signal: 'open', impact: 'positive', message: 'Good open engagement' });
  } else if (breakdown.open.score < 30) {
    factors.push({ signal: 'open', impact: 'negative', message: 'Low open engagement' });
  }

  if (breakdown.click.score >= 50) {
    factors.push({ signal: 'click', impact: 'positive', message: 'Healthy click-through' });
  }

  return factors;
}

export function calculateCampaignHealthScore(
  metrics: CampaignMetricsInput
): CampaignHealthCalculation {
  if (metrics.total === 0) {
    return {
      score: 70,
      breakdown: {
        hard_bounce: { rate: null, score: 70, weight: CAMPAIGN_HEALTH_WEIGHTS.hard_bounce },
        complaint: { rate: null, score: 70, weight: CAMPAIGN_HEALTH_WEIGHTS.complaint },
        delivery: { rate: null, score: 70, weight: CAMPAIGN_HEALTH_WEIGHTS.delivery },
        open: { rate: null, score: 70, weight: CAMPAIGN_HEALTH_WEIGHTS.open },
        click: { rate: null, score: 70, weight: CAMPAIGN_HEALTH_WEIGHTS.click },
      },
      metrics,
      factors: [{ signal: 'sample', impact: 'neutral', message: 'Insufficient campaign data' }],
    };
  }

  const sendAttempts = Math.max(
    metrics.delivered + metrics.hardBounced + metrics.softBounced,
    metrics.total,
    1
  );
  const hardBounceRate = metrics.hardBounced / sendAttempts;
  const complaintRate = metrics.complaints / Math.max(metrics.delivered, 1);
  const deliveryRate = metrics.delivered / sendAttempts;
  const openRate = metrics.uniqueOpens / Math.max(metrics.delivered, 1);
  const clickRate = metrics.uniqueClicks / Math.max(metrics.delivered, 1);

  const breakdown: CampaignHealthBreakdown = {
    hard_bounce: {
      rate: hardBounceRate,
      score: linearScore(hardBounceRate, 0.005, 0.05),
      weight: CAMPAIGN_HEALTH_WEIGHTS.hard_bounce,
    },
    complaint: {
      rate: complaintRate,
      score: linearScore(complaintRate, 0.0005, 0.005),
      weight: CAMPAIGN_HEALTH_WEIGHTS.complaint,
    },
    delivery: {
      rate: deliveryRate,
      score: clamp(deliveryRate * 100, 0, 100),
      weight: CAMPAIGN_HEALTH_WEIGHTS.delivery,
    },
    open: {
      rate: openRate,
      score: clamp(openRate * 400, 0, 100),
      weight: CAMPAIGN_HEALTH_WEIGHTS.open,
    },
    click: {
      rate: clickRate,
      score: clamp(clickRate * 800, 0, 100),
      weight: CAMPAIGN_HEALTH_WEIGHTS.click,
    },
  };

  const rawScore =
    breakdown.hard_bounce.score * breakdown.hard_bounce.weight +
    breakdown.complaint.score * breakdown.complaint.weight +
    breakdown.delivery.score * breakdown.delivery.weight +
    breakdown.open.score * breakdown.open.weight +
    breakdown.click.score * breakdown.click.weight;

  return {
    score: Math.round(rawScore * 100) / 100,
    breakdown,
    metrics,
    factors: buildCampaignFactors(breakdown),
  };
}
