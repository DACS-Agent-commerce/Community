import { expect, test } from "@playwright/test";
import {
  PROCUREMENT_RUN_KEY,
  completedJob,
  expectAcceptedEvidence,
  installMockGateway,
} from "./try-dacs-fixtures.js";

test("recovery-only deployment blocks fresh starts but preserves an existing job", async ({ context, page }) => {
  let posts = 0;
  await installMockGateway(context, {
    onProcurementPost: async (route) => {
      posts += 1;
      await route.abort("blockedbyclient");
    },
  });
  await page.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, {
    key: PROCUREMENT_RUN_KEY,
    value: {
      runId: "recovery-only-existing-run",
      goal: "Resume the existing security audit",
      input: { profileId: "security-audit-rfq", paymentRail: "pay-dem", files: [{ path: "server.js", content: "safe" }] },
      startedAt: "2026-08-18T12:00:00.000Z",
      jobId: completedJob.id,
    },
  });

  await page.goto("/try");
  await expect(page.getByTestId("gateway-demo-recovery-only")).toContainText("New purchases are paused");
  await expect(page.getByRole("button", { name: /Security Auditor/ }).first()).toBeDisabled();

  await page.getByRole("button", { name: /Check & resume/ }).click();
  await expectAcceptedEvidence(page);
  expect(posts).toBe(0);
});
