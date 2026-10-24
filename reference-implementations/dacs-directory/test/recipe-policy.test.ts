import assert from "node:assert/strict";
import test from "node:test";
import { validateRecipeResult, type RecipePolicy } from "../src/catalog/recipePolicy.js";

const signer = `did:demos:agent:${"a".repeat(64)}`;
const policy: RecipePolicy = { scheme: "lei", recipeVersion: 1, methods: ["verifiable-credential"], availability: "live",
  defaultMaxAgeSec: 60, trustedResultSigners: [signer] };
const raw = { scheme: "lei", recipeVersion: 1, method: "verifiable-credential", signature: { signer, algorithm: "ed25519" } };

test("recipe admission selects exact version, allowed method and authenticated trusted signer", async () => {
  const check = (value: Record<string, unknown> = raw, recipe: RecipePolicy | null = policy) => validateRecipeResult(value, async () => recipe);
  assert.deepEqual(await check(), policy);
  assert.equal(await check(raw, null), null);
  for (const recipe of [{ ...policy, scheme: "did" }, { ...policy, recipeVersion: 2 }, { ...policy, methods: [] },
    { ...policy, trustedResultSigners: [`did:demos:agent:${"b".repeat(64)}`] }, { ...policy, defaultMaxAgeSec: NaN }])
    assert.equal(await check(raw, recipe), null);
  for (const availability of ["operator_gated", "closed_data", "bilateral", "mocked", "disabled", "failed"] as const)
    assert.equal(await check(raw, { ...policy, availability }), null, availability);
  for (const recipeVersion of [undefined, 0, -1, 1.5, "1"]) assert.equal(await check({ ...raw, recipeVersion }), null);
  assert.equal(await check({ ...raw, method: "external" }), null);
  assert.equal(await check({ ...raw, signature: undefined }), null);
  assert.equal(await check({ ...raw, signature: { signer, algorithm: "unknown" } }), null);
  assert.equal(await validateRecipeResult(raw, async () => { throw new Error("unavailable"); }), null);
  assert.equal(await validateRecipeResult(raw, async () => policy, async () => { throw new Error("key resolver unavailable"); }), null);
});

test("recipe admission enforces the pinned closed method registry before operator narrowing", async () => {
  const methods = ["verifiable-credential", "tlsnotary", "zktls", "consensus-backed-proxy",
    "oauth-attested", "evm-rpc", "domain-tls-control", "self-signed", "demos-gcr-domain"];
  for (const method of methods) {
    const configured = { ...policy, methods: [method] };
    assert.deepEqual(await validateRecipeResult({ ...raw, method }, async () => configured), configured, method);
  }
  assert.equal(await validateRecipeResult({ ...raw, method: "self-signed" }, async () => policy), null,
    "a registered method must still be allowed by the specific recipe");
  for (const method of ["registry", "external", "", "TLSNotary", null, 1]) {
    assert.equal(await validateRecipeResult({ ...raw, method }, async () => ({ ...policy, methods: [method] as string[] })), null,
      "operator configuration cannot introduce an unknown method");
    assert.equal(await validateRecipeResult(raw, async () => ({ ...policy, methods: [...policy.methods, method] as string[] })), null,
      "every configured method must be registered, even unused alternatives");
  }
});
