# TP-1: testnet no-rate restriction (version 1)

TP-1 is the restriction this Directory applies while completion cannot be
verified on testnet. This file is the definition the code cites
(`metricsProfile: "TP-1"`, manifest `restrictions: ["TP-1"]`). It is versioned
with this repository, so a commit of this repository pins it.

It is measured against the DACS Standard at
[`d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20`](https://github.com/DACS-Agent-commerce/DACS-Standard/tree/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20),
the revision the pinned SDK declares.

## Rules

1. Every public surface publishes `completionRate`,
   `counterpartyAdjustedCompletionRate`, `counterpartyFaultRate`,
   `averageBuyerRating` and `averageSellerRating` as `null`, with
   `metricsUnavailableReason: "Completion verification unavailable"` and
   `metricsProfile: "TP-1"`. Individual rating values are `null`.
2. Rate and score filters (`minCompletionRate`, `minRating`, `trackRecord`,
   `maxFaultRate`, the metric names themselves, `reputationScore`) and
   sorting or ranking parameters return 400.
3. The projection runs on every read, so a catalog cached by an older release
   is safe to serve. Writers read and save the stored catalog, never the
   projection. Unknown `*Rate`, `*Rating` and `*Score` keys are dropped at
   seller, deal and listing level.
4. Observed counts (`completed`, `totalAgreements`, `bundleCount`), currency
   totals and `bundleRefs` are rebuilt together from eligible retained records,
   labelled as observations that do not establish completion or settlement.
   Records without the current `settlementProjectionVersion` contribute to
   neither seller aggregates nor listing hints until a successful reindex.
   Saving an older catalog does not upgrade its records.
5. A listing hint keeps the shape the pinned SDK catalog reader requires. A
   missing or malformed cached hint is replaced by one over the listing's
   category and the catalog snapshot window. Its `bundleCount` is always
   recomputed on read from the retained records the seller reputation counts
   (the settlement rule below), within the hint's scope and window.

## Contract versions

TP-1 removed two DACS-1 §6.3.6 parameters, so the manifest reports
`dacsDirectoryVersion: "2"` and the OpenAPI document `info.version: "2.0.0"`.
The ListingSummary schema URL is unversioned and is served with a short,
revalidated cache lifetime.

## Declared deviations

In the Standard's `ImplementationDeviation` shape (`spec/CONFORMANCE-PLAN.md`,
IM-5). An open `nonconforming` deviation invalidates any conformance claim for
the affected capability; this Directory makes none for these capabilities.

```json
[
  {
    "id": "tp-1-null-rates-and-refused-rate-filters",
    "capabilityRefs": ["directory-catalog-api", "directory-reputation-hints"],
    "ruleRefs": ["DACS-1-6.3.6", "DACS-5-10.5.3", "DACS-5-10.5.4"],
    "status": "open",
    "effect": "nonconforming",
    "description": "minCompletionRate and minRating return 400 instead of filtering. completionRate and averageSellerRating are null even when bundleCount is positive, and published reputation carries no re-derivable metrics."
  },
  {
    "id": "sb3-session-binding-unverified",
    "capabilityRefs": ["directory-reputation-hints"],
    "ruleRefs": ["SB-3"],
    "status": "open",
    "effect": "nonconforming",
    "description": "The Directory does not independently authenticate the rail profile's mandatory settlement-side session binding. Counts, references and currency totals are observations only; they cannot establish settlement, transaction readiness, a final verification decision, or a DACS-5 replayable derivation."
  },
  {
    "id": "sb1-settlement-id-without-ledger-check",
    "capabilityRefs": ["directory-reputation-hints"],
    "ruleRefs": ["SB-1", "SB-2"],
    "status": "open",
    "effect": "nonconforming",
    "description": "The settlement-tx-id is projected from the signed TxRef without independently authenticated ledger data: asset, payer, agreed payee, amount, finality and x402 receipt-to-transaction/network binding are not established. No settlement-side collision winner is authenticated; all competing records are excluded across the complete presented catalog. Arms whose identity needs that ledger data (legacy evm, solana and x402, legacy non-Demos rails, and all other arms) are not projected, and their records do not count."
  }
]
```

Settlement uniqueness (SB-1, SB-2) applies to the records counted in seller
reputation and in listing hints:

- Success payment evidence requires a nonempty array of exact TxRef shapes.
  The phase index comes from the evidence anchor's metadata-of-record PC-2
  logical address, read with the verified signed bytes. Its complete canonical
  job/CF-4 rail/index tuple must match the signed job, agreement and bundle.
  Registry rail IDs and phase handlers are distinct: the pinned Standard table
  determines the handler, and the signed listing pipeline must bind that handler
  and rail at the same index. Unknown registry entries/versions and unsupported
  ST-8 resolved records are withheld until their authority can be resolved.
  Demos, EVM ERC-20, Solana SPL and x402 rails accept only their corresponding
  TxRef arms. A mismatch excludes the deal from every aggregate.
- Each `paymentTxRefs` entry of success-outcome payment evidence is
  projected to its SB-1 `settlement-tx-id`: `demos` gives `demos:{txHash}`;
  `evm-event` and
  `x402-event` give `evm:{chainId}:{txHash}:{logIndex}`; `solana-instruction`
  gives `solana:{cluster}:{signature}:{instructionIndex}`. A record citing a
  reference that cannot be projected this way does not count.
- The complete catalog set of otherwise countable records, across all sellers,
  is grouped by that id before seller, category or window projection. One record
  repeating one `(jobId, phaseIndex)` claim
  counts once. A group claimed by more than one record or tuple follows SB-2
  rule (2): this Directory verifies no settlement-side binding authority, so
  the group is indeterminate and none of its records count, whatever their
  `observedAt` or arrival order.
