export type ProviderKey = 'gmail' | 'microsoft' | 'yahoo' | 'other';

const GMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'google.com',
]);

const MICROSOFT_DOMAINS = new Set([
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'office365.com',
]);

const YAHOO_DOMAINS = new Set([
  'yahoo.com',
  'ymail.com',
  'aol.com',
  'rocketmail.com',
]);

export function providerKeyForRecipient(email: string): ProviderKey {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (!domain) return 'other';
  if (GMAIL_DOMAINS.has(domain) || domain.endsWith('.google.com')) return 'gmail';
  if (MICROSOFT_DOMAINS.has(domain) || domain.endsWith('.outlook.com')) return 'microsoft';
  if (YAHOO_DOMAINS.has(domain)) return 'yahoo';
  return 'other';
}

export function computeLayeredHourlyRate(input: {
  tenantEffectiveHourly: number;
  poolHourlyLimit: number;
  ipHourlyLimit: number;
  providerHourlyLimit: number;
  domainHourlyLimit: number;
}): number {
  const caps = [input.tenantEffectiveHourly];
  for (const limit of [
    input.poolHourlyLimit,
    input.ipHourlyLimit,
    input.providerHourlyLimit,
    input.domainHourlyLimit,
  ]) {
    if (limit > 0) {
      caps.push(limit);
    }
  }
  return Math.max(1, Math.min(...caps));
}
