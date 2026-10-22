import { expect, test } from "@playwright/test";

test("pages are served and a failed refresh is shown while the chain is unreachable", async ({ page, request }) => {
  const home = await page.goto("/");
  expect(home?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Find agents you can verify." })).toBeVisible();

  const before = await request.get("/api/dacs/status");
  expect(before.status()).toBe(200);
  const status = await before.json();
  expect(status.nodeDeployment).toMatchObject({ ok: false });
  expect(status.nodeDeployment.unavailable).toBe(true);
  expect(status.nodeDeployment.reason).toContain("could not read");
  expect(status.chainLatestTx).toBeNull();
  expect(status.txsBehind).toBeNull();

  const refresh = await request.post("/api/dacs/reindex", {
    headers: { authorization: "Bearer offline-browser-test" },
  });
  expect(refresh.status()).toBe(500);
  expect(await refresh.json()).toMatchObject({ ok: false });

  const after = await (await request.get("/api/dacs/status")).json();
  expect(after.generatedAt).toBe(status.generatedAt);
  expect(after.syncedToTx).toBe(status.syncedToTx);
  expect(after.indexer.lastRun.status).toBe("failed");

  await page.goto("/discover");
  await expect(page.locator('.sync-chip[role="status"]')).toContainText("Indexing blocked: last refresh failed");
});

for (const scenario of [
  { name: "a short chain probe times out", nodeDeployment: { ok: false, unavailable: true, reason: "Demos node chain check timed out" }, lastRun: null, label: "Chain status unavailable" },
  { name: "the node reports another chain", nodeDeployment: { ok: false, reason: "not the pinned chain" }, lastRun: null, label: "Indexing blocked: chain mismatch" },
  { name: "a refresh failed", nodeDeployment: { ok: true }, lastRun: { status: "failed" }, label: "Indexing blocked: last refresh failed" },
  { name: "a later refresh succeeds", nodeDeployment: { ok: true }, lastRun: { status: "complete" }, label: "in sync with chain" },
]) test(`discovery status distinguishes ${scenario.name}`, async ({ page }) => {
  await page.route("**/api/dacs/status", route => route.fulfill({ json: {
    generatedAt: scenario.nodeDeployment.ok ? Date.now() : 0, syncedToTx: 1, chainLatestTx: scenario.nodeDeployment.ok ? 1 : null,
    txsBehind: scenario.nodeDeployment.ok ? 0 : null,
    nodeDeployment: scenario.nodeDeployment, indexer: { lastRun: scenario.lastRun },
  } }));
  await page.goto("/discover");
  await expect(page.locator('.sync-chip[role="status"]')).toContainText(scenario.label);
});

test("the landing page is catalog-led", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Find agents you can verify." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse the directory" })).toHaveAttribute("href", "/discover");
  await expect(page.getByRole("link", { name: "Submit listing pointers", exact: true })).toHaveAttribute("href", "/register");
  await expect(page.getByLabel("Catalog summary")).toBeVisible();
  await expect(page.getByText("initial chain index")).toBeVisible();

  // The landing page shares /discover's heading, so check the page itself.
  await page.goto("/discover");
  await expect(page).toHaveURL(/\/discover$/);
  await expect(page).toHaveTitle("Discover agents · DACS Directory");
  await expect(page.getByRole("heading", { name: "Find agents you can verify." })).toBeVisible();
});

test("the proposal URL redirects to the landing page", async ({ page }) => {
  await page.goto("/home-proposal");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Find agents you can verify." })).toBeVisible();
});

test("the primary navigation collapses before it can overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");

  const menu = page.getByRole("button", { name: "Open menu" });
  await expect(menu).toBeVisible();
  await menu.click();
  await expect(page.getByRole("link", { name: "discover", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "submit listing pointers", exact: true })).toBeVisible();
});

test("the mobile landing page keeps primary actions and catalog state visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Find agents you can verify." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse the directory" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Submit listing pointers", exact: true })).toBeVisible();

  const summary = page.getByLabel("Catalog summary");
  await expect(summary).toBeVisible();
  await expect(summary.locator(":scope > div")).toHaveCount(4);
});
