import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  PROCUREMENT_RUN_KEY,
  completedJob,
  expectAcceptedEvidence,
  installMockGateway,
  procurementOptions,
} from "./try-dacs-fixtures.js";

const storedInput = { profileId: "security-audit-rfq", paymentRail: "pay-dem", files: [{ path: "server.js", content: "safe" }] };

async function countProcurementPosts(context: BrowserContext) {
  const posts = { count: 0 };
  await installMockGateway(context, {
    onProcurementPost: async (route) => {
      posts.count += 1;
      await route.abort("blockedbyclient");
    },
  });
  return posts;
}

async function seedStoredRun(page: Page, value: Record<string, unknown>) {
  await page.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, { key: PROCUREMENT_RUN_KEY, value });
}

test("recovery-only deployment blocks fresh starts but preserves an existing job", async ({ context, page }) => {
  const posts = await countProcurementPosts(context);
  await seedStoredRun(page, {
    runId: "recovery-only-existing-run",
    goal: "Resume the existing security audit",
    input: storedInput,
    startedAt: "2026-08-18T12:00:00.000Z",
    jobId: completedJob.id,
  });

  await page.goto("/try");
  await expect(page.getByTestId("gateway-demo-recovery-only")).toContainText("New purchases are paused");
  // Every fresh-start entry point is disabled: the picker grid and the lower
  // "THREE WAYS TO PROCURE" grid, not just the first matching button.
  await expect(page.locator(".try-agent-grid button")).toHaveCount(procurementOptions.profiles.length);
  for (const button of await page.locator(".picker-grid button, .try-agent-grid button").all()) {
    await expect(button).toBeDisabled();
  }
  const auditorButtons = await page.getByRole("button", { name: /Security Auditor/ }).all();
  expect(auditorButtons.length).toBeGreaterThanOrEqual(2);
  for (const button of auditorButtons) await expect(button).toBeDisabled();

  await page.getByRole("button", { name: /Check & resume/ }).click();
  await expectAcceptedEvidence(page);
  expect(posts.count).toBe(0);
});

test("recovery-only deployment never re-sends a run whose job id was never received", async ({ context, page }) => {
  const posts = await countProcurementPosts(context);
  await seedStoredRun(page, {
    runId: "recovery-only-unsent-run",
    goal: "A run whose original POST may never have reached the gateway",
    input: storedInput,
    startedAt: new Date().toISOString(),
  });

  await page.goto("/try");
  await expect(page.locator(".resume-banner[role=alert]")).toContainText("give the operator run id recovery-only-unsent-run");
  await page.getByRole("button", { name: /Check & resume/ }).click();

  await expect(page.locator(".bubble.error")).toContainText("run id recovery-only-unsent-run");
  await expect(page.locator(".bubble.error")).toContainText("nothing was sent");
  expect(posts.count).toBe(0);
  // The record stays so the banner keeps the run id until the user dismisses it.
  const stored = await page.evaluate((key) => localStorage.getItem(key), PROCUREMENT_RUN_KEY);
  expect(JSON.parse(stored ?? "null")).toMatchObject({ runId: "recovery-only-unsent-run" });
  await expect(page.locator(".resume-banner[role=alert]")).toBeVisible();
});

test("recovery-only resume follows a job id another tab learned instead of re-sending", async ({ context, page }) => {
  const posts = await countProcurementPosts(context);
  const record = {
    runId: "recovery-only-raced-run",
    goal: "Resume the security audit another tab reconnected",
    input: storedInput,
    startedAt: new Date().toISOString(),
  };
  await seedStoredRun(page, record);

  await page.goto("/try");
  await expect(page.locator(".resume-banner[role=alert]")).toContainText("the job id was never received");
  // Another tab of the same run received the job id after this tab loaded.
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: PROCUREMENT_RUN_KEY,
    value: { ...record, jobId: completedJob.id },
  });
  await page.getByRole("button", { name: /Check & resume/ }).click();

  await expectAcceptedEvidence(page);
  expect(posts.count).toBe(0);
});
