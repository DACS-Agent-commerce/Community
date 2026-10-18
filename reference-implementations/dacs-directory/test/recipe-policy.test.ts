import assert from "node:assert/strict";
import test from "node:test";
import { validateRecipeResult, type RecipePolicy } from "../src/catalog/recipePolicy.js";

const signer = `did:demos:agent:${"a".repeat(64)}`;
const policy: RecipePolicy = { scheme: "lei", recipeVersion: 1, methods: ["registry"], availability: "live",
  defaultMaxAgeSec: 60, trustedResultSigners: [signer] };
const raw = { scheme: "lei", recipeVersion: 1, method: "registry", signature: { signer, algorithm: "ed25519" } };

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
