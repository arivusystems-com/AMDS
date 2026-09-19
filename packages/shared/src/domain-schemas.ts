import { z } from 'zod';

export const registerDomainSchema = z.object({
  tenant_id: z.string().min(1).max(128),
  domain: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, {
      message: 'Invalid domain name',
    }),
});

export type RegisterDomainRequest = z.infer<typeof registerDomainSchema>;

export const verifyDomainSchema = z.object({
  tenant_id: z.string().min(1).max(128),
});

export type VerifyDomainRequest = z.infer<typeof verifyDomainSchema>;

export const createSuppressionSchema = z.object({
  tenant_id: z.string().min(1).max(128),
  email: z.string().email(),
  reason: z.enum(['hard_bounce', 'complaint', 'manual', 'unsubscribe']).default('manual'),
});

export type CreateSuppressionRequest = z.infer<typeof createSuppressionSchema>;

export const simulateBounceSchema = z.object({
  tenant_id: z.string().min(1).max(128),
  message_id: z.string().uuid(),
  recipient: z.string().email().optional(),
  bounce_type: z.enum(['hard', 'soft']).default('hard'),
  dsn: z.string().optional(),
});

export type SimulateBounceRequest = z.infer<typeof simulateBounceSchema>;

export interface DnsRecord {
  type: 'TXT' | 'CNAME';
  name: string;
  value: string;
  purpose: 'spf' | 'dkim' | 'dmarc';
}

export interface DomainResponse {
  domain: string;
  tenant_id: string;
  status: 'pending' | 'verified';
  dkim_selector: string;
  dns_records: DnsRecord[];
  spf_verified: boolean;
  dkim_verified: boolean;
  dmarc_verified: boolean;
  verified_at: string | null;
  created_at: string;
}
