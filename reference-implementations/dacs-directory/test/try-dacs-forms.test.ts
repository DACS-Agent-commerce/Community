import assert from "node:assert/strict";
import test from "node:test";

import {
  KNOWN_FORM_AGENTS,
  addRow,
  blankCriterion,
  complianceKindChange,
  flattenInputKeys,
  hasBuiltinForm,
  initialAgentInput,
  mapGatewayErrors,
  oracleProductChange,
  parseAgentFieldSchema,
  removeRow,
  summarizeAgentInput,
  validateAgentInput,
} from "../src/components/try-dacs-forms.js";
import type { AgentCard } from "../src/components/try-dacs-contract.js";

const card = (name: string, extra: Record<string, unknown> = {}): AgentCard & { fields?: unknown } => ({
  name, label: name, summary: "s", tags: [], exampleGoal: "g", exampleInput: {}, ...extra,
});

test("every published agent has a usable form path", () => {
  for (const name of KNOWN_FORM_AGENTS) {
    assert.equal(hasBuiltinForm(name), true, `${name} must have a built-in form`);
    const initial = initialAgentInput(name);
    assert.ok(initial && typeof initial === "object" && !Array.isArray(initial));
  }
  // Unknown agents fall back safely (Advanced JSON) rather than crashing.
  assert.equal(hasBuiltinForm("future-agent"), false);
  assert.deepEqual(initialAgentInput("future-agent"), {});
});

test("forms produce the exact expected gateway input objects", () => {
  // Each shape mirrors the live gateway's own exampleInput contract.
  const procurement = {
    goal: "procure a content-bound security audit of the posted source",
    budgetDem: 5,
    files: [{ path: "server.js", content: "eval(x)\n" }],
  };
  assert.deepEqual(validateAgentInput("procurement-butler", procurement), {});

  const oracle = { product: "crypto-price", params: { id: "bitcoin" } };
  assert.deepEqual(validateAgentInput("oracle-desk", oracle), {});

  const dd = { kind: "npm-package", subject: "express" };
  assert.deepEqual(validateAgentInput("dd-researcher", dd), {});

  const dep = { packageJson: { name: "demo", dependencies: { lodash: "4.17.20" } }, includeNextMajor: false };
  assert.deepEqual(validateAgentInput("dep-upgrade", dep), {});

  const evalbot = {
    rubric: { criteria: [{ id: "intro", kind: "mechanical", weight: 1, description: "Has an introduction", test: { check: "content-includes", needle: "Introduction" } }], acceptThreshold: 80 },
    deliverable: { content: "# Introduction\nA concise, testable deliverable." },
  };
  assert.deepEqual(validateAgentInput("evalbot", evalbot), {});

  const treasury = {
    policy: { accounts: [{ id: "ops", kind: "operating", minBalance: 100 }], allowlist: [], payroll: [], maxPerTransfer: 1000, maxPerRun: 2000 },
    balances: { ops: 500 },
  };
  assert.deepEqual(validateAgentInput("treasury-ops", treasury), {});

  const site = { url: "https://example.com", samples: 1 };
  assert.deepEqual(validateAgentInput("site-auditor", site), {});

  const sec = { files: [{ path: "server.js", content: "const t = process.env.API_TOKEN;\n" }] };
  assert.deepEqual(validateAgentInput("sec-audit", sec), {});

  const compliance = { kind: "entity", name: "Example Holdings Ltd", country: "GB" };
  assert.deepEqual(validateAgentInput("compliance", compliance), {});
});

test("conditional compliance fields switch between name and walletAddress", () => {
  const entity = { kind: "entity", name: "Example Holdings Ltd", country: "GB" };
  const wallet = complianceKindChange(entity, "wallet");
  assert.equal(wallet.kind, "wallet");
  assert.ok(!("name" in wallet), "stale name must not be submitted for a wallet subject");
  assert.equal(wallet.walletAddress, "");
  assert.ok("country" in wallet);

  const back = complianceKindChange({ ...wallet, walletAddress: "0xabc" }, "person");
  assert.ok(!("walletAddress" in back), "stale walletAddress must not be submitted for a person");
  assert.equal(back.name, "");

  // Validation matches the gateway's authoritative rule ("kind=wallet requires walletAddress").
  assert.ok(validateAgentInput("compliance", { kind: "wallet", country: "GB" }).walletAddress);
  assert.ok(validateAgentInput("compliance", { kind: "person", country: "GB" }).name);
});

test("oracle product change resets params to the product defaults", () => {
  const initial = initialAgentInput("oracle-desk");
  assert.deepEqual(initial.params, { id: "bitcoin" });
  const fx = oracleProductChange(initial, "fx-rate");
  assert.deepEqual(fx.params, { base: "USD", quote: "EUR" });
  const height = oracleProductChange(fx, "chain-height");
  assert.deepEqual(height.params, {});
});

