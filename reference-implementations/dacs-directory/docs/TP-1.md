# TP-1: testnet no-rate restriction (version 1)

TP-1 is the restriction this Directory applies while completion cannot be
verified on testnet. This file is the definition the code cites
(`metricsProfile: "TP-1"`, manifest `restrictions: ["TP-1"]`). It is versioned
with this repository, so a commit of this repository pins it.

It is measured against the DACS Standard at
[`d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20`](https://github.com/DACS-Agent-commerce/DACS-Standard/tree/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20),
the source revision named by the retained SPEC_PIN.

## Rules

1. Every catalog projection (the listings and seller APIs, listing hints and
   every page) publishes `completionRate`,
   `counterpartyAdjustedCompletionRate`, `counterpartyFaultRate`,
   `averageBuyerRating` and `averageSellerRating` as `null`, with
   `metricsUnavailableReason: "Completion verification unavailable"` and
   `metricsProfile: "TP-1"`. Individual rating values are `null`. Raw signed
   artifacts (`/api/dacs/artifact`) are served as signed so they stay
   inspectable, including the values a signed RatingRecord carries.
2. The listings API accepts only the documented listing filters: `category`,
   `tag`, `credential`, `primaryClaim`, `identityTier`,
   `rail`, `priceMax`, `q`, `profile`, `limit` and `cursor` (the manifest's
   `filters`). Every other API query name returns 400. `/discover` ignores
   unrelated query names, including tracking parameters, while refusing rate,
   score and ranking requests with an explicit notice. That covers the filters
   (`minCompletionRate`, `minRating`, `trackRecord`, `maxFaultRate`, the
   metric names themselves, `reputationScore`) and every sorting or ranking
   parameter.
3. Every public read uses the projection, so a catalog cached by an older
   release is safe to serve.
   Writers read and save the stored catalog, never the
   projection. Unknown `*Rate`, `*Rating` and `*Score` keys are dropped at
   seller, deal and listing level.
4. Observed counts (`completed`, `totalAgreements`, `bundleCount`), currency
   totals and `bundleRefs` are rebuilt together from eligible retained records,
   labelled as observations that do not establish completion or settlement.
5. A listing hint follows this Directory's published schema. A
   missing or malformed cached hint is replaced by one over the listing's
   category and the catalog snapshot window. Its `bundleCount` is always
   rebuilt from the retained records the seller reputation counts
   within the hint's scope and window.

## Contract versions

TP-1 removed two DACS-1 §6.3.6 parameters, so the manifest reports
`dacsDirectoryVersion: "2"` and the OpenAPI document `info.version: "2.0.0"`.
The ListingSummary schema URL is unversioned and is served with a short,
revalidated cache lifetime.

## Declared deviations

In the Standard's `ImplementationDeviation` shape (`spec/CONFORMANCE-PLAN.md`,
IM-5). An open `nonconforming` deviation invalidates any conformance claim for
the affected capability; this Directory makes none for these capabilities. The
`capabilityRefs` are this Directory's own names for its catalog API and its
reputation hints, not `CapabilitySupport` entries of an implementation
manifest; this Directory publishes no manifest.

```json
[
  {
    "id": "tp-1-null-rates-and-refused-rate-filters",
    "capabilityRefs": ["directory-catalog-api", "directory-reputation-hints"],
    "ruleRefs": ["DACS-1-6.3.6", "DACS-5-10.5.3", "DACS-5-10.5.4"],
    "status": "open",
    "effect": "nonconforming",
    "description": "minCompletionRate and minRating return 400 instead of filtering. completionRate and averageSellerRating are null even when bundleCount is positive, and published reputation carries no re-derivable metrics."
  }
]
```
