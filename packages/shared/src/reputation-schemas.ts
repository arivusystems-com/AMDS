import { z } from 'zod';

export const adminReputationOverrideSchema = z.object({
  score: z.coerce.number().min(0).max(100),
  reason: z.string().min(1).max(500),
});

export type AdminReputationOverrideRequest = z.infer<typeof adminReputationOverrideSchema>;

export const simulateComplaintSchema = z.object({
  tenant_id: z.string().min(1).max(128),
  message_id: z.string().uuid(),
  recipient: z.string().email().optional(),
});

export type SimulateComplaintRequest = z.infer<typeof simulateComplaintSchema>;

export const reputationHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(30),
});

export type ReputationHistoryQuery = z.infer<typeof reputationHistoryQuerySchema>;

export const simulateInfraPressureSchema = z.object({
  queue_depth: z.coerce.number().int().min(0).optional(),
  smtp_failure_rate: z.coerce.number().min(0).max(1).optional(),
});

export type SimulateInfraPressureRequest = z.infer<typeof simulateInfraPressureSchema>;

export const recordNegativeSignalSchema = z.object({
  signal_type: z.enum(['blacklist', 'spam_trap']),
  reason: z.string().min(1).max(500),
  message_id: z.string().uuid().optional(),
});

export type RecordNegativeSignalRequest = z.infer<typeof recordNegativeSignalSchema>;
