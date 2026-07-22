import { expect, test, type Route } from "@playwright/test";
import {
  PROCUREMENT_LOCK_NAME,
  PROCUREMENT_RUN_KEY,
  chooseProcurementExample,
  completedJob,
  expectAcceptedEvidence,
  installMockGateway,
  x402CompletedJob,
} from "./try-dacs-fixtures.js";

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
    headers: { "access-control-allow-origin": "*" },
  });
}

test.describe("/try procurement browser safety", () => {
  test("1. completes a paid-style procurement and clears its recovery record", async ({ context, page }) => {
    await installMockGateway(context);
    await chooseProcurementExample(page);

    await page.getByRole("button", { name: /Run the full deal/ }).click();

    await expectAcceptedEvidence(page);
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), PROCUREMENT_RUN_KEY)).toBeNull();
  });

  test("2. reload recovery reuses the original idempotency key", async ({ context, page }) => {
    const keys: string[] = [];
    let posts = 0;
    await installMockGateway(context, {
      onProcurementPost: async (route) => {
        posts += 1;
        keys.push((await route.request().headerValue("idempotency-key")) ?? "");
        if (posts === 1) await route.abort("failed");
        else await fulfillJson(route, completedJob);
      },
    });
    await chooseProcurementExample(page);

    await page.getByRole("button", { name: /Run the full deal/ }).click();
    await expect(page.locator(".bubble.error")).toContainText("Retrying reuses the same idempotency key");
    const storedBeforeReload = await page.evaluate((key) => localStorage.getItem(key), PROCUREMENT_RUN_KEY);
    expect(storedBeforeReload).not.toBeNull();

    await page.reload();
    await expect(page.locator(".resume-banner")).toContainText("the job id was never received");
    await page.getByRole("button", { name: /Check & resume/ }).click();

    await expectAcceptedEvidence(page);
    expect(posts).toBe(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  test("3. a second tab cannot overwrite an active procurement record", async ({ context, page }) => {
    let posts = 0;
    let pendingRoute: Route | undefined;
    let releasePost!: (action: "abort") => void;
    const postGate = new Promise<"abort">((resolve) => { releasePost = resolve; });
    let firstPostSeen!: () => void;
    const firstPost = new Promise<void>((resolve) => { firstPostSeen = resolve; });

    await installMockGateway(context, {
      onProcurementPost: async (route) => {
        posts += 1;
        pendingRoute = route;
        firstPostSeen();
        await postGate;
        await route.abort("failed");
      },
    });

    const secondTab = await context.newPage();
    await secondTab.goto("/try");
    await expect(secondTab.getByRole("button", { name: /Security Auditor/ }).first()).toBeVisible();
    await chooseProcurementExample(page);
    await page.getByRole("button", { name: /Run the full deal/ }).click();
    await firstPost;

    await expect(secondTab.locator(".resume-banner")).toContainText("still on record");
    const recordBefore = await secondTab.evaluate((key) => localStorage.getItem(key), PROCUREMENT_RUN_KEY);
    expect(recordBefore).not.toBeNull();

    await secondTab.getByRole("button", { name: /Security Auditor/ }).first().click();
    await secondTab.getByRole("button", { name: "Load example" }).click();
    await secondTab.getByRole("button", { name: /Run the full deal/ }).click();

    await expect(secondTab.locator(".bubble.error")).toContainText("earlier procurement run from this browser is still on record");
    expect(posts).toBe(1);
    expect(await secondTab.evaluate((key) => localStorage.getItem(key), PROCUREMENT_RUN_KEY)).toBe(recordBefore);

    releasePost("abort");
    await expect.poll(() => pendingRoute === undefined || posts === 1).toBeTruthy();
    await secondTab.close();
  });

  test("4. cancelling while queued for the Web Lock never dispatches later", async ({ context }) => {
    let posts = 0;
    await installMockGateway(context, {
      onProcurementPost: async (route) => {
        posts += 1;
        await fulfillJson(route, completedJob);
      },
    });

    const lockHolder = await context.newPage();
    const actor = await context.newPage();
    await lockHolder.goto("/try");
    await chooseProcurementExample(actor);

    await lockHolder.evaluate((lockName) => {
      const scope = window as typeof window & {
        __e2eLockHeld?: boolean;
        __e2eReleaseLock?: () => void;
      };
      if (!navigator.locks) throw new Error("Web Locks unavailable in the E2E browser");
      scope.__e2eLockHeld = false;
      void navigator.locks.request(lockName, async () => {
        scope.__e2eLockHeld = true;
        await new Promise<void>((resolve) => { scope.__e2eReleaseLock = resolve; });
      });
    }, PROCUREMENT_LOCK_NAME);
    await expect.poll(() => lockHolder.evaluate(() => Boolean((window as typeof window & { __e2eLockHeld?: boolean }).__e2eLockHeld))).toBe(true);

    await actor.getByRole("button", { name: /Run the full deal/ }).click();
    await expect(actor.getByText(/FULL DACS FLOW · DEM · Demos/)).toBeVisible();
    await actor.getByRole("button", { name: /Stop watching/ }).click();
    await lockHolder.evaluate(() => (window as typeof window & { __e2eReleaseLock?: () => void }).__e2eReleaseLock?.());

    await expect(actor.locator(".bubble.error")).toContainText("Run cancelled in this browser");
    expect(posts).toBe(0);
    expect(await actor.evaluate((key) => localStorage.getItem(key), PROCUREMENT_RUN_KEY)).toBeNull();
  });

  test("5. renders all five stages and the post-payment evidence", async ({ context, page }) => {
    const runningJob = {
      id: completedJob.id,
      status: "running",
      phase: "discovering",
      events: completedJob.events.slice(0, 1),
    };
    await installMockGateway(context, {
      onProcurementPost: (route) => fulfillJson(route, runningJob),
      onProcurementGet: (route) => fulfillJson(route, completedJob),
    });
    await chooseProcurementExample(page);

    await page.getByRole("button", { name: /Run the full deal/ }).click();

    await expectAcceptedEvidence(page);
    await expect(page.locator(".tx-link code")).toHaveText("mock-payment-transaction");
    await expect(page.locator(".chain-activity .chain-row")).toHaveCount(completedJob.events.length);
    await expect(page.getByText("Full evidence bundle accepted & reconciled", { exact: true })).toBeVisible();
  });

  test("6. switches to the x402 schema and submits the USDC rail explicitly", async ({ context, page }) => {
    let submitted: Record<string, unknown> | undefined;
    await installMockGateway(context, {
      onProcurementPost: async (route) => {
        submitted = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
        await fulfillJson(route, x402CompletedJob);
      },
    });
    await chooseProcurementExample(page, "pay-x402");

    await expect(page.getByText("Operator-provisional rail authority", { exact: true })).toBeVisible();
    await expect(page.getByLabel("USDC budget")).toHaveValue("0.1");
    await page.getByRole("button", { name: /Run the full deal/ }).click();

    await expect(page.getByRole("heading", { name: "Security Auditor result" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Base Sepolia USDC settlement" })).toBeVisible();
    await expect(page.getByText("settled & seller-verified", { exact: true })).toBeVisible();
    await expect(page.getByText("Settled & accepted", { exact: true })).toBeVisible();
    expect(submitted?.profileId).toBe("security-audit-rfq");
    expect(submitted?.paymentRail).toBe("pay-x402");
    expect(submitted?.budgetUsdc).toBe(0.1);
    expect(submitted?.budgetDem).toBeUndefined();
  });
});
