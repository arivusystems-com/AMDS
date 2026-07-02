export type EgressWarmupStage = 'day_1_3' | 'day_4_7' | 'day_8_14' | 'established';

export interface InfraPressureInput {
  queueDepth: number;
  queueDepthThreshold: number;
  smtpFailureRate?: number;
  smtpFailureThreshold?: number;
}

/** Combined infra multiplier from queue depth and SMTP failure pressure. */
export function infraMultiplier(input: InfraPressureInput): number {
  const queueMult = queueDepthMultiplier(input.queueDepth, input.queueDepthThreshold);
  const smtpRate = input.smtpFailureRate ?? 0;
  const smtpThreshold = input.smtpFailureThreshold ?? 0.15;
  const smtpMult = smtpFailureMultiplier(smtpRate, smtpThreshold);
  return Math.min(queueMult, smtpMult);
}

/** @deprecated Use infraMultiplier with InfraPressureInput */
export function queueDepthMultiplier(queueDepth: number, threshold: number): number {
  if (threshold <= 0 || queueDepth <= threshold) {
    return 1;
  }
  if (queueDepth <= threshold * 2) {
    return 0.75;
  }
  if (queueDepth <= threshold * 4) {
    return 0.5;
  }
  return 0.25;
}

export function smtpFailureMultiplier(failureRate: number, threshold: number): number {
  if (threshold <= 0 || failureRate <= threshold) {
    return 1;
  }
  if (failureRate <= threshold * 2) {
    return 0.75;
  }
  if (failureRate <= threshold * 3) {
    return 0.5;
  }
  return 0.25;
}

/** Daily send cap for egress IP warm-up (from BOUNCE-SPIKE runbook). */
export function egressIpDailyCap(daysSinceFirstSend: number): number | null {
  if (daysSinceFirstSend < 0) {
    return 500;
  }
  if (daysSinceFirstSend < 3) {
    return 500;
  }
  if (daysSinceFirstSend < 7) {
    return 2000;
  }
  if (daysSinceFirstSend < 14) {
    return 10_000;
  }
  return null;
}

export function egressWarmupStage(daysSinceFirstSend: number): EgressWarmupStage {
  if (daysSinceFirstSend < 3) {
    return 'day_1_3';
  }
  if (daysSinceFirstSend < 7) {
    return 'day_4_7';
  }
  if (daysSinceFirstSend < 14) {
    return 'day_8_14';
  }
  return 'established';
}

export function computeSmtpFailureRate(successes: number, failures: number): number {
  const total = successes + failures;
  if (total === 0) {
    return 0;
  }
  return failures / total;
}
