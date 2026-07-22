# `/try` browser tests

The Playwright suite has two layers:

- `npm run test:e2e` runs seven deterministic browser regressions: six mocked `/try` payment-safety scenarios plus a `/try-chat` replay check that proves the explainer cannot dispatch a purchase. It never spends DEM or USDC and is safe for CI.
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
