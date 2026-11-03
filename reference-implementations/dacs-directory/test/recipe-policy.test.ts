import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AUTHORITY_ISSUED_SCHEMES, SelfSignedAuthoritySchemeError, VERIFICATION_METHODS, resolveConfiguredRecipe,
  validateRecipeResult, type RecipePolicy } from "../src/catalog/recipePolicy.js";
import { resolveConfiguredRecipe as resolveTierRecipe } from "../src/catalog/identityVerification.js";

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

test("SPEC_PIN and the registry comment describe the nine-method registry the code accepts", () => {
  const pin = readFileSync(new URL("../SPEC_PIN", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/catalog/recipePolicy.ts", import.meta.url), "utf8");
  assert.equal(VERIFICATION_METHODS.length, 9);
  assert.match(pin, /nine-kind DACS-2 VerificationMethod registry/);
  assert.doesNotMatch(pin, /eight-kind/);
  for (const text of [pin, source]) assert.match(text, /demos-gcr-domain/);
});

test("recipe admission enforces the pinned closed method registry before operator narrowing", async () => {
  const methods = ["verifiable-credential", "tlsnotary", "zktls", "consensus-backed-proxy",
    "oauth-attested", "evm-rpc", "domain-tls-control", "self-signed", "demos-gcr-domain"];
  for (const method of methods) {
    const configured = { ...policy, scheme: "key", methods: [method] };
    assert.deepEqual(await validateRecipeResult({ ...raw, scheme: "key", method }, async () => configured), configured, method);
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

const selfSignedPolicy = (scheme: string): RecipePolicy => ({ ...policy, scheme, methods: ["self-signed"] });

async function withPolicyEnv(value: unknown, run: () => Promise<void>) {
  const old = process.env.DACS_RECIPE_POLICIES;
  try { process.env.DACS_RECIPE_POLICIES = JSON.stringify(value); await run(); }
  finally { if (old === undefined) delete process.env.DACS_RECIPE_POLICIES; else process.env.DACS_RECIPE_POLICIES = old; }
}

test("the authority-issued scheme list is the tier-1 row of DACS-1 Claim tiers", () => {
  assert.deepEqual([...AUTHORITY_ISSUED_SCHEMES].sort(), ["cmmc", "fedramp", "finra-crd", "lei", "naics", "sam-uei"]);
});

test("self-signed results are refused for every authority-issued scheme", async () => {
  for (const scheme of AUTHORITY_ISSUED_SCHEMES) {
    const value = { ...raw, scheme, method: "self-signed" };
    assert.equal(await validateRecipeResult(value, async () => selfSignedPolicy(scheme)), null, scheme);
    assert.equal(await validateRecipeResult({ ...value, scheme: scheme.toUpperCase() }, async () => selfSignedPolicy(scheme)), null,
      `${scheme} in upper case`);
  }
});

test("a recipe that lists self-signed for an authority-issued scheme is refused even for another method", async () => {
  const mixed = { ...policy, methods: ["verifiable-credential", "self-signed"] };
  assert.equal(await validateRecipeResult(raw, async () => mixed), null);
});

test("self-signed stays accepted for a scheme that is not authority-issued", async () => {
  for (const scheme of ["key", "did", "x-unknown"]) {
    const configured = selfSignedPolicy(scheme);
    assert.deepEqual(await validateRecipeResult({ ...raw, scheme, method: "self-signed" }, async () => configured), configured, scheme);
  }
});

test("loading DACS_RECIPE_POLICIES refuses self-signed for an authority-issued scheme and names the scheme", async () => {
  for (const load of [resolveConfiguredRecipe, resolveTierRecipe])
    await withPolicyEnv([policy, selfSignedPolicy("sam-uei")], async () => {
      await assert.rejects(load("sam-uei", 1), (error: unknown) => error instanceof SelfSignedAuthoritySchemeError &&
        error.message.includes("sam-uei") && error.message.includes("self-signed"));
    });
});

test("a refused recipe does not affect the lookup of another recipe in the list", async () => {
  for (const load of [resolveConfiguredRecipe, resolveTierRecipe])
    await withPolicyEnv([policy, selfSignedPolicy("naics")], async () => {
      assert.deepEqual(await load("lei", 1), policy);
      await assert.rejects(load("naics", 1), SelfSignedAuthoritySchemeError);
      assert.equal(await load("naics", 2), null, "another version of the scheme is not the selected recipe");
    });
});

test("loading DACS_RECIPE_POLICIES refuses self-signed whatever its letter case or surrounding space", async () => {
  for (const method of ["Self-Signed", "self-signed "])
    await withPolicyEnv([{ ...policy, methods: [method] }], async () => {
      await assert.rejects(resolveConfiguredRecipe("lei", 1), SelfSignedAuthoritySchemeError, method);
    });
});

test("loading DACS_RECIPE_POLICIES refuses the scheme whatever its letter case", async () => {
  await withPolicyEnv([selfSignedPolicy("LEI")], async () => {
    await assert.rejects(resolveConfiguredRecipe("lei", 1), SelfSignedAuthoritySchemeError);
  });
});

test("loading DACS_RECIPE_POLICIES still returns clean policies and self-signed for other schemes", async () => {
  for (const load of [resolveConfiguredRecipe, resolveTierRecipe])
    await withPolicyEnv([policy, selfSignedPolicy("key")], async () => {
      assert.deepEqual(await load("lei", 1), policy);
      assert.deepEqual(await load("key", 1), selfSignedPolicy("key"));
      assert.equal(await load("did", 1), null);
    });
});

test("loading DACS_RECIPE_POLICIES keeps returning null for text that is not JSON", async () => {
  const old = process.env.DACS_RECIPE_POLICIES;
  try { process.env.DACS_RECIPE_POLICIES = "{not json"; assert.equal(await resolveConfiguredRecipe("lei", 1), null); }
  finally { if (old === undefined) delete process.env.DACS_RECIPE_POLICIES; else process.env.DACS_RECIPE_POLICIES = old; }
});
