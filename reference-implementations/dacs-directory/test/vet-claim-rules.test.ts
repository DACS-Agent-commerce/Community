import assert from "node:assert/strict";
import test from "node:test";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { artifactHash, type ResolvedEvidence } from "../src/catalog/evidenceGraph.js";
import { matchesVetRequirement } from "../src/catalog/vetClaimRules.js";

type Obj = Record<string, unknown>;
const seed = new Uint8Array(32).fill(17);
const signer = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const locator = `stor-${"a".repeat(40)}`;
function proof(scheme = "lei", identifier = "ABC", change: Obj = {}, claimChange: Obj = {}) {
  const scope = { resultVersion: "1", scheme, identifier, recipeVersion: 1, method: "registry", decision: "pass", verifiedAt: 20, validUntil: 100, ...change };
  const contentHash = artifactHash(scope, "verify-result");
  const raw = { ...scope, signature: { signer, algorithm: "ed25519", value: Buffer.from(ed25519Sign(Buffer.from(`dacs-verifyresult:v1:${contentHash}`), privateKeyFromSeed(seed))).toString("base64url") } };
  const result: ResolvedEvidence = { kind: "verify-result", raw, contentHash, locator };
  const claim: Obj = { ref: `${scheme}:${identifier}`, verifiedBy: { anchor: { kind: "storage-program", locator }, contentHash, recipeVersion: 1 }, ...claimChange };
  return { result, claim };
}
const policy = (scheme: string) => ({ scheme, recipeVersion: 1, methods: ["registry"], availability: "live", defaultMaxAgeSec: 1, trustedResultSigners: [signer] });
const requirement = (scheme: string): Obj => ({ required: [{ scheme }] });
async function withPolicies(run: () => Promise<void>) {
  const old = process.env.DACS_RECIPE_POLICIES;
  try { process.env.DACS_RECIPE_POLICIES = JSON.stringify(["lei", "did", "key", "domain", "sam-uei", "finra-crd", "erc8004", "stor-cred"].map(policy)); await run(); }
  finally { if (old === undefined) delete process.env.DACS_RECIPE_POLICIES; else process.env.DACS_RECIPE_POLICIES = old; }
}

test("vet canonical claim alternatives preserve each scheme's identity rules", async () => withPolicies(async () => {
  const address = `0x${"aB".repeat(20)}`;
  const cases: Array<[string, string, string, boolean]> = [
    ["sam-uei", "abc123def456", "SAM-UEI:ABC123DEF456", true], ["finra-crd", "001234", "finra-crd:1234", true],
    ["finra-crd", "1234", "finra-crd:001234", true], ["did", "001234", "did:1234", false],
    ["did", "example:AbC", "did:example:abc", false], ["did", "example:AbC", "did:example:AbC", true],
    ["key", `0x${"Ab".repeat(32)}`, `key:${"ab".repeat(32)}`, true], ["key", "ab".repeat(32), `key:0X${"AB".repeat(32)}`, true],
    ["domain", "bücher.example", "domain:xn--bcher-kva.example", true],
    ["domain", "xn--bcher-kva.example", "domain:BÜCHER.EXAMPLE", true],
    ["erc8004", `00123:${address}:00456`, `erc8004:123:${address.toLowerCase()}:456`, true],
    ["erc8004", `123:${address}:456`, `erc8004:00123:${address}:00456`, true],
    ["erc8004", `123:${address}:456`, `erc8004:x123:${address}:456`, false],
    ["erc8004", `123:${address}:456`, `erc8004:123:${address}:456junk`, false],
    ["erc8004", `123:${address}:456`, `erc8004:123:0xabc:456`, false],
    ["lei", "ABC", ":ABC", false], ["lei", "ABC", "lei:ABC\njunk", false], ["lei", "ABC", "lei:ABC\n", false], ["lei", "ABC", "lei:ABC\r", false],
    ["x-unknown", "ABC", "x-unknown:ABC", false],
  ];
  for (const [scheme, identifier, ref, expected] of cases) {
    const p = proof(scheme, identifier, {}, { ref });
    assert.equal(await matchesVetRequirement({ claims: [p.claim] }, requirement(scheme), [p.result], 30, 30), expected, ref);
  }
}));

