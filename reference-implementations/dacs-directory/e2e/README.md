# DACS Directory browser tests

The Playwright suite covers the Directory's public discovery and seller-publication
surfaces without contacting a live chain or spending funds.

- `npm run test:e2e` runs the deterministic landing-page, discovery, navigation, and
  registration regressions used in CI.
- `npm run test:e2e:ui` opens Playwright's interactive runner for local debugging.

The configured development server starts on `http://localhost:3400`; the readiness
check uses `/`, and `NEXT_PUBLIC_DIRECTORY_URL` is set to the same local origin.
