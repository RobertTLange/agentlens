// OpenAI service tiers price a request at a multiple of the model's Standard rate.
// Fast (called Priority until July 2026) is 2x. Ultrafast is 3x through
// 2027-02-28 and 6x from 2027-03-01, Pacific time.
// Source: https://developers.openai.com/api/docs/pricing

const FAST_MULTIPLIER = 2;
const ULTRAFAST_PROMO_MULTIPLIER = 3;
const ULTRAFAST_MULTIPLIER = 6;
// 2027-03-01 00:00 PST.
const ULTRAFAST_PROMO_ENDS_MS = Date.parse("2027-03-01T08:00:00Z");

const FAST_TIERS = new Set(["fast", "priority"]);

/** The cost multiplier for a request on `serviceTier`, recorded at `timestampMs`. */
export function serviceTierMultiplier(serviceTier: string, timestampMs: number | null): number {
  const tier = serviceTier.trim().toLowerCase();
  if (FAST_TIERS.has(tier)) return FAST_MULTIPLIER;
  if (tier !== "ultrafast") return 1;
  const promo = timestampMs === null || timestampMs < ULTRAFAST_PROMO_ENDS_MS;
  return promo ? ULTRAFAST_PROMO_MULTIPLIER : ULTRAFAST_MULTIPLIER;
}
