# DACS Directory browser tests

The Playwright suite covers the Directory's public discovery and seller-publication
surfaces without contacting a live chain or spending funds.

Install the browser once:

```bash
npx playwright install chromium
```

- `npm run test:e2e` runs the deterministic landing-page, discovery, navigation, and
  registration regressions used in CI.
- `npm run test:e2e:ui` opens Playwright's interactive runner for local debugging.

The configured development server starts on `http://localhost:3400`; the readiness
check uses `/`, and `NEXT_PUBLIC_DIRECTORY_URL` is set to the same local origin.
Stop any existing development server on port 3400 before running the suite.
Playwright starts its own server with an unreachable local chain and isolated
test data; it refuses to reuse a server with another configuration.

Historical artifact hashing also runs the shared Node preimage, null/undefined,
NFC collision and long-sort-run cases in Chromium as part of `npm run test:e2e`.
This check bundles the real reader with esbuild, using the same shim files and `Buffer`
provision as `next.config.mjs` (both read `src/shims/browser-shim-files.mjs`), without a
server. It is not the webpack build itself.
To check all three Playwright engines independently:

```bash
npx playwright install chromium firefox webkit
npm run test:e2e:hash
```