test("vet exact references, freshness boundaries and parameters are independent gates", async () => withPolicies(async () => {
  const p = proof();
  const check = (claim = p.claim, raw = p.result.raw, req = requirement("lei"), at: unknown = 30, final: unknown = 30) =>
    matchesVetRequirement({ claims: [claim] }, req, [{ ...p.result, raw }], at, final);
  for (const prefix of ["sha256:", "sha256-", "SHA256:"]) {
    assert.equal(await check({ ...p.claim, verifiedBy: { ...p.claim.verifiedBy as Obj, contentHash: prefix + p.result.contentHash.toUpperCase() } }), true);
  }
  assert.equal(await check({ ...p.claim, verifiedBy: { ...p.claim.verifiedBy as Obj, anchor: { kind: "storage-program", locator: `stor-${"b".repeat(40)}` } } }), false, "hash alone cannot replace locator");
  const foreign = proof("did", "ABC", {}, { ref: "lei:ABC" });
  assert.equal(await matchesVetRequirement({ claims: [foreign.claim] }, requirement("lei"), [foreign.result], 30, 30), false, "identical identifier in another scheme");
  const malformed = proof("finra-crd", "123", {}, { ref: { scheme: "finra-crd", identifier: "123\n" } });
  assert.equal(await matchesVetRequirement({ claims: [malformed.claim] }, requirement("finra-crd"), [malformed.result], 30, 30), false);
  for (const [at, final] of [["30", 30], [30, "30"], [NaN, 30], [30, Infinity], [31, 30]]) assert.equal(await check(p.claim, p.result.raw, requirement("lei"), at, final), false);
  assert.equal(await check(p.claim, p.result.raw, requirement("lei"), 20, 20), true);
  for (const validUntil of ["100", null, 19]) assert.equal(await check(p.claim, { ...p.result.raw, validUntil }), false);
  for (const expiresAt of ["100", null, 29]) assert.equal(await check({ ...p.claim, expiresAt }), false);
  assert.equal(await check({ ...p.claim, expiresAt: 30 }), true);
  assert.equal(await check({ ...p.claim, expiresAt: 1000 }, { ...p.result.raw, validUntil: 29 }), false);
  assert.equal(await check(p.claim, { ...p.result.raw, validUntil: 20 }, { required: [{ scheme: "lei", maxAge: 0 }] }, 20, 20), true);
  assert.equal(await check(p.claim, { ...p.result.raw, validUntil: 20 }, { required: [{ scheme: "lei", maxAge: 0 }] }, 21, 21), false);
  assert.equal(await check(p.claim, p.result.raw, { required: [{ scheme: "lei", parameters: {} }] }), true);
  assert.equal(await check(p.claim, p.result.raw, { required: [{ scheme: "lei", parameters: { unknown: true } }] }), false);
  process.env.DACS_RECIPE_POLICIES = JSON.stringify([{ ...policy("lei"), defaultMaxAgeSec: 0 }]);
  const raw = { ...p.result.raw }; delete raw.validUntil;
  assert.equal(await check(p.claim, raw, { required: [{ scheme: "lei", maxAge: 0 }] }, 20, 20), true);
  assert.equal(await check(p.claim, raw, requirement("lei"), 21, 21), false);
}));

test("selector requires the exact verified primary beside unrelated and malformed claims", async () => withPolicies(async () => {
  const primary = proof("did", "example:primary");
  const other = proof("did", "example:other"); other.result.locator = `stor-${"b".repeat(40)}`; (other.claim.verifiedBy as Obj).anchor = { kind: "storage-program", locator: other.result.locator };
  const sameId = proof("stor-cred", "example:primary"); sameId.result.locator = `stor-${"c".repeat(40)}`; (sameId.claim.verifiedBy as Obj).anchor = { kind: "storage-program", locator: sameId.result.locator };
  const req = { required: [], primaryClaimSelector: "DID" };
  const results = [primary.result, other.result, sameId.result];
  const check = (claims: Obj[], selector: unknown = "DID") => matchesVetRequirement({ presentedBy: "did:example:primary", claims }, { ...req, primaryClaimSelector: selector }, results, 30, 30);
  assert.equal(await check([other.claim, sameId.claim]), false);
  assert.equal(await check([{ ref: "unknown" }, other.claim, sameId.claim, primary.claim]), true);
  assert.equal(await check([primary.claim], "lei"), false);
  assert.equal(await check([primary.claim], 1), false);
}));