test("repeatable rows add and remove with a minimum floor", () => {
  const one = [{ path: "a", content: "1" }];
  const two = addRow(one, { path: "", content: "" });
  assert.equal(two.length, 2);
  assert.equal(removeRow(two, 0, 1).length, 1);
  assert.equal(removeRow(one, 0, 1), one, "the last row cannot be removed");
  const criteria = addRow([blankCriterion()], blankCriterion());
  assert.equal(criteria.length, 2);
});

test("invalid URLs, budgets, sample counts, and thresholds are blocked locally", () => {
  assert.ok(validateAgentInput("site-auditor", { url: "not-a-url", samples: 1 }).url);
  assert.ok(validateAgentInput("site-auditor", { url: "https://example.com", samples: 0 }).samples);
  assert.ok(validateAgentInput("site-auditor", { url: "https://example.com", samples: 6 }).samples);
  assert.ok(validateAgentInput("site-auditor", { url: "https://example.com", samples: 2.5 }).samples);
  assert.ok(validateAgentInput("procurement-butler", { goal: "g", budgetDem: 0, files: [{ path: "a", content: "b" }] }).budgetDem);
  assert.ok(validateAgentInput("procurement-butler", { goal: "g", budgetDem: -5, files: [{ path: "a", content: "b" }] }).budgetDem);
  assert.ok(validateAgentInput("evalbot", {
    deliverable: { content: "x" },
    rubric: { acceptThreshold: 101, criteria: [blankCriterion()] },
  })["rubric.acceptThreshold"]);
  // Malformed package.json objects are rejected (arrays/strings/empty).
  assert.ok(validateAgentInput("dep-upgrade", { packageJson: [], includeNextMajor: false }).packageJson);
  assert.ok(validateAgentInput("dep-upgrade", { packageJson: {}, includeNextMajor: false }).packageJson);
  assert.ok(validateAgentInput("sec-audit", { files: [{ path: "a", content: "b" }], packageJson: "nope" }).packageJson);
});

test("gateway validation errors map beside the relevant fields", () => {
  // Real gateway detail line observed live.
  const oracle = mapGatewayErrors(
    "input validation failed for oracle-desk",
    ['field "product"="__unknown__" is not one of: crypto-price, fx-rate, chain-height'],
    flattenInputKeys({ product: "__unknown__", params: {} }),
  );
  assert.ok(oracle.byField.product?.includes("is not one of"));
  assert.deepEqual(oracle.global, []);

  // Real agent_error message observed live.
  const compliance = mapGatewayErrors(
    "kind=wallet requires walletAddress",
    undefined,
    flattenInputKeys({ kind: "wallet", country: "GB" }),
  );
  assert.ok(compliance.byField.walletAddress);

  // Unattributable messages stay global and visible.
  const unknown = mapGatewayErrors("demo rate limit reached; try again later", undefined, []);
  assert.deepEqual(unknown.byField, {});
  assert.deepEqual(unknown.global, ["demo rate limit reached; try again later"]);
});

test("switching agents resets incompatible state", () => {
  const site = initialAgentInput("site-auditor");
  const compliance = initialAgentInput("compliance");
  assert.ok("url" in site && !("url" in compliance));
  assert.ok("kind" in compliance && !("kind" in site));
  // Blank defaults are not the example fixtures: examples are opt-in.
  assert.equal(site.url, "");
  assert.equal((compliance as { name?: string }).name, "");
});

test("a future catalog field schema is consumed when published, with safe fallback", () => {
  const published = card("future-agent", {
    fields: [
      { key: "region", label: "Region", kind: "select", required: true, options: ["eu", "us"] },
      { key: "depth", label: "Depth", kind: "number", min: 1, max: 5 },
    ],
  });
  const schema = parseAgentFieldSchema(published);
  assert.equal(schema?.length, 2);
  assert.equal(schema?.[0].kind, "select");
  assert.deepEqual(schema?.[0].options, ["eu", "us"]);

  // Malformed or absent schemas yield null so the caller falls back.
  assert.equal(parseAgentFieldSchema(card("x")), null);
  assert.equal(parseAgentFieldSchema(card("x", { fields: [] })), null);
  assert.equal(parseAgentFieldSchema(card("x", { fields: [{ key: "k", label: "L", kind: "mystery" }] })), null);
  assert.equal(parseAgentFieldSchema(card("x", { fields: [{ key: "", label: "L", kind: "text" }] })), null);
});

test("submission summaries state the actual values being sent", () => {
  const lines = summarizeAgentInput("site-auditor", { url: "https://example.com", samples: 3 });
  assert.deepEqual(lines, ["URL: https://example.com", "Samples: 3"]);
  const compliance = summarizeAgentInput("compliance", { kind: "wallet", walletAddress: "0xabc", country: "GB" });
  assert.ok(compliance.some((line) => line.includes("0xabc")));
  const procurement = summarizeAgentInput("procurement-butler", {
    goal: "audit", budgetDem: 5, files: [{ path: "server.js", content: "x" }],
  });
  assert.ok(procurement.some((line) => line.includes("5 DEM")));
  assert.ok(procurement.some((line) => line.includes("server.js")));
});
