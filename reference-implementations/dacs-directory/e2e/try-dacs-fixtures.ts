import { expect, type BrowserContext, type Page, type Route } from "@playwright/test";

export const PROCUREMENT_RUN_KEY = "dacs-try:procurement-run";
export const PROCUREMENT_LOCK_NAME = "dacs-try:procurement-dispatch";

export const exampleInput = {
  goal: "Audit the supplied source and return a content-bound security report.",
  budgetDem: 5,
  files: [{ path: "app.js", content: "export const greeting = 'hello';\n" }],
};

const x402Governance = {
  status: "operator-provisional",
  conformantAuthority: false,
  signer: "did:demos:agent:mock-steward",
  disclosure: "https://github.com/DACS-Agent-commerce/DACS-Standard/issues/274",
};

function railReadiness() {
  return {
    "pay-dem": { executable: true, reasons: [] },
    "pay-x402": { executable: true, reasons: [], railGovernance: x402Governance },
  };
}

const commonProfile = {
  timing: { healthyMinSec: 10, healthyMaxSec: 30, hardTimeoutSec: 180, protocolFloorSec: 0 },
  confirmationGates: ["commit-agreement", "payment"],
  paymentRails: ["pay-dem", "pay-x402"],
  implementationStatus: "live",
  executable: true,
  reasons: [],
};

export const procurementOptions = {
  profiles: [
    {
      ...commonProfile,
      id: "oracle-auto-accept",
      title: "Buy an attested crypto price",
      agentName: "Oracle Desk",
      serviceId: "oracle-data",
      mode: "fixed-price-auto-accept",
      negotiationPhase: "negotiate-fixed-price",
      summary: "Buy a posted-price public data point.",
      fields: [],
      sampleInput: { product: "crypto-price", params: { id: "bitcoin" }, paymentRail: "pay-dem" },
      railInputs: [
        { rail: "pay-dem", fields: [], sampleInput: { product: "crypto-price", params: { id: "bitcoin" }, paymentRail: "pay-dem" } },
        { rail: "pay-x402", fields: [], sampleInput: { product: "crypto-price", params: { id: "bitcoin" }, paymentRail: "pay-x402" } },
      ],
      railReadiness: railReadiness(),
    },
    {
      ...commonProfile,
      id: "dd-live-fixed",
      title: "Commission a due-diligence report",
      agentName: "Due Diligence Researcher",
      serviceId: "due-diligence",
      mode: "fixed-price-co-sign",
      negotiationPhase: "negotiate-fixed-price",
      summary: "Buy a jointly signed fixed-price research report.",
      fields: [],
      sampleInput: { kind: "npm-package", subject: "express", paymentRail: "pay-dem" },
      railInputs: [
        { rail: "pay-dem", fields: [], sampleInput: { kind: "npm-package", subject: "express", paymentRail: "pay-dem" } },
        { rail: "pay-x402", fields: [], sampleInput: { kind: "npm-package", subject: "express", paymentRail: "pay-x402" } },
      ],
      railReadiness: railReadiness(),
    },
    {
      ...commonProfile,
      id: "security-audit-rfq",
      title: "Negotiate a bounded security audit",
      agentName: "Security Auditor",
      serviceId: "security-audit",
      mode: "rfq",
      negotiationPhase: "negotiate-rfq",
      summary: "Run a live RFQ and buy a content-bound security report.",
      fields: [],
      sampleInput: { ...exampleInput, paymentRail: "pay-dem" },
      railInputs: [
        { rail: "pay-dem", fields: [], sampleInput: { ...exampleInput, paymentRail: "pay-dem" } },
        {
          rail: "pay-x402",
          fields: [],
          sampleInput: { goal: exampleInput.goal, budgetUsdc: 0.1, files: exampleInput.files, paymentRail: "pay-x402" },
        },
      ],
      railReadiness: railReadiness(),
    },
  ],
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

const x402PaymentTx = `0x${"ab".repeat(32)}`;

export const x402CompletedJob = {
  ...completedJob,
  events: completedJob.events.map((event) => event.phase === "settling"
    ? { ...event, txRef: x402PaymentTx }
    : event),
  result: {
    ...acceptedResult,
    decision: {
      ...acceptedResult.decision,
      winner: { ...acceptedResult.decision.winner, price: 0.05 },
      candidates: acceptedResult.decision.candidates.map((candidate) => ({
        ...candidate,
        askPrice: 0.05,
        chosenRail: "pay-x402",
      })),
    },
    negotiation: {
      ...acceptedResult.negotiation,
      terms: { ...acceptedResult.negotiation.terms, price: { amount: 0.05, currency: "USDC" } },
    },
    settlement: {
      amount: { amount: 0.05, currency: "USDC" },
      rail: "pay-x402",
      payer: "0x1111111111111111111111111111111111111111",
      payee: "0x2222222222222222222222222222222222222222",
      txHash: x402PaymentTx,
      railGovernance: x402Governance,
    },
    transactions: acceptedResult.transactions.map((transaction) => transaction.kind === "payment"
      ? { ...transaction, name: "x402 USDC payment", txRef: x402PaymentTx }
      : transaction),
  },
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
  await context.route("**/api/dacs/listings?**", (route) => json(route, { listings: [] }));
  // Register the wildcard first: Playwright evaluates matching routes in
  // reverse registration order, so the explicit /options contract below wins.
  await context.route("**/demo/procurement/*", async (route) => {
    if (options.onProcurementGet) return options.onProcurementGet(route);
    return json(route, completedJob);
  });
  await context.route("**/demo/procurement", async (route) => {
    if (route.request().method() === "OPTIONS") return json(route, {});
    if (options.onProcurementPost) return options.onProcurementPost(route);
    return json(route, completedJob);
  });
  await context.route("**/demo/procurement/options", (route) => json(route, procurementOptions));
}

export async function chooseProcurementExample(page: Page, rail: "pay-dem" | "pay-x402" = "pay-dem") {
  await page.goto("/try");
  const agent = page.getByRole("button", { name: /Security Auditor/ }).first();
  await expect(agent).toBeVisible();
  await agent.click();
  const railName = rail === "pay-x402" ? /USDC · x402/ : /DEM · Demos/;
  const railButton = page.getByRole("group", { name: "Payment rail" }).getByRole("button", { name: railName });
  await expect(railButton).toBeEnabled();
  await railButton.click();
  await page.getByRole("button", { name: "Load example" }).click();
  await expect(page.getByRole("button", { name: /Run the full deal/ })).toBeEnabled();
}

export async function expectAcceptedEvidence(page: Page) {
  await expect(page.getByRole("heading", { name: "Security Auditor result" })).toBeVisible();
  await expect(page.getByText("Settled & accepted", { exact: true })).toBeVisible();
  await expect(page.getByText("broadcast & recorded", { exact: true })).toBeVisible();
  await expect(page.getByText("dual-signed", { exact: true })).toBeVisible();
  await expect(page.getByText("accepted", { exact: true }).last()).toBeVisible();
  await expect(page.locator(".journey-step.complete")).toHaveCount(5);
  await expect(page.getByRole("link", { name: /View on explorer/ })).toBeVisible();
}
