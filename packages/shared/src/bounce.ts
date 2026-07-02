/**
 * Parse a DSN (Delivery Status Notification) MIME body or plain diagnostic text.
 * Returns classification for bounce handling.
 */

export type BounceClassification = 'hard' | 'soft' | 'unknown';

export interface ParsedBounce {
  classification: BounceClassification;
  recipient: string | null;
  diagnostic: string;
  statusCode: string | null;
}

const HARD_STATUS_PREFIXES = ['5.'];
const SOFT_STATUS_PREFIXES = ['4.'];

const HARD_KEYWORDS = [
  'user unknown',
  'mailbox not found',
  'no such user',
  'address rejected',
  'does not exist',
  'invalid recipient',
  'account disabled',
];

const SOFT_KEYWORDS = [
  'mailbox full',
  'try again',
  'temporarily',
  'greylisted',
  'rate limit',
  'service unavailable',
];

export function extractStatusCode(text: string): string | null {
  const match = text.match(/\b([245]\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

export function extractRecipient(text: string): string | null {
  const finalMatch = text.match(/Final-Recipient:\s*rfc822;\s*(\S+)/i);
  if (finalMatch) {
    return finalMatch[1].toLowerCase();
  }

  const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
  return emailMatch ? emailMatch[0].toLowerCase() : null;
}

export function classifyBounce(statusCode: string | null, diagnostic: string): BounceClassification {
  if (statusCode) {
    if (HARD_STATUS_PREFIXES.some((p) => statusCode.startsWith(p))) {
      return 'hard';
    }
    if (SOFT_STATUS_PREFIXES.some((p) => statusCode.startsWith(p))) {
      return 'soft';
    }
  }

  const lower = diagnostic.toLowerCase();
  if (HARD_KEYWORDS.some((k) => lower.includes(k))) {
    return 'hard';
  }
  if (SOFT_KEYWORDS.some((k) => lower.includes(k))) {
    return 'soft';
  }

  return 'unknown';
}

export function parseDsn(content: string): ParsedBounce {
  const diagnostic =
    content.match(/Diagnostic-Code:\s*(?:\S+;\s*)?(.+)/i)?.[1]?.trim() ??
    content.match(/Status:\s*(\S+)/i)?.[1]?.trim() ??
    content.trim().slice(0, 500);

  const statusCode = extractStatusCode(content);
  const recipient = extractRecipient(content);
  const classification = classifyBounce(statusCode, diagnostic);

  return {
    classification: classification === 'unknown' ? 'hard' : classification,
    recipient,
    diagnostic,
    statusCode,
  };
}
