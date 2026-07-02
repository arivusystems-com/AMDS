/** SMTP failure that should be retried (4xx, transient network errors). */
export class RetryableSmtpError extends Error {
  readonly retryable = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RetryableSmtpError';
  }
}

/** SMTP failure that should not be retried (5xx permanent, invalid recipient). */
export class PermanentSmtpError extends Error {
  readonly retryable = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentSmtpError';
  }
}

const RETRYABLE_SMTP_CODES = new Set([
  421, 450, 451, 452, 454,
]);

const PERMANENT_SMTP_CODES = new Set([
  500, 501, 502, 503, 504, 521, 550, 551, 552, 553, 554,
]);

export function classifySmtpError(err: unknown): RetryableSmtpError | PermanentSmtpError {
  const message = err instanceof Error ? err.message : String(err);
  const code = extractSmtpCode(message);

  if (code !== null) {
    if (PERMANENT_SMTP_CODES.has(code)) {
      return new PermanentSmtpError(message, { cause: err });
    }
    if (RETRYABLE_SMTP_CODES.has(code)) {
      return new RetryableSmtpError(message, { cause: err });
    }
    if (code >= 500) {
      return new PermanentSmtpError(message, { cause: err });
    }
    if (code >= 400) {
      return new RetryableSmtpError(message, { cause: err });
    }
  }

  const lower = message.toLowerCase();
  if (
    lower.includes('timeout') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('temporary')
  ) {
    return new RetryableSmtpError(message, { cause: err });
  }

  return new PermanentSmtpError(message, { cause: err });
}

function extractSmtpCode(message: string): number | null {
  const match = message.match(/\b([45]\d{2})\b/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}
