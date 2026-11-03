const CANONICAL_AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
/** A JavaScript number below 100 as text: plain digits, or a negative exponent for tiny values. */
const PERCENT_TEXT = /^(\d+)(?:\.(\d+))?(?:e-(\d+))?$/;

/** An exact decimal: `units` / 10^`scale`. */
interface ScaledDecimal { units: bigint; scale: number }

function scaledAmount(amount: string): ScaledDecimal | undefined {
  if (!CANONICAL_AMOUNT.test(amount)) return undefined;
  const [whole, fraction = ""] = amount.split(".");
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function scaledPercent(minPct: number): ScaledDecimal | undefined {
  if (!Number.isFinite(minPct) || minPct < 0 || minPct >= 100) return undefined;
  const match = PERCENT_TEXT.exec(String(minPct));
  if (!match) return undefined;
  const [, whole, fraction = "", exponent = "0"] = match;
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length + Number(exponent) };
}

/**
 * DACS-3 §8.5.2: the lower bound of a negotiable band, centre x (100 - minPct) / 100,
 * is rounded half-up to the band centre's own number of decimal places and must be
 * positive, or the Agreement validator rejects every Agreement over the Listing.
 * This is the SDK's `negotiablePriceBand` arithmetic (`fixedPrice.ts`), on integers only:
 * the SDK function itself cannot be imported where the browser bundle reaches this code.
 *
 * Returns the reason the band cannot be agreed, or `undefined` when its lower bound is
 * positive. A centre that is not a canonical decimal, or a minPct outside 0 to 100
 * (exclusive), is refused too. Never throws.
 */
export function negotiationBandFloorError(bandCenter: { amount: string }, minPct: number): string | undefined {
  const centre = scaledAmount(bandCenter.amount);
  const percent = scaledPercent(minPct);
  if (!centre || !percent) return "negotiation band needs a canonical positive centre and a minPct from 0 up to (not including) 100";
  const divisor = 100n * 10n ** BigInt(percent.scale);
  const numerator = centre.units * (divisor - percent.units);
  const lowerUnits = numerator / divisor + (numerator % divisor * 2n >= divisor ? 1n : 0n);
  return lowerUnits > 0n
    ? undefined
    : `negotiation band lower bound rounds to zero at the centre's precision (centre ${bandCenter.amount}, minPct ${minPct}); no Agreement could meet it`;
}
