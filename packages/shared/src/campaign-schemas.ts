import { z } from 'zod';

const addressSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
});

const contentSchema = z
  .object({
    html: z.string().optional(),
    text: z.string().optional(),
  })
  .refine((c) => c.html || c.text, {
    message: 'content.html or content.text is required',
  });

export const trackingSchema = z.object({
  opens: z.boolean().default(false),
  clicks: z.boolean().default(false),
});

export const campaignMessageSchema = z.object({
  idempotency_key: z.string().min(1).max(256),
  to: z.array(addressSchema).min(1).max(1),
  subject: z.string().min(1).max(998),
  content: contentSchema,
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});

export const campaignBatchSchema = z.object({
  tenant_id: z.string().min(1).max(128),
  from: addressSchema,
  messages: z.array(campaignMessageSchema).min(1).max(500),
  tracking: trackingSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type CampaignBatchRequest = z.infer<typeof campaignBatchSchema>;

export const analyticsSummarySchema = z.object({
  tenant_id: z.string().min(1).max(128),
  campaign_id: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export type AnalyticsSummaryQuery = z.infer<typeof analyticsSummarySchema>;

export const campaignHealthQuerySchema = z.object({
  tenant_id: z.string().min(1).max(128),
});

export type CampaignHealthQuery = z.infer<typeof campaignHealthQuerySchema>;
