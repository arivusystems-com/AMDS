/** Cap organic reputation gains within a UTC day to prevent gaming. */
export function applyDailyRecoveryCap(
  proposedScore: number,
  dayStartScore: number,
  maxDailyGain: number
): number {
  if (maxDailyGain <= 0) {
    return proposedScore;
  }
  const maxAllowed = dayStartScore + maxDailyGain;
  return Math.min(proposedScore, maxAllowed);
}

export function recoveryHeadroom(
  currentScore: number,
  dayStartScore: number,
  maxDailyGain: number
): number {
  const maxAllowed = dayStartScore + maxDailyGain;
  return Math.max(0, Math.round((maxAllowed - currentScore) * 100) / 100);
}
