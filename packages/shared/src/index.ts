export { loadEnv } from './env.js';
export {
  loadConfig,
  configSchema,
  QUEUE_NAME,
  CAMPAIGN_QUEUE_NAME,
  WEBHOOK_QUEUE_NAME,
} from './config.js';
export type {
  Config,
  MessageStatus,
  MessageEventType,
  SendMessageJob,
  WebhookJob,
  WebhookEvent,
  TenantWebhookEvent,
  MailSendOptions,
  MailOptions,
  MailSendResult,
} from './config.js';
export {
  RetryableSmtpError,
  PermanentSmtpError,
  classifySmtpError,
} from './errors.js';
export { createLogger } from './logger.js';
export type { Logger } from './logger.js';
export {
  sendMessageSchema,
  sendMessageResponseSchema,
} from './schemas.js';
export type { SendMessageRequest, SendMessageResponse } from './schemas.js';
export {
  registerDomainSchema,
  verifyDomainSchema,
  createSuppressionSchema,
  simulateBounceSchema,
} from './domain-schemas.js';
export type {
  RegisterDomainRequest,
  VerifyDomainRequest,
  CreateSuppressionRequest,
  SimulateBounceRequest,
  DnsRecord,
  DomainResponse,
} from './domain-schemas.js';
export {
  parseDsn,
  classifyBounce,
  extractStatusCode,
  extractRecipient,
} from './bounce.js';
export type { BounceClassification, ParsedBounce } from './bounce.js';
export {
  calculateCampaignHealthScore,
  CAMPAIGN_HEALTH_WEIGHTS,
} from './campaign-health.js';
export type {
  CampaignMetricsInput,
  CampaignHealthBreakdown,
  CampaignHealthCalculation,
  CampaignHealthFactor,
  CampaignHealthComponentScore,
} from './campaign-health.js';
export { buildReputationGuidance } from './reputation-guidance.js';
export type {
  GuidanceReason,
  GuidanceReasonStatus,
  GuidanceRecommendation,
  ReputationGuidanceInput,
} from './reputation-guidance.js';
export {
  campaignBatchSchema,
  campaignMessageSchema,
  analyticsSummarySchema,
  campaignHealthQuerySchema,
  trackingSchema,
} from './campaign-schemas.js';
export type {
  CampaignBatchRequest,
  AnalyticsSummaryQuery,
  CampaignHealthQuery,
} from './campaign-schemas.js';
export {
  tenantPolicySchema,
  tenantPolicyResponseSchema,
  creditAllocationSchema,
  sendPolicyViolationReason,
} from './tenant-policy-schemas.js';
export type {
  TenantPolicyInput,
  TenantPolicyResponse,
  CreditAllocationRequest,
  SendPolicyViolationReason,
} from './tenant-policy-schemas.js';
export {
  adminReputationOverrideSchema,
  simulateComplaintSchema,
  reputationHistoryQuerySchema,
  simulateInfraPressureSchema,
  recordNegativeSignalSchema,
} from './reputation-schemas.js';
export type {
  AdminReputationOverrideRequest,
  SimulateComplaintRequest,
  ReputationHistoryQuery,
  SimulateInfraPressureRequest,
  RecordNegativeSignalRequest,
} from './reputation-schemas.js';
export {
  calculateReputationScore,
  applyScoreDeltaCap,
  computeConsistencyScore,
  computeAuthScore,
  REPUTATION_WEIGHTS,
} from './reputation.js';
export type {
  ReputationSignalType,
  ReputationMetricsInput,
  ReputationBreakdown,
  ReputationCalculation,
  ReputationFactor,
  ReputationComponentScore,
} from './reputation.js';
export {
  campaignEstimateQuerySchema,
} from './throughput-schemas.js';
export type { CampaignEstimateQuery } from './throughput-schemas.js';
export { applyDailyRecoveryCap, recoveryHeadroom } from './recovery.js';
export {
  poolForQueue,
  resolvePoolId,
  resolveEgressIpFromConfig,
} from './ip-pools.js';
export type { IpPoolId } from './ip-pools.js';
export {
  reputationMultiplier,
  warmupMultiplier,
  infraMultiplier,
  computeInfraMultiplier,
  queueDepthMultiplier,
  smtpFailureMultiplier,
  egressIpDailyCap,
  egressWarmupStage,
  computeSmtpFailureRate,
  computeEffectiveRate,
  estimateCompletionSeconds,
  formatDuration,
  isMarketingRestricted,
  isSendingSuspended,
} from './throughput.js';
export type { InfraPressureInput, EgressWarmupStage } from './throughput.js';
export type {
  WarmupStage,
  WarmupResult,
  ThroughputMultipliers,
  ThroughputSnapshot,
} from './throughput.js';
export { TRANSPARENT_PNG, extractLinkUrls, injectTrackingHtml } from './tracking.js';
