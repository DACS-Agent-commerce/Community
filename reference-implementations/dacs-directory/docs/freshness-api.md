# Directory scan progress

This document describes the Directory scan-progress API in this source tree. Deployment of these fields is not asserted here. Responses remain unsigned advisory node-derived context, not authenticated global finality or purchase authorization.

GET /api/dacs/listings returns listings, total, an optional string pagination cursor and scanProgress. GET /api/dacs/status includes the same persisted scanProgress for the published catalog. The snapshot is committed with its catalog and successful run. A failed refresh can change working diagnostics but does not change the published snapshot. Check identical scanProgress and catalog observation values across pages; restart pagination when they change. The numeric scanProgress.cursor is distinct from the string pagination cursor.

All six scanProgress members are integer or null; legacy missing progress returns six nulls. Unknown is never fabricated zero lag. Times use UTC Unix milliseconds:

- cursor: finalized transaction cursor reached by this completed pass.
- tip: node tip observed during the scan, not a global or independently authenticated tip.
- lag: max(0, tip - cursor), including configured finality depth (default two transactions).
- cursorAdvancedAt: actual observed cursor increase, carried through published snapshots. An upgraded cursor with no observed increase is unknown. Existing upstream diagnostic seeding remains separate and unchanged.
- lastSuccessfulFullScanAt: completion of this successful whole indexing pass, including the walk from fromTx to its stop boundary and listing processing. It does not mean every incremental pass was a genesis rebuild. Failed/truncated scans do not advance it.
- fromTx: walk's lower boundary; zero means the pass walked to genesis.

Example (synthetic):

```json
{"listings":[],"total":0,"scanProgress":{"cursor":100,"tip":102,"lag":2,"cursorAdvancedAt":1792000000000,"lastSuccessfulFullScanAt":1792000060000,"fromTx":98}}
```

A buyer relying on scan progress should refuse unknown or stale pass times, implausible cursor/tip/lag, future timestamps and inconsistent pages under its configured age/finality/node/profile/origin policies. A fresh catalogObservedAt or fetch time establishes none of those policies. Independent listing/marker verification and explicit purchase authorization remain the buyer's responsibility. No signed catalog/key, second-origin trust, capacity evidence or signing operation is added here.

Listings carry no revocation-coverage flag. An earlier draft published `revocationCoverage` and `lastVerifiedAt`, but its guard counted every unresolved storage read in the Directory against every listing, so one unrelated unreadable address marked all listings incomplete. Withdrawal handling is unchanged: verified and retained revocations use `status: revoked` with the revocation binding, and authenticated unresolved withdrawal sources still hold a listing.

When no valid tip was observed in the scan, published `scanProgress.tip` and `scanProgress.lag` are both null, including on an empty page. Upstream operational diagnostics still seed `chainTip` from the scan start (`scan.ts`) and copy it to `lastChainTip` and run diagnostics (`reindexCore.ts`); those diagnostics are outside this extension's published progress surface and remain unchanged.

Each ordinary completed pass saves scan state once, with the catalog and run completion in the existing chain-read-window transaction. Chain adoption/reset sanitation may additionally persist its upstream control migration before the pass. A failed pass rolls back provisional chain reads and cursor changes; a later successful pass records the advancement time for the cursor it actually publishes.
