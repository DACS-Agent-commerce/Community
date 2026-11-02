# Directory scan progress and candidate coverage

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

Each returned newly indexed listing carries revocationCoverage: complete | incomplete and lastVerifiedAt: integer | null. Any unresolved storage read discovered through the published cursor makes coverage incomplete, including for an already revoked listing. Without a verified revocation binding, unread candidates or remaining pending work also make coverage incomplete. Retry backoff and exhausted retries do not establish complete coverage. lastVerifiedAt then retains the prior time for that exact seller/listing/version/hash, or null if no complete check exists. It advances on a complete check; fetching the API does not refresh it. A verified or retained seller-bound revocation settles its own candidate check under the existing RB-3 rule even if its marker later becomes unreadable, but never overrides an unresolved scanner storage-read gap. Its revoked status and binding remain retained.

This extension preserves current upstream withdrawal rules. Raw discovery hints do not acquire withdrawal authority and do not by themselves change an active listing's status or hide it. An active row can therefore report incomplete candidate coverage. Existing authenticated unresolved withdrawal sources still cause upstream suppression, and verified/retained revocations still use status=revoked with the existing revocation binding property. The active/revoked vocabulary, authenticated withdrawal carriage, current-marker adjudication and offer visibility are unchanged. The coverage flag is context for a buyer's own refusal policy, not a new admission policy. Complete describes only discovered storage and candidate work, not global absence of undiscovered revocations or stale-node responses.

A buyer requiring this extension should refuse missing/incomplete coverage, unknown or stale verification/pass times, implausible cursor/tip/lag, future timestamps and inconsistent pages under its configured age/finality/node/profile/origin policies. A fresh catalogObservedAt or fetch time establishes none of those policies. Independent listing/marker verification and explicit purchase authorization remain the buyer's responsibility. No signed catalog/key, second-origin trust, capacity evidence or signing operation is added here.

Known limitation: third-party revocation-shaped programs whose cached bytes fail verification and whose current storage is gone can leave candidate coverage incomplete indefinitely. Buyers refusing incomplete coverage can therefore have an offer suppressed by a third party. This change does not relax upstream RB-6 handling of missing/current marker bytes; a node NOT_FOUND is operational evidence, not authenticated DACS absence evidence. The existing pending candidate and storage-read queues remain conservative. The storage-read guard is directory-wide and includes every discovered storage address, not just revocation-shaped candidates. One unresolved read therefore makes coverage incomplete for every listing and freezes all affected lastVerifiedAt values. Stable NOT_FOUND or non-public failures enter dead-letter after one attempt and are not automatically retried; a later transaction revisiting that locator, a chain reset, or explicit operator recovery is needed to reconsider them. A single deleted or private storage reference anywhere in scanned history can therefore suppress all offers indefinitely for buyers refusing incomplete coverage.

When no valid tip was observed in the scan, published `scanProgress.tip` and `scanProgress.lag` are both null, including on an empty page. Upstream operational diagnostics still seed `chainTip` from the scan start (`scan.ts`) and copy it to `lastChainTip` and run diagnostics (`reindexCore.ts`); those diagnostics are outside this extension's published progress surface and remain unchanged.

Each ordinary completed pass saves scan state once, with the catalog and run completion in the existing chain-read-window transaction. Chain adoption/reset sanitation may additionally persist its upstream control migration before the pass. A failed pass rolls back provisional chain reads and cursor changes; a later successful pass records the advancement time for the cursor it actually publishes.
