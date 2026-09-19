import { PermanentSmtpError, RetryableSmtpError } from './errors.js';

/** Who/what caused a delivery failure — drives reputation vs infra pressure. */
export type FailureClass = 'infra' | 'tenant' | 'recipient';

export interface ClassifiedDeliveryFailure {
  error: RetryableSmtpError | PermanentSmtpError;
  failureClass: FailureClass;
  retryable: boolean;
}

const INFRA_HINTS = [
  'econnrefused',
  'econnreset',
  'etimedout',
  'timeout',
  'enetunreach',
  'ehostunreach',
  'bind',
  'localaddress',
  'local address',
  'cannot assign requested address',
  'no route to host',
  'socket',
  'network',
  'dns',
  'getaddrinfo',
  'no mx records',
  'egress',
  'not attached',
  'not bindable',
];

const RECIPIENT_HINTS = [
  'user unknown',
  'mailbox unavailable',
  'does not exist',
  'invalid recipient',
  'no such user',
  'recipient rejected',
  'address rejected',
  '5.1.1',
  '5.1.2',
  '5.1.3',
];

const TENANT_HINTS = [
  'spam',
  'blacklist',
  'block list',
  'blocked',
  'policy',
  'reputation',
  'content rejected',
  'message rejected',
  '5.7.1',
  '550 5.7',
];

export function attributeFailureClass(
  err: unknown,
  options?: { bindFailure?: boolean; forcedClass?: FailureClass }
): FailureClass {
  if (options?.forcedClass) {
    return options.forcedClass;
  }
  if (options?.bindFailure) {
    return 'infra';
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  for (const hint of INFRA_HINTS) {
    if (lower.includes(hint)) {
      return 'infra';
    }
  }
  for (const hint of RECIPIENT_HINTS) {
    if (lower.includes(hint)) {
      return 'recipient';
    }
  }
  for (const hint of TENANT_HINTS) {
    if (lower.includes(hint)) {
      return 'tenant';
    }
  }

  // Default permanent SMTP without hints → recipient; retryable → infra pressure only
  if (err instanceof PermanentSmtpError) {
    return 'recipient';
  }
  if (err instanceof RetryableSmtpError) {
    return 'infra';
  }
  return 'infra';
}

export function shouldAffectTenantReputation(failureClass: FailureClass): boolean {
  return failureClass === 'recipient' || failureClass === 'tenant';
}

export function shouldAffectInfraPressure(failureClass: FailureClass): boolean {
  return failureClass === 'infra';
}

export function bounceSignalForFailure(
  failureClass: FailureClass,
  permanent: boolean
): 'hard_bounce' | 'soft_bounce' | null {
  if (!shouldAffectTenantReputation(failureClass)) {
    return null;
  }
  return permanent ? 'hard_bounce' : 'soft_bounce';
}
