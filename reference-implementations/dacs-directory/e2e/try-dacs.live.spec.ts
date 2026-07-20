import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import {
  PROCUREMENT_LOCK_NAME,
  PROCUREMENT_RUN_KEY,
  chooseProcurementExample,
  expectAcceptedEvidence,
} from "./try-dacs-fixtures.js";

const LIVE_ENABLED = process.env.RUN_LIVE_PAID_E2E === "1";
const LIVE_MAX_DEM = Number(process.env.LIVE_E2E_MAX_DEM ?? "0");
const LIVE_BUTLER = (process.env.LIVE_BUTLER_ORIGIN ?? "https://butler.agentcommerce.network").replace(/\/$/, "");
const HARD_MAX_DEM = 5;

function isProcurementPost(request: Request) {
  return request.method() === "POST" && new URL(request.url()).pathname === "/demo/procurement";
}

test.describe("/try live paid procurement", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!LIVE_ENABLED, "Set RUN_LIVE_PAID_E2E=1 and LIVE_E2E_MAX_DEM to explicitly authorize one live testnet purchase.");

  let context: BrowserContext;
  let page: Page;
  let idempotencyKey = "";
  let jobId = "";
  let submittedInput: Record<string, unknown> = {};
  let submittedGoal = "";
  let paymentTx = "";

  test.beforeAll(async ({ browser }) => {
    if (!Number.isFinite(LIVE_MAX_DEM) || LIVE_MAX_DEM < 1 || LIVE_MAX_DEM > HARD_MAX_DEM) {
      throw new Error(`LIVE_E2E_MAX_DEM must be between 1 and ${HARD_MAX_DEM}; the suite will not dispatch a paid request otherwise.`);
    }
    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("1. completes one real paid purchase", async ({}, testInfo) => {
    test.setTimeout(13 * 60_000);
    await chooseProcurementExample(page);
    await page.locator("#proc-budget").fill(String(LIVE_MAX_DEM));

    const startResponse = page.waitForResponse((response) => isProcurementPost(response.request()));
    await page.getByRole("button", { name: /Run this agent/ }).click();
    const response = await startResponse;
    const request = response.request();
    const startBody = await response.json() as { id?: string; error?: unknown };

    idempotencyKey = (await request.headerValue("idempotency-key")) ?? "";
    submittedInput = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
    submittedGoal = String(submittedInput.goal ?? "live E2E procurement");
    jobId = String(startBody.id ?? "");

    expect(response.ok(), JSON.stringify(startBody)).toBe(true);
    expect(idempotencyKey).toBeTruthy();
    expect(jobId).toBeTruthy();
    expect(Number(submittedInput.budgetDem)).toBeLessThanOrEqual(LIVE_MAX_DEM);

    await expect(page.getByRole("heading", { name: "Procurement Butler result" })).toBeVisible({ timeout: 12 * 60_000 });
    paymentTx = (await page.locator(".tx-link code").textContent())?.trim() ?? "";
    expect(paymentTx).toBeTruthy();

    await testInfo.attach("live-purchase.json", {
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ jobId, idempotencyKey, paymentTx, budgetCapDem: LIVE_MAX_DEM }, null, 2)),
    });
  });

  test("2. verifies the real post-payment evidence and all five DACS stages", async ({}, testInfo) => {
    await expectAcceptedEvidence(page);
    const response = await context.request.get(`${LIVE_BUTLER}/demo/procurement/${encodeURIComponent(jobId)}`);
    expect(response.ok()).toBe(true);
    const job = await response.json() as Record<string, unknown>;
    const result = job.result as Record<string, unknown>;
    const settlement = result.settlement as Record<string, unknown>;
    const amount = Number(settlement.amountDem ?? settlement.amount);
    const transactions = Array.isArray(result.transactions) ? result.transactions as Array<Record<string, unknown>> : [];

    expect(amount).toBeGreaterThan(0);
    expect(amount).toBeLessThanOrEqual(LIVE_MAX_DEM);
    expect(String(settlement.txHash)).toBe(paymentTx);
    expect(transactions.some((transaction) => transaction.kind === "payment" && transaction.txRef === paymentTx)).toBe(true);

    await testInfo.attach("live-evidence.json", {
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ jobId, paymentTx, amountDem: amount, events: job.events, result }, null, 2)),
    });
  });

  test("3. reload recovery reads the existing job and sends no second POST", async () => {
    const record = { runId: idempotencyKey, jobId, goal: submittedGoal, input: submittedInput, startedAt: new Date().toISOString() };
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: PROCUREMENT_RUN_KEY, value: record });
    await page.reload();
    await expect(page.locator(".resume-banner")).toContainText(jobId.slice(0, 8));

    let posts = 0;
    const countPosts = (request: Request) => { if (isProcurementPost(request)) posts += 1; };
    page.on("request", countPosts);
    const statusResponse = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === `/demo/procurement/${jobId}`,
    );
    await page.getByRole("button", { name: /Check & resume/ }).click();
    expect((await statusResponse).ok()).toBe(true);
    await expect(page.getByRole("heading", { name: "Procurement Butler result" })).toBeVisible();
    page.off("request", countPosts);

    expect(posts).toBe(0);
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), PROCUREMENT_RUN_KEY)).toBeNull();
  });

  test("4. a real second tab is refused before another paid POST", async () => {
    const protectedRecord = {
      runId: idempotencyKey,
      jobId,
      goal: submittedGoal,
      input: submittedInput,
      startedAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify(protectedRecord);
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: PROCUREMENT_RUN_KEY, value: serialized });
    const secondTab = await context.newPage();
    await secondTab.goto("/try");
    await expect(secondTab.locator(".resume-banner")).toContainText("still on record");

    let posts = 0;
    const countPosts = (request: Request) => { if (isProcurementPost(request)) posts += 1; };
    secondTab.on("request", countPosts);
    await secondTab.getByRole("button", { name: /Procurement Butler/ }).first().click();
    await secondTab.getByRole("button", { name: "Load example" }).click();
    await secondTab.getByRole("button", { name: /Run this agent/ }).click();

    await expect(secondTab.locator(".bubble.error")).toContainText("earlier procurement run from this browser is still on record");
    expect(posts).toBe(0);
    expect(await secondTab.evaluate((key) => localStorage.getItem(key), PROCUREMENT_RUN_KEY)).toBe(serialized);
    secondTab.off("request", countPosts);
    await secondTab.close();
    await page.evaluate((key) => localStorage.removeItem(key), PROCUREMENT_RUN_KEY);
  });

  test("5. cancelling a queued cross-tab lock sends no paid POST", async () => {
    await page.evaluate((key) => localStorage.removeItem(key), PROCUREMENT_RUN_KEY);
    const actor = await context.newPage();
    await page.goto("/try");
    await chooseProcurementExample(actor);

    await page.evaluate((lockName) => {
      const scope = window as typeof window & {
        __liveE2eLockHeld?: boolean;
        __liveE2eReleaseLock?: () => void;
      };
      if (!navigator.locks) throw new Error("Web Locks unavailable in the live E2E browser");
      scope.__liveE2eLockHeld = false;
      void navigator.locks.request(lockName, async () => {
        scope.__liveE2eLockHeld = true;
        await new Promise<void>((resolve) => { scope.__liveE2eReleaseLock = resolve; });
      });
    }, PROCUREMENT_LOCK_NAME);
    await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __liveE2eLockHeld?: boolean }).__liveE2eLockHeld))).toBe(true);

    let posts = 0;
    const countPosts = (request: Request) => { if (isProcurementPost(request)) posts += 1; };
    actor.on("request", countPosts);
    await actor.getByRole("button", { name: /Run this agent/ }).click();
    await expect(actor.getByText(/FULL DACS FLOW RUNNING/)).toBeVisible();
    await actor.getByRole("button", { name: /Stop watching/ }).click();
    await page.evaluate(() => (window as typeof window & { __liveE2eReleaseLock?: () => void }).__liveE2eReleaseLock?.());

    await expect(actor.locator(".bubble.error")).toContainText("Run cancelled in this browser");
    expect(posts).toBe(0);
    expect(await actor.evaluate((key) => localStorage.getItem(key), PROCUREMENT_RUN_KEY)).toBeNull();
    actor.off("request", countPosts);
    await actor.close();
  });
});
