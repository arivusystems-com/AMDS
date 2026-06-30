import { z } from 'zod';

const addressSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
});

export const sendMessageSchema = z.object({
  idempotency_key: z.string().min(1).max(256),
  tenant_id: z.string().min(1).max(128),
  from: addressSchema,
  to: z.array(addressSchema).min(1).max(50),
  cc: z.array(addressSchema).optional(),
  bcc: z.array(addressSchema).optional(),
  subject: z.string().min(1).max(998),
  content: z
    .object({
      html: z.string().optional(),
      text: z.string().optional(),
    })
    .refine((c) => c.html || c.text, {
      message: 'content.html or content.text is required',
    }),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});

export type SendMessageRequest = z.infer<typeof sendMessageSchema>;

export const sendMessageResponseSchema = z.object({
  message_id: z.string(),
  status: z.literal('queued'),
  queue: z.literal('transaction'),
  created_at: z.string(),
});

export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;
