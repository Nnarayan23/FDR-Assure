export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/**
 * DEMO ASSUMPTION:
 * The default confirmation freshness window is 72 hours.
 * This is configurable and is not claimed to be a legal or banking rule.
 */
function readFreshnessHours(): number {
  const rawValue = process.env.FDR_CONFIRMATION_MAX_AGE_HOURS;

  if (rawValue === undefined || rawValue.trim() === "") {
    return 72;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      "FDR_CONFIRMATION_MAX_AGE_HOURS must be a positive number.",
    );
  }

  return value;
}

export const confirmationMaxAgeHours = readFreshnessHours();

export function isConfirmationFresh(
  confirmedAt: Date,
  now: Date,
): boolean {
  const ageMilliseconds = now.getTime() - confirmedAt.getTime();
  const maxAgeMilliseconds = confirmationMaxAgeHours * 60 * 60 * 1000;

  return (
    Number.isFinite(ageMilliseconds) &&
    ageMilliseconds >= 0 &&
    ageMilliseconds <= maxAgeMilliseconds
  );
}
