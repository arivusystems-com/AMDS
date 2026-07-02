import { z } from 'zod';

export const tenantPolicySchema = z.object({
  status: z.enum(['active', 'suspended']).default('active'),
  monthly_credits: z.coerce.number().int().min(0).default(0),
  credits_remaining: z.coerce.number().int().min(0).default(0),
  daily_send_limit: z.coerce.number().int().min(0).default(0),
  max_hourly_rate: z.coerce.number().int().min(0).default(0),
  burst_rate_per_min: z.coerce.number().int().min(0).default(0),
  max_campaign_size: z.coerce.number().int().min(0).default(0),
  warmup_enabled: z.boolean().default(true),
  reputation_enabled: z.boolean().default(true),
  ip_pool: z.enum(['transaction', 'marketing']).optional(),
});

export type TenantPolicyInput = z.infer<typeof tenantPolicySchema>;

export const tenantPolicyResponseSchema = tenantPolicySchema.extend({
  tenant_id: z.string(),
  credits_reserved: z.number().int().min(0),
  ip_pool: z.enum(['transaction', 'marketing']).nullable().optional(),
  first_send_at: z.string().nullable(),
  synced_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type TenantPolicyResponse = z.infer<typeof tenantPolicyResponseSchema>;

export const creditAllocationSchema = z.object({
  amount: z.coerce.number().int().positive(),
  reason: z.string().max(500).optional(),
});

export type CreditAllocationRequest = z.infer<typeof creditAllocationSchema>;

export const sendPolicyViolationReason = z.enum([
  'tenant_suspended',
  'policy_not_found',
  'insufficient_credits',
  'daily_limit_exceeded',
  'hourly_limit_exceeded',
  'burst_limit_exceeded',
  'campaign_size_exceeded',
  'reputation_too_low',
  'marketing_restricted',
]);

export type SendPolicyViolationReason = z.infer<typeof sendPolicyViolationReason>;
