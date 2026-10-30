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

test("documented filters and empty queries are accepted on both surfaces", () => {
  for (const surface of ["api", "discovery"] as const) {
    for (const query of ["", "category=score&tag=a&tag=b&limit=5&cursor=c&q=rating", "credential=x&primaryClaim=x&identityTier=1&rail=x&priceMax=5&profile=x"]) {
      assert.equal(unavailableMetricQuery(new URLSearchParams(query), surface), undefined, query);
    }
  }
});

test("discovery ignores unrelated words and tracking names including metric words", () => {
  for (const query of ["operating=1", "integrating=x", "underscore=1", "orderId=3", "filter=generating", "utm_source=x", "utm_campaign=rating", "utm_rating_campaign=x", "utm_sort=x", "directoryName=x"]) {
    assert.equal(unavailableMetricQuery(new URLSearchParams(query), "discovery"), undefined, query);
  }
  for (const query of ["operating=1", "integrating=x", "underscore=1", "orderId=3", "filter=generating"]) {
    assert.match(unavailableMetricQuery(new URLSearchParams(query)) ?? "", /^Unsupported listing query parameter/, query);
  }
});

test("discovery refuses every rate, score and ordering spelling, not only camelCase", () => {
  for (const query of [
    "averagesellerrating=5", "AVERAGESELLERRATING=5", "averagebuyerrating=5", "counterpartyfaultrate=1",
    "counterpartyadjustedcompletionrate=1", "ratings=5", "minRatings=4", "scores=1", "maxrate=1", "minrate=1",
    "sortField=price", "sorting=price", "orderField=price", "order_dir=asc", "orderDir=asc", "sortDesc=1",
    "filter=order%20by", "filter=sort_by",
  ]) {
    const reason = unavailableMetricQuery(new URLSearchParams(query), "discovery");
    assert.match(reason ?? "", /^(?:Rate and score filters|Sorting and ranking) are unavailable/, query);
  }
});

test("discovery refuses metrics and ranking including filter wrapper values", () => {
  for (const query of ["trackRecord=90", "min_rating=4", "completion.rate=1", "filter=completionRate", "filters=rating", "sort=x", "filter=sort", "filter=rank", "filters=orderBy", "filters[sort]=price"]) {
    const reason = unavailableMetricQuery(new URLSearchParams(query), "discovery");
    assert.match(reason ?? "", /^(?:Rate and score filters|Sorting and ranking) are unavailable/, query);
  }
});

test("exported TP-1 metrics and labels describe unverified observations", async () => {
  const policy = await import("../src/catalog/testnetMetricPolicy.js");
  assert.deepEqual(policy.UNAVAILABLE_TESTNET_METRICS, {
    completionRate: null, counterpartyAdjustedCompletionRate: null, counterpartyFaultRate: null,
    averageBuyerRating: null, averageSellerRating: null,
    metricsUnavailableReason: "Completion verification unavailable", metricsProfile: "TP-1",
  });
  assert.equal(policy.CHECKED_BUNDLES_LABEL, "signature-checked bundles; not counted as outcomes");
  assert.deepEqual(policy.OBSERVED_REPUTATION_COUNTS, {
    completedLabel: "Observed completed outcomes, not verified",
    totalAgreementsLabel: "Observed outcomes, not verified",
    observedTransactionalVolumeLabel: "Observed amounts in completed outcomes, not verified completion or settlement",
    transactionCountByCurrencyLabel: "Observed priced completed outcomes, not verified completion or settlement",
  });
});
