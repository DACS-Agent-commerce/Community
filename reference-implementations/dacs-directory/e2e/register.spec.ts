import { expect, test, type Route } from "@playwright/test";
import { LISTING_PUBLICATION_KEY } from "../src/components/listing-publication-recovery.js";

const keyHex = "12".repeat(32);
const claim = `did:demos:agent:${keyHex}`;
const anchorAddress = `stor-${"34".repeat(20)}`;
const programName = "dacs1-ZGFjczEtdGVzdA";
const contentHash = "56".repeat(32);

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
    headers: { "access-control-allow-origin": "*" },
  });
}

test("seller publication survives registration failure and reload without rebroadcasting", async ({ context, page }) => {
  await page.addInitScript((address) => {
    const calls: Array<{ method: string; params?: unknown[] }> = [];
    Object.assign(window, {
      __sellerWalletCalls: calls,
      demos: {
        request: async (request: { method: string; params?: unknown[] }) => {
          calls.push(request);
          if (request.method === "connect") return { success: true, data: { address } };
          if (request.method === "sign") return { success: true, data: { signature: "ab".repeat(64) } };
          if (request.method === "sendTransaction") return { success: true, data: { hash: "mock-listing-tx" } };
          throw new Error(`unexpected wallet method ${request.method}`);
        },
      },
    });
  }, `0x${keyHex}`);

  const unsignedRegistration = {
    primaryClaim: claim,
    displayName: "Recovery service",
    listingAnchors: [anchorAddress],
    deals: [],
  };
  let registrationPosts = 0;
  let confirmationPosts = 0;
  await context.route("**/api/dacs/build-listing", async (route) => {
    const input = route.request().postDataJSON() as { identitySignature?: string };
    if (!input.identitySignature) {
      return json(route, { identityMessage: "identity-message", identityPresentedAt: 1_786_360_000_000 });
    }
    return json(route, {
      listing: { dacsVersion: "1", listingId: "recovery-service", listingVersion: 1 },
      message: "listing-message",
      contentHash,
      logicalAddress: `dacs1:did%3Ademos%3Aagent%3A${keyHex}:recovery-service:v1`,
      programName,
      anchorAddress,
      exists: false,
      tx: {
        content: {
          type: "storageProgram",
          data: ["storageProgram", { operation: "CREATE_STORAGE_PROGRAM", data: "__SIGNED_LISTING__", salt: "" }],
          nonce: 8,
        },
      },
      registration: {
        ...unsignedRegistration,
        ownerSignature: { message: "initial-registration-message", signedAt: 1_786_360_000_000 },
      },
    });
  });
  await context.route("**/api/dacs/confirm-listing", async (route) => {
    confirmationPosts++;
    return json(route, { confirmed: true, state: "verified" });
  });
  await context.route("**/api/dacs/prepare-registration", (route) => json(route, {
    registration: {
      ...unsignedRegistration,
      ownerSignature: { message: `registration-message-${registrationPosts + 1}`, signedAt: Date.now() },
    },
  }));
  await context.route("**/api/dacs/register", async (route) => {
    registrationPosts++;
    return registrationPosts === 1
      ? json(route, { error: "temporary registry write failure" }, 503)
      : json(route, { ok: true, ownerVerified: true, queued: true });
  });

  await page.goto("/register");
  await page.getByRole("button", { name: "Connect Demos wallet" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Service title").fill("Recovery service");
  await page.getByLabel("What the buyer receives").fill("A signed result with restart-safe publication recovery.");
  await page.getByLabel("Service ID").fill("recovery-service");
  await page.getByLabel("Fixed amount").fill("1");
  await page.getByRole("button", { name: "Review listing" }).click();
  await page.getByRole("button", { name: "Sign and publish" }).click();

  await expect(page.getByText("temporary registry write failure", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __sellerWalletCalls: Array<{ method: string }> }).__sellerWalletCalls
      .filter((call) => call.method === "sendTransaction").length
  ))).toBe(1);
  const sentPayload = await page.evaluate(() => {
    const calls = (window as unknown as {
      __sellerWalletCalls: Array<{ method: string; params?: unknown[] }>;
    }).__sellerWalletCalls;
    return calls.find((call) => call.method === "sendTransaction")?.params?.[0] as {
      content?: { data?: [string, { salt?: string; data?: { signature?: { signer?: string } } }] };
    };
  });
  expect(sentPayload.content?.data?.[1].salt).toBe("");
  expect(sentPayload.content?.data?.[1].data?.signature?.signer).toBe(claim);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), LISTING_PUBLICATION_KEY)).not.toBeNull();

  await page.reload();
  await page.getByRole("button", { name: "Connect Demos wallet" }).click();
  await expect(page.getByText(/listing publication from this browser is still unresolved/)).toBeVisible();
  await page.getByRole("button", { name: "Check chain and resume" }).click();

  await expect(page.getByText(/anchored, independently verified, and queued/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __sellerWalletCalls: Array<{ method: string }> }).__sellerWalletCalls
      .filter((call) => call.method === "sendTransaction").length
  ))).toBe(0);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), LISTING_PUBLICATION_KEY)).toBeNull();
  expect(registrationPosts).toBe(2);
  expect(confirmationPosts).toBe(2);
});
