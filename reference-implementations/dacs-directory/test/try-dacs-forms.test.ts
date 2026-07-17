import assert from "node:assert/strict";
import test from "node:test";

import {
  KNOWN_FORM_AGENTS,
  addRow,
  blankCriterion,
  complianceKindChange,
  criterionCheckChange,
  flattenInputKeys,
  hasBuiltinForm,
  initialAgentInput,
  initialSchemaInput,
  mapGatewayErrors,
  oracleProductChange,
  parseAgentFieldSchema,
  removeRow,
  summarizeAgentInput,
  validateSchemaInput,
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
  // Country is optional at the gateway; omitting it stays locally valid.
  assert.deepEqual(validateAgentInput("compliance", { kind: "entity", name: "Example Holdings Ltd" }), {});
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
  assert.ok(validateAgentInput("compliance", { kind: "person", name: "A", country: 42 }).country, "non-string country is still flagged");
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
  // Bare hosts are accepted by the gateway and must pass locally.
  assert.deepEqual(validateAgentInput("site-auditor", { url: "example.com", samples: 1 }), {});
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
  assert.ok(!("country" in compliance), "optional country starts absent, not as an empty string");
});

test("the gateway's published input schema is consumed, with safe fallback", () => {
  // The companion gateway publishes agents[].input as
  // { name, type, required, description } entries.
  const published = card("future-agent", {
    mode: "sync",
    input: [
      { name: "region", type: "string", required: true, enum: ["eu", "us"], description: "Deployment region" },
      { name: "maxDepth", type: "number", min: 1, max: 5 },
      { name: "dryRun", type: "boolean" },
    ],
  });
  const schema = parseAgentFieldSchema(published);
  assert.equal(schema?.length, 3);
  assert.deepEqual(schema?.[0], { key: "region", label: "Region", kind: "select", required: true, help: "Deployment region", options: ["eu", "us"], min: undefined, max: undefined });
  assert.equal(schema?.[1].kind, "number");
  assert.equal(schema?.[1].label, "Max Depth");
  assert.equal(schema?.[2].kind, "checkbox");

  // Unrepresentable or absent schemas yield null so the caller falls back —
  // a partially rendered schema would silently drop required input.
  assert.equal(parseAgentFieldSchema(card("x")), null);
  assert.equal(parseAgentFieldSchema(card("x", { input: [] })), null);
  assert.equal(parseAgentFieldSchema(card("x", { input: [{ name: "blob", type: "object" }] })), null);
  assert.equal(parseAgentFieldSchema(card("x", { input: [{ name: "", type: "string" }] })), null);
});

test("EvalBot checks match the gateway contract and swap parameters cleanly", () => {
  // Live-probed: the gateway executes content-includes, regex-match, and
  // min-length; min-length without minChars silently scores against
  // "min undefined", so the form must require it.
  assert.ok(validateAgentInput("evalbot", {
    deliverable: { content: "abc" },
    rubric: { acceptThreshold: 80, criteria: [{ id: "len", kind: "mechanical", weight: 1, description: "long", test: { check: "min-length" } }] },
  })["rubric.criteria.0.test.minChars"]);
  assert.deepEqual(validateAgentInput("evalbot", {
    deliverable: { content: "abc" },
    rubric: { acceptThreshold: 80, criteria: [{ id: "len", kind: "mechanical", weight: 1, description: "long", test: { check: "min-length", minChars: 2 } }] },
  }), {});
  assert.deepEqual(validateAgentInput("evalbot", {
    deliverable: { content: "abc" },
    rubric: { acceptThreshold: 80, criteria: [{ id: "rx", kind: "mechanical", weight: 1, description: "match", test: { check: "regex-match", pattern: "a.c" } }] },
  }), {});
  // regex-match REQUIRES pattern (not needle): sending needle leaves pattern
  // undefined, and the gateway runs new RegExp(undefined) which matches all.
  assert.ok(validateAgentInput("evalbot", {
    deliverable: { content: "abc" },
    rubric: { acceptThreshold: 80, criteria: [{ id: "rx", kind: "mechanical", weight: 1, description: "m", test: { check: "regex-match", needle: "a.c" } }] },
  })["rubric.criteria.0.test.pattern"]);
  // An invalid regex is caught locally.
  assert.ok(validateAgentInput("evalbot", {
    deliverable: { content: "abc" },
    rubric: { acceptThreshold: 80, criteria: [{ id: "rx", kind: "mechanical", weight: 1, description: "m", test: { check: "regex-match", pattern: "(" } }] },
  })["rubric.criteria.0.test.pattern"]);

  // Switching check kinds swaps parameters — stale ones are never submitted.
  const toMinLength = criterionCheckChange({ check: "content-includes", needle: "Introduction" }, "min-length");
  assert.deepEqual(toMinLength, { check: "min-length", minChars: 1 });
  const toRegex = criterionCheckChange(toMinLength, "regex-match");
  assert.deepEqual(toRegex, { check: "regex-match", pattern: "" });
  // content-includes text carries into a regex pattern, and back.
  assert.deepEqual(criterionCheckChange({ check: "content-includes", needle: "abc" }, "regex-match"), { check: "regex-match", pattern: "abc" });
  assert.deepEqual(criterionCheckChange({ check: "regex-match", pattern: "abc" }, "content-includes"), { check: "content-includes", needle: "abc" });
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

test("schema-driven forms validate required fields and option/number bounds", () => {
  const schema = parseAgentFieldSchema(card("future-agent", {
    input: [
      { name: "region", type: "string", required: true, enum: ["eu", "us"] },
      { name: "depth", type: "number", min: 1, max: 5 },
    ],
  }))!;
  // Missing required field is flagged; bad enum + out-of-range number too.
  assert.ok(validateSchemaInput(schema, {}).region);
  assert.ok(validateSchemaInput(schema, { region: "mars" }).region);
  assert.ok(validateSchemaInput(schema, { region: "eu", depth: 9 }).depth);
  assert.ok(validateSchemaInput(schema, { region: "eu", depth: "x" }).depth);
  // A complete, in-bounds input passes.
  assert.deepEqual(validateSchemaInput(schema, { region: "eu", depth: 3 }), {});
});

test("schema defaults seed selects/checkboxes so display matches state", () => {
  const schema = parseAgentFieldSchema(card("future-agent", {
    input: [
      { name: "region", type: "string", required: true, enum: ["eu", "us"] },
      { name: "dryRun", type: "boolean", required: true },
      { name: "note", type: "string" },
    ],
  }))!;
  const seeded = initialSchemaInput(schema);
  // A required select is pre-set to its displayed first option (not empty), so
  // it doesn't validate-block while appearing selected.
  assert.equal(seeded.region, "eu");
  assert.deepEqual(validateSchemaInput(schema, seeded).region, undefined);
  // A required checkbox seeds to false and must be checked to pass.
  assert.equal(seeded.dryRun, false);
  assert.ok(validateSchemaInput(schema, seeded).dryRun, "required checkbox must be checked");
  assert.deepEqual(validateSchemaInput(schema, { ...seeded, dryRun: true }).dryRun, undefined);
  // Non-required text stays absent.
  assert.ok(!("note" in seeded));
});
