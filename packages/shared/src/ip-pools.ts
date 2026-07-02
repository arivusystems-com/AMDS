export type IpPoolId = 'transaction' | 'marketing';

export function poolForQueue(queue: 'transaction' | 'campaign'): IpPoolId {
  return queue === 'campaign' ? 'marketing' : 'transaction';
}

export function resolvePoolId(
  queue: 'transaction' | 'campaign',
  tenantPool?: IpPoolId | null
): IpPoolId {
  return tenantPool ?? poolForQueue(queue);
}

export function resolveEgressIpFromConfig(
  poolId: IpPoolId,
  config: {
    EGRESS_IP: string;
    EGRESS_IP_TRANSACTION?: string;
    EGRESS_IP_MARKETING?: string;
  }
): string {
  if (poolId === 'transaction') {
    return config.EGRESS_IP_TRANSACTION ?? config.EGRESS_IP;
  }
  return config.EGRESS_IP_MARKETING ?? config.EGRESS_IP;
}
