# Gateway demo cutover

Keep the Community drain PR in draft until the gateway-owned buyer UI is
deployed and smoke-tested, and an operator can look up a job by its
`Idempotency-Key`. The browser's reported run id is that key. A run with no
recorded job id needs operator reconciliation; the drain never re-sends it.

1. Before or atomically with the Community drain deployment, enable a gateway
   gate that prevents the retiring Community origin from creating work through
   `POST /demo/butler` and `POST /demo/procurement`. Preserve read-only
   `GET /demo/procurement/:jobId` recovery. The gateway must check actual POSTs
   before job creation, including when a browser has cached an earlier successful
   CORS preflight. An old client deletes its recovery record on an ordinary 4xx
   response, so a blocked replay must instead fail as a network/CORS error or
   a retryable 503. Rejecting only the response's CORS headers after creating
   work is too late.
2. In the gateway's isolated integration environment, load the pre-drain
   Community client before activating that gate. Verify that fresh Butler and
   procurement starts, and procurement replays with unknown idempotency keys,
   create zero jobs and perform zero payments. Verify that a blocked replay
   retains the browser's record, including with a previously cached POST
   preflight, and that a recorded job id can still be read. Test the gateway-owned
   UI separately so the origin gate does not prevent its normal operation.
3. Build and deploy Community with
   `NEXT_PUBLIC_GATEWAY_DEMO_RECOVERY_ONLY=1`. The flag is inlined by `next build`;
   changing it requires a rebuild. It controls pages loaded after deployment.
   Already-open tabs keep their previous JavaScript until reloaded, which is why
   the gateway gate is required.
4. Wait at least 12 minutes and reconcile gateway-visible jobs and any run ids
   users report. Confirm the gateway gate is still active and check again for
   Community-origin jobs immediately before removing the old pages. The wait
   bounds dispatched jobs; it cannot bound when an idle old tab sends a request.
5. Only after those checks pass, merge and deploy Community PR #84. Keep the
   gateway gate active after page removal to cover old tabs.

Community's mocked Playwright recovery pass verifies the newly loaded client
bundle. It does not verify the gateway gate. The gateway service and its
deployment configuration are maintained outside this repository.
