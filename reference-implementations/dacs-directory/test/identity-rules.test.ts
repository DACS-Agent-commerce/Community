import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { artifactHash } from "../src/catalog/evidenceGraph.js";
import { deriveIdentityTier, resolveConfiguredRecipe, sellerIdentityTier, type RecipePolicy } from "../src/catalog/identityVerification.js";

// The identity tier the Directory reports: a claim counts only through a hash-bound, signed,
// passing VerifyResult from a trusted signer under a live, version-pinned recipe (DACS-2 §7.4-§7.5).
type Obj = Record<string, unknown>;
const seeds = [81, 82].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const dids = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const [TRUSTED, OTHER] = [0, 1];
const at = (n: number) => `stor-${(0xc000 + n).toString(16).padStart(40, "0")}`;
const LEI = "5493001KJTIIGC8Y1R12";
const VERIFIED_AT = 1_000_000;
const NOW = VERIFIED_AT + 1_000;
const attested = { authority: "gleif", record: LEI };

const policy = (change: Partial<RecipePolicy> = {}): RecipePolicy => ({
  scheme: "lei", recipeVersion: 2, methods: ["verifiable-credential"], defaultMaxAgeSec: 3600, availability: "live", trustedResultSigners: [dids[TRUSTED]], ...change,
});
interface Case {
  result?: Obj; signer?: number; envelope?: Obj; claim?: Obj; ref?: Obj; recipe?: RecipePolicy | null;
  now?: number; store?: (store: Map<string, Obj>) => void; scheme?: string;
}

async function tier(c: Case = {}) {
  const scheme = c.scheme ?? "lei";
  const store = new Map<string, Obj>([[at(2), attested]]);
  const result: Obj = {
    resultVersion: "1", scheme, identifier: LEI, recipeVersion: 2, method: "verifiable-credential", decision: "pass", reason: "registry match",
    attestation: { anchor: { kind: "storage-program", locator: at(2) }, contentHash: contentHash(attested) }, fetchedAt: VERIFIED_AT - 10, verifiedAt: VERIFIED_AT,
    ...c.result,
  };
  for (const key of Object.keys(result)) if (result[key] === undefined) delete result[key];
  const signer = c.signer ?? TRUSTED;
  const value = Buffer.from(ed25519Sign(Buffer.from(`dacs-verifyresult:v1:${artifactHash(result, "verify-result")}`, "utf8"), privateKeyFromSeed(seeds[signer]))).toString("base64url");
  const signed = { ...result, signature: { algorithm: "ed25519", signer: dids[signer], value, ...c.envelope } };
  store.set(at(1), signed);
  c.store?.(store);
  const claim = {
    ref: `${scheme}:${LEI}`,
    verifiedBy: { anchor: { kind: "storage-program", locator: at(1) }, contentHash: artifactHash(signed, "verify-result"), recipeVersion: 2, ...c.ref },
    ...c.claim,
  };
  const recipe = c.recipe === undefined ? policy({ scheme }) : c.recipe;
  return deriveIdentityTier({ claims: [claim] }, async (wantScheme, version) =>
    recipe && recipe.scheme === wantScheme && recipe.recipeVersion === version ? recipe : null,
  c.now ?? NOW, async (locator) => store.get(locator) ?? null);
}

test("an institutional scheme verified under a live recipe gives the institutional tier, another scheme gives verified", async () => {
  assert.equal(await tier(), "institutional");
  assert.equal(await tier({ scheme: "domain" }), "verified");
  assert.equal(await tier({ claim: { ref: { scheme: "lei", identifier: LEI } } }), "institutional", "a structured claim reference");
  for (const availability of ["operator_gated", "closed_data", "bilateral"] as const) {
    assert.equal(await tier({ recipe: policy({ availability }) }), "self-declared", `${availability} needs consumer disclosure`);
  }
  assert.equal(await deriveIdentityTier(undefined), "self-declared");
  assert.equal(await deriveIdentityTier({ claims: "lei" }), "self-declared");
  assert.equal(await deriveIdentityTier({ claims: [null, "lei"] }), "self-declared");
});

