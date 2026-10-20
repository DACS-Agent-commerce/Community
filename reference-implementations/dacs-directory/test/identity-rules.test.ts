import { authorityProof, authoritySigner, proofHash, verifyTestAuthority } from "./helpers/authority.js";
import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import type { VerifyAuthorityAttestation } from "../src/catalog/authorityAttestation.js";
import { artifactHash } from "../src/catalog/evidenceGraph.js";
import { deriveIdentityTier, resolveConfiguredRecipe, sellerIdentityTier, type RecipePolicy } from "../src/catalog/identityVerification.js";

// The identity tier the Directory reports (DACS-1 §6.3.2.1 IT-1..IT-3): a claim counts only when its
// verifiedBy passes the §6.3.2 reference checks, a hash-bound, signed, passing VerifyResult (DACS-2 §7.5)
// from a trusted signer under a live, version-pinned recipe, with an authenticated authority proof (§7.5.2).
type Obj = Record<string, unknown>;
const seeds = [81, 82].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const dids = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const [TRUSTED, OTHER] = [0, 1];
const at = (n: number) => `stor-${(0xc000 + n).toString(16).padStart(40, "0")}`;
const LEI = "5493001KJTIIGC8Y1R12";
const VERIFIED_AT = 1_000_000;
const NOW = VERIFIED_AT + 1_000;
const attested = authorityProof({ authority: "gleif", record: LEI });

const policy = (change: Partial<RecipePolicy> = {}): RecipePolicy => ({
  scheme: "lei", recipeVersion: 2, methods: ["verifiable-credential"], defaultMaxAgeSec: 3600, availability: "live", trustedResultSigners: [dids[TRUSTED]], ...change,
});
interface Case {
  result?: Obj; signer?: number; envelope?: Obj; claim?: Obj; ref?: Obj; recipe?: RecipePolicy | null; recipes?: RecipePolicy[];
  proof?: Obj; authenticate?: boolean; adapter?: VerifyAuthorityAttestation; bundle?: Obj;
  now?: number; store?: (store: Map<string, Obj>) => void; scheme?: string;
}

