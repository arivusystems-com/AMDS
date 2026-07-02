import { z } from 'zod';

export const campaignEstimateQuerySchema = z.object({
  tenant_id: z.string().min(1).max(128),
  recipient_count: z.coerce.number().int().min(1),
});

export type CampaignEstimateQuery = z.infer<typeof campaignEstimateQuerySchema>;
