import type { Pool } from 'pg';
import {
  loadConfig,
  type SendPolicyViolationReason,
  isMarketingRestricted,
  isSendingSuspended,
} from '@vmds/shared';
import { getTenantPolicy, type TenantPolicyRow } from './tenant-policies.js';
import {
  checkGlobalRateLimit,
  validatePolicyQuotas,
  consumePolicyQuotas,
  rollbackPolicyCounters,
} from './policy-limits.js';
import { reserveCredit } from './credits.js';
import { dispatchPolicyLimitWebhook } from './tenant-webhooks.js';
import { getTenantReputation } from './reputation-engine.js';
import { getEffectiveLimits } from './throughput-engine.js';

export type SendQueueType = 'transaction' | 'campaign';

export interface SendPolicyCheckResult {
  allowed: boolean;
  reason?: SendPolicyViolationReason;
  httpStatus?: number;
  body?: Record<string, unknown>;
  retryAfterSec?: number;
  policyRequired?: boolean;
  policy?: TenantPolicyRow;
}

function violationResponse(
  reason: SendPolicyViolationReason,
  detail: Record<string, unknown>,
  retryAfterSec?: number
): SendPolicyCheckResult {
  const statusMap: Record<SendPolicyViolationReason, number> = {
    tenant_suspended: 403,
    policy_not_found: 403,
    insufficient_credits: 402,
    daily_limit_exceeded: 429,
    hourly_limit_exceeded: 429,
    burst_limit_exceeded: 429,
    campaign_size_exceeded: 422,
    reputation_too_low: 403,
    marketing_restricted: 403,
  };

  return {
    allowed: false,
    reason,
    httpStatus: statusMap[reason],
    body: { error: reason, ...detail },
    retryAfterSec,
  };
}

export async function validateSendPolicy(
  pool: Pool,
  tenantId: string,
  options: {
    batchSize?: number;
    incrementBy?: number;
    queue?: SendQueueType;
  } = {}
): Promise<SendPolicyCheckResult> {
  const config = loadConfig();
  const policy = await getTenantPolicy(pool, tenantId);

  if (!policy) {
    if (config.TENANT_POLICIES_REQUIRED) {
      return violationResponse('policy_not_found', { tenant_id: tenantId });
    }
    return { allowed: true, policyRequired: false };
  }

  if (policy.reputation_enabled) {
    const reputation = await getTenantReputation(pool, tenantId);
    if (isSendingSuspended(reputation.score, config.REPUTATION_SEND_MIN)) {
      return {
        ...violationResponse('reputation_too_low', {
          reputation_score: reputation.score,
          minimum_score: config.REPUTATION_SEND_MIN,
        }),
        policy,
      };
    }
    if (
      options.queue === 'campaign' &&
      isMarketingRestricted(reputation.score, config.REPUTATION_MARKETING_MIN)
    ) {
      return {
        ...violationResponse('marketing_restricted', {
          reputation_score: reputation.score,
          minimum_score: config.REPUTATION_MARKETING_MIN,
        }),
        policy,
      };
    }
  }

  const effective = await getEffectiveLimits(pool, tenantId, {
    queueType: options.queue ?? 'transaction',
  });
  const limits = await validatePolicyQuotas(policy, {
    ...options,
    effectiveHourly: effective?.hourly,
    effectiveBurst: effective?.burst,
  });
  if (!limits.allowed && limits.reason) {
    void dispatchPolicyLimitWebhook({
      tenant_id: tenantId,
      reason: limits.reason,
      limit: limits.limit,
      remaining: limits.remaining,
    });
    return {
      ...violationResponse(
        limits.reason,
        {
          remaining: limits.remaining,
          limit: limits.limit,
          credits_remaining: policy.credits_remaining,
        },
        limits.retryAfterSec
      ),
      policy,
    };
  }

  return { allowed: true, policyRequired: true, policy };
}

export async function acceptSendMessage(
  pool: Pool,
  tenantId: string,
  messageId: string,
  policyRequired: boolean,
  policy?: TenantPolicyRow,
  options: { queue?: SendQueueType } = {}
): Promise<SendPolicyCheckResult> {
  if (!policyRequired) {
    const global = await checkGlobalRateLimit(tenantId);
    if (!global.allowed) {
      return violationResponse(
        'burst_limit_exceeded',
        { remaining: global.remaining, limit: global.limit },
        global.retryAfterSec
      );
    }
    return { allowed: true, policyRequired: false };
  }

  if (!policy) {
    policy = (await getTenantPolicy(pool, tenantId)) ?? undefined;
  }
  if (!policy) {
    return violationResponse('policy_not_found', { tenant_id: tenantId });
  }

  const result = await reserveCredit(pool, tenantId, messageId, 1);
  if (!result.ok) {
    return violationResponse('insufficient_credits', {
      credits_remaining: policy.credits_remaining,
    });
  }

  const effective = await getEffectiveLimits(pool, tenantId, {
    queueType: options.queue ?? 'transaction',
  });
  await consumePolicyQuotas(policy, 1, effective ?? undefined);
  return { allowed: true, policyRequired: true, policy };
}

export async function rollbackAcceptedSend(
  pool: Pool,
  tenantId: string,
  messageId: string,
  policy?: TenantPolicyRow
): Promise<void> {
  const { releaseCredit } = await import('./credits.js');
  await releaseCredit(pool, tenantId, messageId);
  const resolvedPolicy = policy ?? (await getTenantPolicy(pool, tenantId));
  if (resolvedPolicy) {
    await rollbackPolicyCounters(resolvedPolicy, 1);
  }
}