test("every VerifyResult rule withholds the tier when it fails", async () => {
  const withheld: Record<string, Case> = {
    "a claim ref without a scheme": { claim: { ref: LEI } },
    "a claim ref starting with a colon": { claim: { ref: `:${LEI}` } },
    "a claim ref that is not a string or object": { claim: { ref: 7 } },
    "a structured claim ref without an identifier": { claim: { ref: { scheme: "lei" } } },
    "a structured claim ref with a numeric scheme": { claim: { ref: { scheme: 7, identifier: LEI } } },
    "no verifiedBy": { claim: { verifiedBy: undefined } },
    "a verifiedBy that is not a reference": { ref: { anchor: { kind: "ipfs", locator: at(1) } } },
    "a verifiedBy recipe version as a string": { ref: { recipeVersion: "2" } },
    "an unreadable result": { store: (store) => { store.delete(at(1)); } },
    "a result with another content hash": { ref: { contentHash: "0".repeat(64) } },
    "resultVersion 2": { result: { resultVersion: "2" } },
    "a result for another scheme": { result: { scheme: "domain" } },
    "a result for another identifier": { result: { identifier: "OTHER" } },
    "a failed result": { result: { decision: "fail" } },
    "an indeterminate result": { result: { decision: "indeterminate" } },
    "a result under another recipe version": { result: { recipeVersion: 3 } },
    "a result without verifiedAt": { result: { verifiedAt: undefined } },
    "an unsigned result": { store: (store) => { const { signature: _, ...unsigned } = store.get(at(1))!; store.set(at(1), unsigned); } },
    "a forged signature": { envelope: { value: Buffer.from(ed25519Sign(Buffer.from("other"), privateKeyFromSeed(seeds[TRUSTED]))).toString("base64url") } },
    "a signer with no resolvable key": { envelope: { signer: `cci:${"8".repeat(64)}` } },
    "an untrusted signer": { signer: OTHER },
    "no recipe": { recipe: null },
    "a method the recipe does not allow": { result: { method: "tlsnotary" } },
    "a mocked recipe": { recipe: policy({ availability: "mocked" }) },
    "a disabled recipe": { recipe: policy({ availability: "disabled" }) },
    "a failed recipe": { recipe: policy({ availability: "failed" }) },
    "a recipe trusting another signer": { recipe: policy({ trustedResultSigners: [dids[OTHER]] }) },
    "a recipe trusting an unresolvable signer": { recipe: policy({ trustedResultSigners: ["cci:unknown"] }) },
    "validUntil before verifiedAt": { result: { validUntil: VERIFIED_AT - 1 } },
    "a past validUntil": { result: { validUntil: NOW - 1 } },
    "a result older than the recipe's maximum age": { now: VERIFIED_AT + 3_600_000 + 1 },
    "an expired claim wrapper": { claim: { expiresAt: NOW - 1 } },
    "no authority attestation": { result: { attestation: undefined } },
    "an attestation that is not a reference": { result: { attestation: { anchor: { kind: "storage-program", locator: at(2) } } } },
    "an unreadable attestation": { store: (store) => { store.delete(at(2)); } },
    "an attestation with another hash": { store: (store) => { store.set(at(2), { ...attested, record: "OTHER" }); } },
  };
  const results: Record<string, string> = {};
  for (const [name, c] of Object.entries(withheld)) results[name] = await tier(c);
  assert.deepEqual(results, Object.fromEntries(Object.keys(withheld).map((name) => [name, "self-declared"])));
  // Boundaries that still count: expiry exactly now, by validUntil, by the recipe's age, or by the claim wrapper.
  assert.equal(await tier({ result: { validUntil: NOW } }), "institutional");
  assert.equal(await tier({ now: VERIFIED_AT + 3_600_000 }), "institutional");
  assert.equal(await tier({ claim: { expiresAt: NOW } }), "institutional");
  assert.equal(await tier({ result: { validUntil: VERIFIED_AT } , now: VERIFIED_AT }), "institutional");
});

