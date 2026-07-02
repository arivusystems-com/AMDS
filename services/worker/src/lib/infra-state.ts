import { loadConfig, computeSmtpFailureRate, computeInfraMultiplier } from '@vmds/shared';
import { getRedis } from './redis.js';

const SIM_QUEUE_KEY = 'infra:simulate:queue_depth';
const SIM_SMTP_KEY = 'infra:simulate:smtp_failure_rate';

function utcMinuteKey(offsetMinutes = 0): string {
  const now = new Date(Date.now() + offsetMinutes * 60_000);
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
}

export async function recordSmtpOutcome(success: boolean): Promise<void> {
  const redis = getRedis();
  const key = `infra:smtp:${success ? 'ok' : 'fail'}:${utcMinuteKey()}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 7200);
  }
}

async function getSmtpFailureRate(): Promise<number> {
  const config = loadConfig();
  const redis = getRedis();

  const simulated = await redis.get(SIM_SMTP_KEY);
  if (simulated !== null) {
    return Number.parseFloat(simulated);
  }

  let successes = 0;
  let failures = 0;
  for (let i = 0; i < config.INFRA_SMTP_WINDOW_MINUTES; i++) {
    const minute = utcMinuteKey(-i);
    successes += Number.parseInt((await redis.get(`infra:smtp:ok:${minute}`)) ?? '0', 10);
    failures += Number.parseInt((await redis.get(`infra:smtp:fail:${minute}`)) ?? '0', 10);
  }

  return computeSmtpFailureRate(successes, failures);
}

async function getSimulatedQueueDepth(): Promise<number | null> {
  const redis = getRedis();
  const value = await redis.get(SIM_QUEUE_KEY);
  return value !== null ? Number.parseInt(value, 10) : null;
}

export async function resolveInfraMultiplier(queueDepth = 0): Promise<number> {
  const config = loadConfig();
  const simulatedDepth = await getSimulatedQueueDepth();
  const smtpRate = await getSmtpFailureRate();

  return computeInfraMultiplier({
    queueDepth: simulatedDepth ?? queueDepth,
    queueDepthThreshold: config.INFRA_QUEUE_DEPTH_THRESHOLD,
    smtpFailureRate: smtpRate,
    smtpFailureThreshold: config.INFRA_SMTP_FAILURE_THRESHOLD,
  });
}
