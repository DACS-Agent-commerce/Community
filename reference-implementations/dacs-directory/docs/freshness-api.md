# Directory scan progress and revocation checks (candidate Community extension)

This is an unmerged change based on Community 9ce534b0ddec4b2867f358b62ce9d8ef8c6e90f1. It describes the patched API, not the currently deployed API. No signed manifest/key has been approved; TLS origin trust remains required. It is advisory node-derived evidence, not authenticated finality or a universal purchase authorization.

GET /api/dacs/listings?limit=20 returns listings (array), total (whole filtered active set), optional cursor (pagination string offset), and scanProgress. Pass pagination cursor unchanged to the next request. It is absent on the last page. Do not confuse it with scanProgress.cursor, a number from the chain scan. Reject inconsistent snapshot values between pages and restart pagination after a catalog refresh.

GET /api/dacs/status includes the same persisted scanProgress for the published catalog. Other status fields describe live/current scanner diagnostics and may differ after a failed refresh. They do not rewrite the catalog snapshot.

Example body (synthetic, not a live claim):

```json
{"listings":[],"total":0,"scanProgress":{"cursor":100,"tip":102,"lag":2,"cursorAdvancedAt":1792000000000,"lastSuccessfulFullScanAt":1792000060000,"fromTx":98}}
```

All scanProgress members are integer or null. Missing legacy progress is returned as all null; unknown never means zero lag/freshness. Times are UTC Unix milliseconds:

- cursor: last processed finalized transaction id in this completed catalog pass.
- tip: node tip observed by that scan, not a second node/global tip.
- lag: max(0, tip - cursor); includes the scanner's configured finality depth (default 2). A quiet chain can have an unchanged cursor and a new completed-pass time. A stale node can report a quiet tip; these fields cannot detect that alone.
- cursorAdvancedAt: last time the persisted scan cursor increased, not refreshed just for this API request.
- lastSuccessfulFullScanAt: completion timestamp for a successful full indexing pass (complete history walk from fromTx to its stop boundary plus registered-listing processing), not proof of a genesis rebuild on every refresh. Failed or truncated scans never advance it.
- fromTx: starting lower boundary. Zero means this pass walked to genesis; a normal incremental pass is not a cold rebuild.

Each newly indexed listing includes revocationCheck (complete or incomplete) and lastVerifiedAt (integer or null). catalogObservedAt means this pass observed the listing. lastVerifiedAt advances only when the listing verifies and the candidate-marker check completes, or a valid revocation binding verifies. On an incomplete check it retains the last successful value for that same seller/listing/version/hash, or null if none exists. It is never minted merely by serving/fetching the API.

An unreadable/throwing marker, or candidates left beyond the 16-verification batch, produces status=unverified, revocationCheck=incomplete. Discovery collections omit unverified and revoked offers; seller/detail history can show them, with no offer metadata or linked engagement endpoint on the service page. Do not interpret an empty active collection as a clean full-history statement. A verified revoked marker yields status=revoked with its binding; a later unreadable marker cannot yield active. Complete means the currently discovered candidate set was exhausted, not that undiscovered revocations or stale-node responses are impossible. Reject legacy absent check/time fields as unknown when your policy requires these new guarantees.

Consumer policy: require complete check, a recent lastVerifiedAt AND recent lastSuccessfulFullScanAt under your own clock/age limit, plausible cursor/tip/lag for the declared finality depth, expected chain/node/profile and independently verified listing/marker bytes. Validate timestamps are not future values. A fresh catalogObservedAt or a fresh HTTP fetch alone proves none of this. Even an active row is not an instruction to buy; trust/integrity/finality checks and authorization remain the buyer's responsibility. An unapproved signing key, network failure or missing fields must not be silently replaced by a successful purchase decision.

Public requests can use a descriptive User-Agent. No wallet, token, seed, signature request or POST is needed to read these endpoints. This extension does not grant trust to a second origin automatically.
