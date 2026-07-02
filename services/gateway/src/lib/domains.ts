import { generateKeyPairSync } from 'node:crypto';
import { loadConfig, type DnsRecord } from '@vmds/shared';

export interface DkimKeyPair {
  privateKey: string;
  publicKey: string;
  selector: string;
}

export function generateDkimKeyPair(selector?: string): DkimKeyPair {
  const config = loadConfig();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const publicKeyBase64 = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');

  return {
    privateKey,
    publicKey: publicKeyBase64,
    selector: selector ?? config.DKIM_DEFAULT_SELECTOR,
  };
}

export function buildDnsRecords(
  domain: string,
  dkimSelector: string,
  dkimPublicKey: string
): DnsRecord[] {
  const config = loadConfig();
  const spfInclude = config.AMDS_SPF_INCLUDE;

  return [
    {
      type: 'TXT',
      name: '@',
      value: `v=spf1 include:${spfInclude} ~all`,
      purpose: 'spf',
    },
    {
      type: 'TXT',
      name: `${dkimSelector}._domainkey`,
      value: `v=DKIM1; k=rsa; p=${dkimPublicKey}`,
      purpose: 'dkim',
    },
    {
      type: 'TXT',
      name: '_dmarc',
      value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
      purpose: 'dmarc',
    },
  ];
}

export function normalizeTxtRecord(records: string[][]): string {
  return records.flat().join('').replace(/\s+/g, '');
}

export async function verifyDomainDns(
  domain: string,
  dkimSelector: string,
  dkimPublicKey: string
): Promise<{ spf: boolean; dkim: boolean; dmarc: boolean }> {
  const dns = await import('node:dns/promises');
  const config = loadConfig();

  if (config.DNS_VERIFY_BYPASS) {
    return { spf: true, dkim: true, dmarc: true };
  }

  let spf = false;
  let dkim = false;
  let dmarc = false;

  try {
    const txtRecords = await dns.resolveTxt(domain);
    const normalized = txtRecords.map((r) => normalizeTxtRecord([r]));
    spf = normalized.some(
      (t) => t.includes('v=spf1') && t.includes(config.AMDS_SPF_INCLUDE)
    );
  } catch {
    spf = false;
  }

  try {
    const dkimHost = `${dkimSelector}._domainkey.${domain}`;
    const dkimRecords = await dns.resolveTxt(dkimHost);
    const normalized = dkimRecords.map((r) => normalizeTxtRecord([r]));
    const keyFragment = dkimPublicKey.slice(0, 32);
    dkim = normalized.some((t) => t.includes('v=DKIM1') && t.includes(keyFragment));
  } catch {
    dkim = false;
  }

  try {
    const dmarcRecords = await dns.resolveTxt(`_dmarc.${domain}`);
    const normalized = dmarcRecords.map((r) => normalizeTxtRecord([r]));
    dmarc = normalized.some((t) => t.startsWith('v=DMARC1'));
  } catch {
    dmarc = false;
  }

  return { spf, dkim, dmarc };
}
