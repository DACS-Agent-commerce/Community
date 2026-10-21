# Directory scan progress and candidate coverage

Proposed extension against Community f13f2335201bec2b0ab1733dde9b98f3d9abcd52. This document describes the proposed API, not a currently deployed release. Responses remain unsigned advisory node-derived context, not authenticated global finality or purchase authorization.

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

Each returned newly indexed listing carries revocationCheck: complete | incomplete and lastVerifiedAt: integer | null. With no verified revocation binding, unread candidates or remaining pending work make coverage incomplete. lastVerifiedAt then retains the prior time for that exact seller/listing/version/hash, or null if no complete check exists. It advances on a complete check; fetching the API does not refresh it. A verified or retained seller-bound revocation is complete under the existing RB-3 rule, even if its marker later becomes unreadable.

This extension preserves current upstream withdrawal rules. Raw discovery hints do not acquire withdrawal authority and do not by themselves change an active listing's status or hide it. An active row can therefore report incomplete candidate coverage. Existing authenticated unresolved withdrawal sources still cause upstream suppression, and verified/retained revocations still use status=revoked with the existing revocation binding property. The active/revoked vocabulary, authenticated withdrawal carriage, current-marker adjudication and offer visibility are unchanged. The coverage flag is context for a buyer's own refusal policy, not a new admission policy. Complete describes only discovered candidate work, not global absence of undiscovered revocations or stale-node responses.

A buyer requiring this extension should refuse missing/incomplete coverage, unknown or stale verification/pass times, implausible cursor/tip/lag, future timestamps and inconsistent pages under its configured age/finality/node/profile/origin policies. A fresh catalogObservedAt or fetch time establishes none of those policies. Independent listing/marker verification and explicit purchase authorization remain the buyer's responsibility. No signed catalog/key, second-origin trust, capacity evidence or signing operation is added here.
