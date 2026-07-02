import { z } from 'zod';
import { loadEnv } from './env.js';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  AMDS_PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().min(1),
  DATABASE_READ_URL: z.string().optional(),
  REDIS_URL: z.string().min(1),
  SMTP_MODE: z.enum(['mailpit', 'direct']).default('mailpit'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_SECURE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  SMTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  SMTP_RETRY_DELAY_MS: z.coerce.number().int().min(1000).default(5000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().min(1).default(60),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(30).default(15),
  WEBHOOK_RETRY_DELAY_MS: z.coerce.number().int().min(1000).default(60000),
  AMDS_API_KEY: z.string().min(1),
  WEBHOOK_SIGNING_SECRET: z.string().min(1),
  LITEDESK_WEBHOOK_URL: z.string().url().optional(),
  DEFAULT_FROM_EMAIL: z.string().email().default('noreply@localhost.test'),
  DEFAULT_FROM_NAME: z.string().default('AMDS'),
  AMDS_SPF_INCLUDE: z.string().default('amds.local'),
  DKIM_DEFAULT_SELECTOR: z.string().default('amds1'),
  DNS_VERIFY_BYPASS: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  ENFORCE_DOMAIN_VERIFICATION: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  TRACKING_BASE_URL: z.string().url().default('http://localhost:8080'),
  CAMPAIGN_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  TRANSACTION_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  WEBHOOK_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(500).max(120_000).default(800),
  METRICS_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),
  WORKER_METRICS_PORT: z.coerce.number().int().min(1024).max(65535).default(9091),
  TENANT_POLICIES_REQUIRED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  REPUTATION_DEFAULT_SCORE: z.coerce.number().min(0).max(100).default(70),
  REPUTATION_MAX_DELTA: z.coerce.number().min(0.1).max(20).default(5),
  WARMUP_DISABLE_REPUTATION_SCORE: z.coerce.number().min(0).max(100).default(85),
  WARMUP_DISABLE_MIN_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  INFRA_QUEUE_DEPTH_THRESHOLD: z.coerce.number().int().min(1).default(1000),
  TRANSACTION_THROUGHPUT_FLOOR: z.coerce.number().min(0).max(1).default(0.25),
  REPUTATION_MARKETING_MIN: z.coerce.number().min(0).max(100).default(40),
  REPUTATION_SEND_MIN: z.coerce.number().min(0).max(100).default(20),
  REPUTATION_MAX_DAILY_GAIN: z.coerce.number().min(0).max(20).default(5),
  REPUTATION_BLACKLIST_PENALTY: z.coerce.number().min(1).max(50).default(15),
  REPUTATION_SPAM_TRAP_PENALTY: z.coerce.number().min(1).max(50).default(25),
  INFRA_SMTP_FAILURE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.15),
  INFRA_SMTP_WINDOW_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
  EGRESS_IP: z.string().min(1).default('default'),
  EGRESS_IP_TRANSACTION: z.string().optional(),
  EGRESS_IP_MARKETING: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadEnv();
  return configSchema.parse(env);
}

export const QUEUE_NAME = 'amds-transaction';
export const CAMPAIGN_QUEUE_NAME = 'amds-campaign';
export const WEBHOOK_QUEUE_NAME = 'amds-webhook';

export type MessageStatus =
  | 'queued'
  | 'scheduled'
  | 'processing'
  | 'delivered'
  | 'failed'
  | 'dead_letter'
  | 'bounced';

export type MessageEventType =
  | 'queued'
  | 'processing'
  | 'delivery_attempt'
  | 'delivered'
  | 'failed'
  | 'dead_letter'
  | 'webhook_dispatched'
  | 'webhook_failed'
  | 'webhook_exhausted'
  | 'bounced'
  | 'suppressed'
  | 'opened'
  | 'clicked'
  | 'complained';

export interface SendMessageJob {
  messageId: string;
  tenantId: string;
  from: { email: string; name?: string };
  to: Array<{ email: string; name?: string }>;
  subject: string;
  html?: string;
  text?: string;
  metadata?: Record<string, unknown>;
  trackingOpens?: boolean;
  trackingClicks?: boolean;
}

export interface WebhookJob {
  outboxId: string;
  eventId: string;
  messageId: string;
  tenantId: string;
  eventType: WebhookEvent['event_type'];
  payload: WebhookEvent;
  metadata?: Record<string, unknown>;
}

export interface WebhookEvent {
  event_id: string;
  event_type:
    | 'message.delivered'
    | 'message.failed'
    | 'message.bounced'
    | 'message.complained'
    | 'message.opened'
    | 'message.clicked';
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
  bounce?: {
    recipient: string;
    classification: 'hard' | 'soft';
    diagnostic: string;
    status_code: string | null;
  };
  engagement?: {
    recipient?: string;
    url?: string;
    hit_count: number;
  };
}

export interface TenantWebhookEvent {
  event_id: string;
  timestamp: string;
  event_type:
    | 'credit.reserved'
    | 'credit.consumed'
    | 'credit.released'
    | 'policy.limit_exceeded'
    | 'reputation.updated'
    | 'throughput.updated';
  tenant_id: string;
  message_id?: string;
  credit?: {
    amount: number;
    balance_after: number;
    reserved_after: number;
  };
  policy?: {
    reason: string;
    limit?: number;
    remaining?: number;
  };
  reputation?: {
    score: number;
    previous_score: number;
    delta: number;
    factors: Array<{ signal: string; impact: string; message: string }>;
    trigger_signal?: string;
  };
  throughput?: {
    max_hourly_rate: number;
    effective_hourly_rate: number;
    effective_burst_rate: number;
    multipliers: {
      reputation: number;
      warmup: number;
      infra: number;
      combined: number;
      warmup_stage: string;
    };
    reputation_score: number;
  };
}

export interface MailSendOptions {
  from: { email: string; name?: string };
  to: Array<{ email: string; name?: string }>;
  subject: string;
  html?: string;
  text?: string;
  dkim?: {
    domainName: string;
    keySelector: string;
    privateKey: string;
  };
}

/** @deprecated Use MailSendOptions */
export type MailOptions = MailSendOptions;

export interface MailSendResult {
  messageId?: string;
  response: string;
}
