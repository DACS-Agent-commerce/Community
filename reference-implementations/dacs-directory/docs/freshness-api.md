# Directory scan progress

This document describes the Directory scan-progress API in this source tree. Deployment of these fields is not asserted here. Responses remain unsigned advisory node-derived context, not authenticated global finality or purchase authorization.

GET /api/dacs/listings returns listings, total, an optional string pagination cursor and scanProgress. GET /api/dacs/status includes the same persisted scanProgress for the published catalog. The snapshot is committed with its catalog and successful run. A failed refresh can change working diagnostics but does not change the published snapshot. Check identical scanProgress, catalog observation values and the Last-Modified response header across pages; restart pagination when they change. An admin index-now refresh can republish the catalog without advancing scanProgress, so scanProgress alone does not identify a catalog generation. Last-Modified has one-second precision and cannot distinguish every refresh. To revalidate a previously fetched page, repeat the same URL with its ETag in If-None-Match; a changed ETag requires restarting pagination. ETags describe individual response bodies and must not be compared between different page URLs. These checks detect changes but do not provide snapshot-isolated pagination. The numeric scanProgress.cursor is distinct from the string pagination cursor.

All six scanProgress members are integer or null; legacy missing progress returns six nulls. Unknown is never fabricated zero lag. Times use UTC Unix milliseconds:

- cursor: finalized transaction cursor reached by this completed pass.
- tip: node tip observed during the scan, not a global or independently authenticated tip.
- lag: max(0, tip - cursor), including configured finality depth (default two transactions).
- cursorAdvancedAt: actual observed cursor increase, carried through published snapshots. An upgraded cursor with no observed increase is unknown. After a chain reset the old cursor's time no longer applies. A reset pass that completes publishes its own time, even when it did not move the cursor. After a tip-regression reset pass that failed, the first pass that completes publishes its own time. After a re-pin pass that failed, the catalog was emptied, so the first pass that completes publishes null (unknown) unless it moves the cursor. Existing upstream diagnostic seeding remains separate and unchanged.
- lastSuccessfulFullScanAt: completion of this successful whole indexing pass, including the walk from fromTx to its stop boundary and listing processing. It does not mean every incremental pass was a genesis rebuild. Failed/truncated scans do not advance it.
- fromTx: walk's lower boundary; zero means the pass walked to genesis.

Example (synthetic):

```json
{"listings":[],"total":0,"scanProgress":{"cursor":100,"tip":102,"lag":2,"cursorAdvancedAt":1792000000000,"lastSuccessfulFullScanAt":1792000060000,"fromTx":98}}
```

A buyer relying on scan progress should refuse unknown or stale pass times, implausible cursor/tip/lag, future timestamps and inconsistent pages under its configured age/finality/node/profile/origin policies. A fresh catalogObservedAt or fetch time establishes none of those policies. Independent listing/marker verification and explicit purchase authorization remain the buyer's responsibility. No signed catalog/key, second-origin trust, capacity evidence or signing operation is added here.

Listings carry no revocation-coverage flag; `revocationCoverage` and `lastVerifiedAt` saved by an earlier build are dropped when the catalog is read. Withdrawal handling is unchanged: verified and retained revocations use `status: revoked` with the revocation binding, and authenticated unresolved withdrawal sources still hold a listing.

`status: active` means only that no withdrawal had been applied as of the snapshot's publication. A withdrawal read and authenticated during a later refresh that failed to publish is not reflected until a refresh succeeds. It does not mean that every storage write encountered by the scan could be read.

When a pass cannot read a listing's anchor because of a passing fault (a 5xx reply, timeout, refused connection or unreadable reply within the storage response byte ceiling), the listing indexed on an earlier pass stays in the catalog as it was last observed: its `catalogObservedAt` remains the time of the pass that last read the anchor, so a value older than the seller's `lastIndexedAt` marks it as unread since then. The kept copy has limits:

- It is dropped once `catalogObservedAt` is more than 24 hours old (`KEPT_LISTING_MAX_AGE_MS`).
- It is dropped once its signed `validity.notAfter` has passed. The value is saved with the seller record, which the API never serves; a record saved without it is dropped, since it cannot show the listing is still in force. A listing that signs no `notAfter` is saved as having none and is not dropped for that.
- It is dropped when a verified or retained withdrawal, an unsettled withdrawal marker for its hash whoever anchored it, or an incomplete well-known withdrawal exists for its hash. It is never kept as `active` in that case.
- It is dropped on any 4xx answer from storage, such as 401 or 403, as before, on a 200 reply whose stored value fails the raw JSON admission check or exceeds the artifact limits, and on a 2xx reply over the 1 MiB storage response byte ceiling.
- It is never carried through a replay from genesis (after a chain replacement or a tip reset, or before a complete pass on the served chain): the earlier catalog is no longer evidence then, so a listing whose anchor cannot be read is dropped until a fresh verified read publishes it again.

A node's NOT_FOUND, bytes that no longer verify as the listing, a held notice or a saved declaration of other bytes drop it too. Withdrawal handling is unchanged: a kept copy only stays while no withdrawal evidence exists for it.

When no valid tip was observed in the scan, published `scanProgress.tip` and `scanProgress.lag` are both null, including on an empty page. Upstream operational diagnostics still seed `chainTip` from the scan start (`scan.ts`) and copy it to `lastChainTip` and run diagnostics (`reindexCore.ts`); those diagnostics are outside this extension's published progress surface and remain unchanged.

Each ordinary completed pass saves scan state once, with the catalog and run completion in the existing chain-read-window transaction. Chain adoption/reset sanitation may additionally persist its upstream control migration before the pass. A failed pass rolls back provisional chain reads and cursor changes; a later successful pass records the advancement time for the cursor it actually publishes.