test("one verified claim is enough, and an institutional scheme outranks the rest", async () => {
  const claims = async (schemes: string[]) => {
    const store = new Map<string, Obj>([[at(2), attested]]);
    const claimsList: Obj[] = [];
    for (const [index, scheme] of schemes.entries()) {
      const result: Obj = { resultVersion: "1", scheme, identifier: LEI, recipeVersion: 2, method: "verifiable-credential", decision: "pass", reason: "ok",
        attestation: { anchor: { kind: "storage-program", locator: at(2) }, contentHash: contentHash(attested) }, fetchedAt: 1, verifiedAt: VERIFIED_AT };
      const value = Buffer.from(ed25519Sign(Buffer.from(`dacs-verifyresult:v1:${artifactHash(result, "verify-result")}`), privateKeyFromSeed(seeds[TRUSTED]))).toString("base64url");
      const signed = { ...result, signature: { algorithm: "ed25519", signer: dids[TRUSTED], value } };
      store.set(at(10 + index), signed);
      claimsList.push({ ref: `${scheme}:${LEI}`, verifiedBy: { anchor: { kind: "storage-program", locator: at(10 + index) }, contentHash: artifactHash(signed, "verify-result"), recipeVersion: 2 } });
    }
    claimsList.push({ ref: "github:unverified" });
    return deriveIdentityTier({ claims: claimsList }, async (scheme) => policy({ scheme }), NOW, async (locator) => store.get(locator) ?? null);
  };
  assert.equal(await claims(["domain", "lei"]), "institutional");
  assert.equal(await claims(["domain", "github"]), "verified");
  for (const scheme of ["finra-crd", "sam-uei", "fedramp", "cmmc", "naics"]) assert.equal(await claims([scheme]), "institutional", scheme);
  assert.equal(await claims([]), "self-declared");
});

test("recipe policy comes only from the configured, version-pinned list", async () => {
  const original = process.env.DACS_RECIPE_POLICIES;
  try {
    process.env.DACS_RECIPE_POLICIES = JSON.stringify([policy(), policy({ scheme: "domain", recipeVersion: 1 })]);
    assert.deepEqual(await resolveConfiguredRecipe("lei", 2), policy());
    assert.equal((await resolveConfiguredRecipe("domain", 1))?.scheme, "domain");
    assert.equal(await resolveConfiguredRecipe("lei", 1), null);
    assert.equal(await resolveConfiguredRecipe("domain", 2), null);
    process.env.DACS_RECIPE_POLICIES = "{not json";
    assert.equal(await resolveConfiguredRecipe("lei", 2), null);
    delete process.env.DACS_RECIPE_POLICIES;
    assert.equal(await resolveConfiguredRecipe("lei", 2), null);
  } finally {
    if (original === undefined) delete process.env.DACS_RECIPE_POLICIES; else process.env.DACS_RECIPE_POLICIES = original;
  }
});

test("further identity rules: any listed trusted signer counts, and an inverted window never does", async () => {
  assert.equal(await tier({ recipe: policy({ trustedResultSigners: [dids[OTHER], dids[TRUSTED]] }) }), "institutional");
  assert.equal(await tier({ recipe: policy({ trustedResultSigners: ["cci:unknown", dids[TRUSTED]] }) }), "institutional");
  // validUntil before verifiedAt is never valid, even before validUntil passes.
  assert.equal(await tier({ result: { validUntil: VERIFIED_AT - 10 }, now: VERIFIED_AT - 20 }), "self-declared");
});

test("IT-1..IT-3 at the seller: the highest tier among its listings' bundles", () => {
  assert.equal(sellerIdentityTier([]), "self-declared");
  assert.equal(sellerIdentityTier(["self-declared", "self-declared"]), "self-declared");
  assert.equal(sellerIdentityTier(["self-declared", "verified"]), "verified");
  assert.equal(sellerIdentityTier(["verified", "institutional", "self-declared"]), "institutional");
});
