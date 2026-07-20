import { expect, type BrowserContext, type Page, type Route } from "@playwright/test";

export const PROCUREMENT_RUN_KEY = "dacs-try:procurement-run";
export const PROCUREMENT_LOCK_NAME = "dacs-try:procurement-dispatch";

export const exampleInput = {
  goal: "Audit the supplied source and return a content-bound security report.",
  budgetDem: 5,
  files: [{ path: "app.js", content: "export const greeting = 'hello';\n" }],
};

export const agentCatalog = {
  agents: [{
    name: "procurement-butler",
    label: "Procurement Butler",
    summary: "Runs the complete DACS purchase flow.",
    tags: ["procurement", "paid", "dacs"],
    exampleGoal: exampleInput.goal,
    exampleInput,
    mode: "async",
    input: [
      { name: "goal", type: "string", required: true },
      { name: "budgetDem", type: "number", required: true, min: 1 },
      { name: "files", type: "array", required: true },
    ],
  }],
};

const at = "2026-07-20T12:00:00.000Z";

export const acceptedResult = {
  status: "settled-and-accepted",
  decision: {
    outcome: "selected",
    winner: { provider: "Security Auditor", listingId: "audit-negotiator", price: 1 },
    candidates: [{ provider: "Security Auditor", listingId: "audit-negotiator", askPrice: 1, chosenRail: "pay-dem" }],
  },
  negotiation: {
    protocol: "l2ps",
    terms: { tier: "bounded", deadline: "5 minutes", price: 1 },
    buyerSignature: { party: "buyer", algorithm: "ed25519", value: "buyer-signature" },
    sellerSignature: { party: "seller", algorithm: "ed25519", value: "seller-signature" },
  },
  settlement: {
    amountDem: 1,
    rail: "pay-dem",
    payer: "did:demos:buyer",
    payee: "did:demos:seller",
    txHash: "mock-payment-transaction",
  },
  delivery: { verified: true, report: { findings: [] } },
  evaluation: {
    accepted: true,
    rulingValid: true,
    ruling: { verdict: "accept" },
  },
  bundleVerification: { ok: true },
  reconciliation: { reconciled: true },
  anchors: { listing: "mock-listing-anchor", agreement: "mock-agreement-anchor" },
  transactions: [
    { kind: "listing", name: "DACS-1 listing", address: "mock-listing-anchor", txRef: "mock-listing-tx" },
    { kind: "vet", name: "DACS-2 vet", address: "mock-vet-anchor", txRef: "mock-vet-tx" },
    { kind: "agreement", name: "DACS-3 agreement", address: "mock-agreement-anchor", txRef: "mock-agreement-tx" },
    { kind: "payment", name: "DEM payment", txRef: "mock-payment-transaction" },
    { kind: "bundle", name: "DACS-5 bundle", address: "mock-bundle-anchor", txRef: "mock-bundle-tx" },
  ],
};

export const completedJob = {
  id: "job-e2e-1",
  status: "complete",
  phase: "complete",
  events: [
    { phase: "discovering", label: "Signed listing verified", at, txRef: "mock-listing-tx" },
    { phase: "selecting", label: "Counterparty vet anchored", at, txRef: "mock-vet-tx" },
    { phase: "agreeing", label: "Dual-signed agreement anchored", at, txRef: "mock-agreement-tx" },
    { phase: "settling", label: "Payment evidence recorded", at, txRef: "mock-payment-transaction" },
    { phase: "complete", label: "Reconciled DACS-5 bundle anchored", at, txRef: "mock-bundle-tx" },
  ],
  result: acceptedResult,
};

export type MockGatewayOptions = {
  onProcurementPost?: (route: Route) => Promise<void> | void;
  onProcurementGet?: (route: Route) => Promise<void> | void;
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
    headers: { "access-control-allow-origin": "*" },
  });
}

export async function installMockGateway(context: BrowserContext, options: MockGatewayOptions = {}) {
  await context.route("**/demo/butler/agents", (route) => json(route, agentCatalog));
  await context.route("**/api/dacs/listings?**", (route) => json(route, { listings: [] }));
  await context.route("**/demo/procurement", async (route) => {
    if (route.request().method() === "OPTIONS") return json(route, {});
    if (options.onProcurementPost) return options.onProcurementPost(route);
    return json(route, completedJob);
  });
  await context.route("**/demo/procurement/*", async (route) => {
    if (options.onProcurementGet) return options.onProcurementGet(route);
    return json(route, completedJob);
  });
}

export async function chooseProcurementExample(page: Page) {
  await page.goto("/try");
  const agent = page.getByRole("button", { name: /Procurement Butler/ }).first();
  await expect(agent).toBeVisible();
  await agent.click();
  await page.getByRole("button", { name: "Load example" }).click();
  await expect(page.getByRole("button", { name: /Run this agent/ })).toBeEnabled();
}

export async function expectAcceptedEvidence(page: Page) {
  await expect(page.getByRole("heading", { name: "Procurement Butler result" })).toBeVisible();
  await expect(page.getByText("Settled & accepted", { exact: true })).toBeVisible();
  await expect(page.getByText("broadcast & recorded", { exact: true })).toBeVisible();
  await expect(page.getByText("dual-signed", { exact: true })).toBeVisible();
  await expect(page.getByText("accepted", { exact: true }).last()).toBeVisible();
  await expect(page.locator(".journey-step.complete")).toHaveCount(5);
  await expect(page.getByRole("link", { name: /View on explorer/ })).toBeVisible();
}
