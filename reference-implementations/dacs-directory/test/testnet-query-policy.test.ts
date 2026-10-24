import assert from "node:assert/strict";
import test from "node:test";
import { unavailableMetricQuery, observedOutcomesLabel } from "../src/catalog/testnetMetricPolicy.js";

test("rate and score filters and ordering return a clear 400 even with empty, repeated or malformed values", async () => {
  for (const query of [
    "minCompletionRate=0.9", "minCompletionRate=0", "minCompletionRate=", "minCompletionRate=bad",
    "minCompletionRate=0.9&minCompletionRate=0.1", "minRating=5", "minRating=", "minRating=bad",
    "trackRecord=90", "maxFaultRate=0.1", "reputationScore=3", "sort=completionRate",
    "sortBy=averageSellerRating", "orderBy=counterpartyFaultRate", "rankBy=reputationScore",
    "MINCOMPLETIONRATE%5B%5D=0.9", "minRating%5B%5D%5B%5D=5", "trackRecord%5B%5D=90",
    "minCompletionRate%5B%5D=", "sort=price", "order=asc", "rank%5B%5D=price",
    "faultRate=0.1", "completionRate=1", "counterpartyAdjustedCompletionRate=1", "counterpartyFaultRate=0",
    "averageBuyerRating=5", "averageSellerRating=5",
    // Every bracketed form and separator spelling names the same refused filter.
    "minCompletionRate%5B0%5D=0.5", "minRating%5Bgte%5D=4", "minRating%5B%5Dx=4", "min_rating=4",
    "min-completion-rate=0.5", "MIN_COMPLETION_RATE=0.5", "sort%5Bby%5D=x", "sort_by=completionRate",
    "order-by=price", "ranking=1",
    // Nested, dotted and suffixed spellings name the same refused filter or ordering.
    "filter%5BminCompletionRate%5D=0.9", "filter%5BminRating%5D=4", "filters%5BtrackRecord%5D=1",
    "page%5Bsort%5D=price", "where%5BcompletionRate%5D%5Bgte%5D=0.5", "minCompletionRate.gte=0.5",
    "min.rating=4", "ratingMin=4", "completionRateMin=0.5", "minAverageSellerRating=4",
  ]) {
    const error = unavailableMetricQuery(new URLSearchParams(query));
    assert.ok(error, query);
    assert.match(error, /unavailable on testnet/, query);
    assert.match(error, /TP-1/, query);
    assert.doesNotMatch(error, /minCompletionRate|MINCOMPLETIONRATE|sort=|order=|rank=/, query);
    if (/^(?:sort|order|rank)/i.test(query)) assert.equal(error, "Sorting and ranking are unavailable on testnet under TP-1.");
  }
});

test("every query name the listings API does not read returns 400, whatever its spelling or value", async () => {
  const sorting = "Sorting and ranking are unavailable on testnet under TP-1.";
  for (const [query, reason] of [
    // Ordering spellings the earlier name list missed.
    ["sortOrder=desc", sorting], ["sortKey=rating", sorting], ["sortDirection=desc", sorting],
    ["direction=desc", sorting], ["sort_dir=asc", sorting], ["orderDirection=desc", sorting], ["dir=asc", sorting],
    // A rate named only in the value of an unknown name.
    ["filter=completionRate", /^Rate and score filters/], ["by=averageSellerRating", /^Rate and score filters/],
    // Names the API never reads: case variants, bracket forms and extensions.
    ["Category=services", /^Unsupported listing query parameter/], ["tag%5B%5D=history", /^Unsupported listing query parameter/],
    ["utm_source=x", /^Unsupported listing query parameter/], ["seller=x", /^Unsupported listing query parameter/],
    ["category=services&top=1", /^Unsupported listing query parameter/],
  ] as const) {
    const error = unavailableMetricQuery(new URLSearchParams(query));
    assert.ok(error, query);
    assert.match(error, /unavailable on testnet under TP-1/, query);
    if (typeof reason === "string") assert.equal(error, reason, query);
    else assert.match(error, reason, query);
    assert.doesNotMatch(error, /sortOrder|sortKey|utm_source|Category=|seller=|top=/, query);
  }
});

test("metric query spellings retain the rate reason and unrelated names retain the unsupported-name reason", async () => {
  const rateReason = "Rate and score filters are unavailable on testnet under TP-1. Completion verification unavailable.";
  const unsupportedReason = "Unsupported listing query parameter. Only the documented listing filters are accepted; " +
    "rate filters, sorting and ranking are unavailable on testnet under TP-1.";
  for (const [query, reason] of [
    ["completionRate=1", rateReason],
    ["min_completion_rate=0.5", rateReason],
    ["completion.rate=1", rateReason],
    ["filter=completion_rate", rateReason],
    ["unsorted=x", unsupportedReason],
    ["directoryName=x", unsupportedReason],
  ]) {
    assert.equal(unavailableMetricQuery(new URLSearchParams(query)), reason, query);
  }
});

test("observed-outcome labels cover an unknown count", () => {
  assert.equal(observedOutcomesLabel(undefined), "Observed outcomes unavailable, not verified");
  assert.equal(observedOutcomesLabel(0), "Observed outcomes: 0, not verified");
  assert.equal(observedOutcomesLabel(3), "Observed outcomes: 3, not verified");
});
