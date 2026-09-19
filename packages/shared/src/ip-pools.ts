export type RiskTier = 'healthy' | 'standard' | 'restricted';
export type SendPurpose = 'transaction' | 'marketing';

/** Pool IDs used in ip_pools table. */
export type IpPoolId =
  | 'transaction'
  | 'marketing'
  | 'marketing_healthy'
  | 'marketing_standard'
  | 'marketing_restricted';

export const RISK_TIER_HEALTHY_MIN = 90;
export const RISK_TIER_STANDARD_MIN = 60;
export const RISK_TIER_HYSTERESIS = 3;

export function purposeForQueue(queue: 'transaction' | 'campaign'): SendPurpose {
  return queue === 'campaign' ? 'marketing' : 'transaction';
}

/** @deprecated Prefer purposeForQueue + resolveDeliveryPool */
export function poolForQueue(queue: 'transaction' | 'campaign'): IpPoolId {
  return queue === 'campaign' ? 'marketing' : 'transaction';
}

export function riskTierFromScore(
  score: number,
  previousTier?: RiskTier | null
): RiskTier {
  const healthyMin = RISK_TIER_HEALTHY_MIN;
  const standardMin = RISK_TIER_STANDARD_MIN;
  const h = RISK_TIER_HYSTERESIS;

  if (previousTier === 'healthy') {
    if (score >= healthyMin - h) return 'healthy';
    if (score >= standardMin) return 'standard';
    return 'restricted';
  }
  if (previousTier === 'standard') {
    if (score >= healthyMin + h) return 'healthy';
    if (score >= standardMin - h) return 'standard';
    return 'restricted';
  }
  if (previousTier === 'restricted') {
    if (score >= healthyMin) return 'healthy';
    if (score >= standardMin + h) return 'standard';
    return 'restricted';
  }

  if (score >= healthyMin) return 'healthy';
  if (score >= standardMin) return 'standard';
  return 'restricted';
}

export function poolIdForPurposeTier(purpose: SendPurpose, tier: RiskTier): IpPoolId {
  if (purpose === 'transaction') {
    return 'transaction';
  }
  if (tier === 'healthy') return 'marketing_healthy';
  if (tier === 'restricted') return 'marketing_restricted';
  return 'marketing_standard';
}

export function normalizePoolOverride(pool?: string | null): IpPoolId | null {
  if (!pool) return null;
  if (pool === 'marketing') return 'marketing_standard';
  const allowed: IpPoolId[] = [
    'transaction',
    'marketing',
    'marketing_healthy',
    'marketing_standard',
    'marketing_restricted',
  ];
  return (allowed.includes(pool as IpPoolId) ? pool : null) as IpPoolId | null;
}

/**
 * Resolve logical pool for a send.
 * Priority: dedicated handled by caller → tenant override → purpose+reputation tier.
 */
export function resolvePoolId(
  queue: 'transaction' | 'campaign',
  tenantPool?: IpPoolId | string | null,
  reputationScore = 70,
  previousTier?: RiskTier | null
): IpPoolId {
  const override = normalizePoolOverride(tenantPool ?? null);
  if (override) {
    return override === 'marketing' ? 'marketing_standard' : override;
  }

  const purpose = purposeForQueue(queue);
  if (purpose === 'transaction') {
    return 'transaction';
  }

  const tier = riskTierFromScore(reputationScore, previousTier);
  return poolIdForPurposeTier('marketing', tier);
}

export function resolveEgressIpFromConfig(
  poolId: IpPoolId,
  config: {
    EGRESS_IP: string;
    EGRESS_IP_TRANSACTION?: string;
    EGRESS_IP_MARKETING?: string;
    EGRESS_IP_MARKETING_HEALTHY?: string;
    EGRESS_IP_MARKETING_STANDARD?: string;
    EGRESS_IP_MARKETING_RESTRICTED?: string;
  }
): string {
  if (poolId === 'transaction') {
    return config.EGRESS_IP_TRANSACTION ?? config.EGRESS_IP;
  }
  if (poolId === 'marketing_healthy') {
    return (
      config.EGRESS_IP_MARKETING_HEALTHY ??
      config.EGRESS_IP_MARKETING ??
      config.EGRESS_IP
    );
  }
  if (poolId === 'marketing_restricted') {
    return (
      config.EGRESS_IP_MARKETING_RESTRICTED ??
      config.EGRESS_IP_MARKETING ??
      config.EGRESS_IP
    );
  }
  return (
    config.EGRESS_IP_MARKETING_STANDARD ??
    config.EGRESS_IP_MARKETING ??
    config.EGRESS_IP
  );
}

export function isBindableIp(ip: string): boolean {
  if (!ip || ip.startsWith('default')) {
    return false;
  }
  // IPv4 or IPv6 literal
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.includes(':');
}