async function tier(c: Case = {}) {
  const scheme = c.scheme ?? "lei";
  const proof = c.proof ?? attested;
  const store = new Map<string, Obj>([[at(2), proof]]);
  const result: Obj = {
    resultVersion: "1", scheme, identifier: LEI, recipeVersion: 2, method: "verifiable-credential", decision: "pass", reason: "registry match",
    attestation: { anchor: { kind: "storage-program", locator: at(2) }, contentHash: proofHash(proof), signer: authoritySigner }, fetchedAt: VERIFIED_AT - 10, verifiedAt: VERIFIED_AT,
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
  const recipes = c.recipes ?? [c.recipe === undefined ? policy({ scheme }) : c.recipe];
  return deriveIdentityTier({ claims: [claim], ...c.bundle }, async (wantScheme, version) =>
    recipes.find((recipe) => recipe && recipe.scheme === wantScheme && recipe.recipeVersion === version) ?? null,
  c.now ?? NOW, async (locator) => store.get(locator) ?? null, undefined, c.adapter ?? (c.authenticate === false ? undefined : verifyTestAuthority));
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

test("each claim, VerifyResult, recipe, freshness and authority-proof rule withholds the tier when it fails", async () => {
  const withheld: Record<string, Case> = {
    "an unregistered claim scheme (BR-4)": { scheme: "github" },
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
    // DACS-2 §7.5: reason and fetchedAt are required VerifyResult members.
    "a result without reason": { result: { reason: undefined } },
    "a numeric reason": { result: { reason: 7 } },
    "a result without fetchedAt": { result: { fetchedAt: undefined } },
    "a string fetchedAt": { result: { fetchedAt: String(VERIFIED_AT - 10) } },
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
    "a string wrapper issuedAt": { claim: { issuedAt: "999" } },
    "a null wrapper issuedAt": { claim: { issuedAt: null } },
    "a string validUntil": { result: { validUntil: "999" } },
    "a null validUntil": { result: { validUntil: null } },
    "a string wrapper expiry": { claim: { expiresAt: "999" } },
    "a null wrapper expiry": { claim: { expiresAt: null } },
    "a future verifiedAt": { result: { verifiedAt: NOW + 1 } },
    "a past validUntil": { result: { validUntil: NOW - 1 } },
    "a result older than the recipe's maximum age": { now: VERIFIED_AT + 3_600_000 + 1 },
    "an expired claim wrapper": { claim: { expiresAt: NOW - 1 } },
    // DACS-1 §6.3.2 "presenter narrows only": a later wrapper expiry never extends the authority window.
    "a later wrapper expiry over a past validUntil": { result: { validUntil: NOW - 1 }, claim: { expiresAt: NOW + 1000 } },
    "a later wrapper expiry over the recipe's maximum age": { claim: { expiresAt: NOW + 1e7 }, now: VERIFIED_AT + 3_600_001 },
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
  // Issuance is the result's verifiedAt: a numeric wrapper issuedAt, even a later one, is ignored.
  assert.equal(await tier({ claim: { issuedAt: VERIFIED_AT - 5 } }), "institutional");
  assert.equal(await tier({ claim: { issuedAt: NOW + 1e7 } }), "institutional");
});

test("claim and result identities compare canonically: scheme case, identifier rules and parameters (DACS-1 §6.3.1, CF-1..3)", async () => {
  const canonical: Record<string, Case> = {
    "an upper-case claim scheme": { claim: { ref: `LEI:${LEI}` } },
    "an upper-case result scheme": { result: { scheme: "LEI" } },
    "upper-case claim and result schemes": { claim: { ref: `LEI:${LEI}` }, result: { scheme: "LEI" } },
    "a structured claim ref with a mixed-case scheme": { claim: { ref: { scheme: "Lei", identifier: LEI } } },
    "a lower-case LEI identifier": { claim: { ref: `lei:${LEI.toLowerCase()}` } },
    "a claim ref with parameters": { claim: { ref: `lei:${LEI}?jurisdiction=US` } },
  };
  const results: Record<string, string> = {};
  for (const [name, c] of Object.entries(canonical)) results[name] = await tier(c);
  assert.deepEqual(results, Object.fromEntries(Object.keys(canonical).map((name) => [name, "institutional"])));
  assert.equal(await tier({ scheme: "domain", claim: { ref: "DOMAIN:Example.COM" }, result: { identifier: "example.com" } }), "verified");
});

test("IT-2: a presenter's identityTier is ignored and recomputed", async () => {
  assert.equal(await tier({ bundle: { identityTier: "self-declared" } }), "institutional");
  assert.equal(await tier({ bundle: { identityTier: "institutional" }, recipe: null }), "self-declared");
});

test("the maximum age comes from the result's exact recipe version, never a later one (DACS-1 §6.3.2)", async () => {
  const recipes = [policy(), policy({ recipeVersion: 3, defaultMaxAgeSec: 36_000 })];
  const now = VERIFIED_AT + 3_600_001;
  assert.equal(await tier({ recipes, now }), "self-declared", "a later version's longer maximum age does not widen a version 2 result");
  assert.equal(await tier({ recipes, now, result: { recipeVersion: 3 }, ref: { recipeVersion: 3 } }), "institutional");
});

test("the authority proof's content hash is checked whatever the adapter answers (DACS-2 §7.5.2 step 2)", async () => {
  const accept = async () => true;
  const attestationWith = (contentHash: string) => ({ anchor: { kind: "storage-program", locator: at(2) }, contentHash, signer: authoritySigner });
  assert.equal(await tier({ adapter: accept }), "institutional");
  assert.equal(await tier({ adapter: accept, store: (store) => store.set(at(2), { ...attested, record: "OTHER" }) }), "self-declared");
  assert.equal(await tier({ adapter: accept, result: { attestation: attestationWith("0".repeat(64)) } }), "self-declared");
  assert.equal(await tier({ adapter: accept, result: { attestation: attestationWith(`sha256:${proofHash(attested).toUpperCase()}`) } }), "institutional",
    "the same hash forms a VerifyResultRef accepts");
});

test("one verified claim is enough, and an institutional scheme outranks the rest", async () => {
  const claims = async (schemes: string[]) => {
    const store = new Map<string, Obj>([[at(2), attested]]);
    const claimsList: Obj[] = [];
    for (const [index, scheme] of schemes.entries()) {
      const result: Obj = { resultVersion: "1", scheme, identifier: LEI, recipeVersion: 2, method: "verifiable-credential", decision: "pass", reason: "ok",
        attestation: { anchor: { kind: "storage-program", locator: at(2) }, contentHash: proofHash(attested), signer: authoritySigner }, fetchedAt: 1, verifiedAt: VERIFIED_AT };
      const value = Buffer.from(ed25519Sign(Buffer.from(`dacs-verifyresult:v1:${artifactHash(result, "verify-result")}`), privateKeyFromSeed(seeds[TRUSTED]))).toString("base64url");
      const signed = { ...result, signature: { algorithm: "ed25519", signer: dids[TRUSTED], value } };
      store.set(at(10 + index), signed);
      claimsList.push({ ref: `${scheme}:${LEI}`, verifiedBy: { anchor: { kind: "storage-program", locator: at(10 + index) }, contentHash: artifactHash(signed, "verify-result"), recipeVersion: 2 } });
    }
    claimsList.push({ ref: "github:unverified" });
    return deriveIdentityTier({ claims: claimsList }, async (scheme) => policy({ scheme }), NOW, async (locator) => store.get(locator) ?? null, undefined, verifyTestAuthority);
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
  // validUntil before verifiedAt is never valid, even before validUntil passes. Before verifiedAt the
  // stricter future-verifiedAt rule (a SPEC_PIN deviation) also withholds it.
  assert.equal(await tier({ result: { validUntil: VERIFIED_AT - 10 }, now: VERIFIED_AT - 20 }), "self-declared");
});

test("the seller tier, a Directory extension: the highest IT-1 tier among its listings' bundles", () => {
  assert.equal(sellerIdentityTier([]), "self-declared");
  assert.equal(sellerIdentityTier(["self-declared", "self-declared"]), "self-declared");
  assert.equal(sellerIdentityTier(["self-declared", "verified"]), "verified");
  assert.equal(sellerIdentityTier(["verified", "institutional", "self-declared"]), "institutional");
});

test("authority proof authentication is mandatory independently of the trusted result signer", async () => {
  assert.equal(await tier({ authenticate: false }), "self-declared");
  const { signature: _, ...unsigned } = attested;
  for (const proof of [unsigned, { ...attested, signature: "A".repeat(86) }, authorityProof({ authority: "gleif", record: LEI }, 8),
    { ...attested, signer: dids[OTHER] }]) {
    assert.equal(await tier({ proof }), "self-declared", "missing, forged, wrong-epoch and wrong-signer proofs stay unverified even when rehashed");
  }
  assert.equal(await tier({ store: (store) => store.set(at(2), { ...attested, signature: "A".repeat(86) }) }), "self-declared", "signature-only tampering changes authority integrity");
});
