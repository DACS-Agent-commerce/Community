# `/try` browser tests

The Playwright suite has two layers:

- `npm run test:e2e` runs two deterministic passes. The first (`playwright.config.ts`, port 3400) runs the landing-page, seller-registration, mocked `/try` payment-safety and `/try-chat` replay regressions. The second (`playwright.recovery.config.ts`, port 3401) starts a separate development server for `/try` with `NEXT_PUBLIC_GATEWAY_DEMO_RECOVERY_ONLY=1` and runs `try-dacs-recovery.spec.ts`, which proves the recovery-only page sends no procurement POST: fresh starts are disabled, the dispatch handler refuses even a direct invocation, a run with a job id is read, and a run without one goes to manual reconciliation. The default config ignores that spec because it needs the flag. These mocked checks cover newly loaded pages; gateway enforcement for pre-deployment tabs must be checked separately as described in the [cutover procedure](../../../docs/gateway-demo-cutover.md). Neither pass spends DEM or USDC; both are safe for CI.
- `npm run test:e2e:live` contains five serial checks against the live Butler gateway. It is skipped unless the operator explicitly authorizes a capped testnet purchase.

## Install the browser

```bash
npx playwright install chromium
```

## Run the zero-cost suite

```bash
npm run test:e2e
```

## Run the live suite

The live suite makes exactly one new procurement purchase. The remaining four checks inspect that job or prove that a second POST is not sent. It refuses to run with a budget cap above 5 DEM.

```bash
RUN_LIVE_PAID_E2E=1 LIVE_E2E_MAX_DEM=5 npm run test:e2e:live
```

Optional overrides:

- `LIVE_BUTLER_ORIGIN` changes the gateway origin.
- Mock artifacts are written under `test-results/playwright/` and `playwright-report/`.
- Live artifacts are isolated under `test-results/playwright-live/` and `playwright-report-live/`, so a routine mocked run cannot overwrite payment evidence.

Treat the live command as a payment authorization. Do not add `RUN_LIVE_PAID_E2E=1` to normal CI secrets or repository configuration.
