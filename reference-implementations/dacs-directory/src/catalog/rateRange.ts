/**
 * The values a published rate can take once this pass's undecided sessions are decided (DACS-5 §10.5.1 at run
 * time). An undecided session counts neither as completed nor as failed: once decided it adds nothing (refuted,
 * or neutral for this rate) or one of the contributions its claimed outcomes allow.
 */
export interface RateRange {
  /** The rate with every undecided session that could fail counted as failed and every other one refuted. Null
   * without a decided session in the denominator, so no undecided session can create or raise it. */
  low: number | null;
  /** The rate with every undecided session that could complete counted as completed and every other one refuted.
   * Shown, never used to filter or rank: a party can raise it by leaving sessions undecided. */
  high: number | null;
}

/**
 * Range of `numerator / denominator` over the decided sessions when `both` undecided sessions could each add one to
 * the numerator and the denominator, and `denominatorOnly` could each add one to the denominator alone.
 */
export function rateRange(numerator: number, denominator: number, both: number, denominatorOnly: number): RateRange {
  return {
    low: denominator > 0 ? numerator / (denominator + denominatorOnly) : null,
    high: denominator + both > 0 ? (numerator + both) / (denominator + both) : denominatorOnly > 0 ? 0 : null,
  };
}

/**
 * Range of an average of `count` decided values summing to `sum` when undecided sessions could add up to `added`
 * more, each between `min` and `max`. The low end, like a rate's, needs a decided value.
 */
export function averageRange(sum: number, count: number, added: number, min: number, max: number): RateRange {
  if (added === 0) return count > 0 ? { low: sum / count, high: sum / count } : { low: null, high: null };
  return { low: count > 0 ? (sum + min * added) / (count + added) : null, high: count > 0 ? (sum + max * added) / (count + added) : max };
}

/** The figure a filter or ranking may use: the decided rate or average, or else the range's low end. */
export function rateFloor(rate: number | null | undefined, range: RateRange | undefined): number | null {
  return rate ?? range?.low ?? null;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** A range for a reader, as a clause: "the completion rate is between 0% and 50%". */
export function completionRateRangeText(range: RateRange | undefined): string {
  if (!range || range.high === null) return "no completion rate is verified yet";
  if (range.low === null) return `no completion rate is verified yet; it is at most ${percent(range.high)}`;
  return range.low === range.high ? `the completion rate is ${percent(range.low)}`
    : `the completion rate is between ${percent(range.low)} and ${percent(range.high)}`;
}
