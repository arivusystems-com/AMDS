import { z } from 'zod';
import { loadEnv } from './env.js';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  AMDS_PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_SECURE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  AMDS_API_KEY: z.string().min(1),
  WEBHOOK_SIGNING_SECRET: z.string().min(1),
  LITEDESK_WEBHOOK_URL: z.string().url().optional(),
  DEFAULT_FROM_EMAIL: z.string().email().default('noreply@localhost.test'),
  DEFAULT_FROM_NAME: z.string().default('AMDS'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadEnv();
  return configSchema.parse(env);
}

export const QUEUE_NAME = 'amds-transaction';

export type MessageStatus =
  | 'queued'
  | 'processing'
  | 'delivered'
  | 'failed';

export interface SendMessageJob {
  messageId: string;
  tenantId: string;
  from: { email: string; name?: string };
  to: Array<{ email: string; name?: string }>;
  subject: string;
  html?: string;
  text?: string;
  metadata?: Record<string, unknown>;
}

export interface WebhookEvent {
  event_id: string;
  event_type: 'message.delivered' | 'message.failed';
  timestamp: string;
  tenant_id: string;
  message_id: string;
  metadata?: Record<string, unknown>;
  delivery?: {
    recipient: string;
    smtp_response?: string;
    attempt: number;
    error?: string;
  };
}
