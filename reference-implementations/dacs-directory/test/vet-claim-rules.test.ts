import assert from "node:assert/strict";
import test from "node:test";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { artifactHash, type ResolvedEvidence } from "../src/catalog/evidenceGraph.js";
import { matchesVetRequirement as evaluateVetRequirement } from "../src/catalog/vetClaimRules.js";
const matchesVetRequirement: typeof evaluateVetRequirement = (identity, requirement, results, at, finalisedAt, recipes) =>
  evaluateVetRequirement(identity, requirement, results, at, finalisedAt, recipes ?? JSON.parse(process.env.DACS_RECIPE_POLICIES ?? "[]"));

type Obj = Record<string, unknown>;
const seed = new Uint8Array(32).fill(17);
const signer = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const locator = `stor-${"a".repeat(40)}`;
function proof(scheme = "lei", identifier = "ABC", change: Obj = {}, claimChange: Obj = {}) {
  const scope = { resultVersion: "1", scheme, identifier, recipeVersion: 1, method: "registry", decision: "pass", verifiedAt: 20, validUntil: 100, reason: "registry response", fetchedAt: 19,
    attestation: { anchor: { kind: "storage-program", locator }, contentHash: "d".repeat(64) }, ...change };
  const contentHash = artifactHash(scope, "verify-result");
  const raw = { ...scope, signature: { signer, algorithm: "ed25519", value: Buffer.from(ed25519Sign(Buffer.from(`dacs-verifyresult:v1:${contentHash}`), privateKeyFromSeed(seed))).toString("base64url") } };
  const result: ResolvedEvidence = { kind: "verify-result", raw, contentHash, locator };
  const claim: Obj = { ref: `${scheme}:${identifier}`, verifiedBy: { anchor: { kind: "storage-program", locator }, contentHash, recipeVersion: 1 }, ...claimChange };
  return { result, claim };
}
const policy = (scheme: string) => ({ scheme, recipeVersion: 1, methods: ["registry"], availability: "live", defaultMaxAgeSec: 1, trustedResultSigners: [signer] });
const requirement = (scheme: string): Obj => ({ required: [{ scheme, verificationRequired: true }] });
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
  assert.equal(await check(p.claim, { ...p.result.raw, validUntil: 20 }, { required: [{ scheme: "lei", verificationRequired: true, maxAge: 0 }] }, 20, 20), true);
  assert.equal(await check(p.claim, { ...p.result.raw, validUntil: 20 }, { required: [{ scheme: "lei", verificationRequired: true, maxAge: 0 }] }, 21, 21), false);
  assert.equal(await check(p.claim, p.result.raw, { required: [{ scheme: "lei", verificationRequired: true, parameters: {} }] }), true);
  assert.equal(await check(p.claim, p.result.raw, { required: [{ scheme: "lei", verificationRequired: true, parameters: { unknown: true } }] }), false);
  process.env.DACS_RECIPE_POLICIES = JSON.stringify([{ ...policy("lei"), defaultMaxAgeSec: 0 }]);
  const raw = { ...p.result.raw }; delete raw.validUntil;
  assert.equal(await check(p.claim, raw, { required: [{ scheme: "lei", verificationRequired: true, maxAge: 0 }] }, 20, 20), true);
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

test("vet freshness selects the exact scheme AND recipe version among unequal windows", async () => withPolicies(async () => {
  const p = proof("lei", "ABC", { validUntil: undefined });
  delete p.result.raw.validUntil;
  const check = () => matchesVetRequirement({ claims: [p.claim] }, requirement("lei"), [p.result], 2021, 2021);
  for (const foreign of [{ ...policy("lei"), recipeVersion: 2 }, policy("ofac-clear")]) {
    process.env.DACS_RECIPE_POLICIES = JSON.stringify([{ ...foreign, defaultMaxAgeSec: 1000000 }, policy("lei")]);
    assert.equal(await check(), false, JSON.stringify(foreign));
  }
  process.env.DACS_RECIPE_POLICIES = JSON.stringify([{ ...policy("lei"), defaultMaxAgeSec: 1000000 }]);
  assert.equal(await check(), true, "the matching long window can admit the result");
}));

test("required claims are conjunctive and oneOf is OR within groups and AND across groups", async () => withPolicies(async () => {
  const lei = proof();
  const domain = proof("domain", "example.com");
  domain.result.locator = `stor-${"b".repeat(40)}`;
  (domain.claim.verifiedBy as Obj).anchor = { kind: "storage-program", locator: domain.result.locator };
  const cr = (scheme: string) => ({ scheme, verificationRequired: true });
  const check = (required: Obj[], oneOf?: Obj[][], claims = [lei.claim, domain.claim]) =>
    matchesVetRequirement({ claims }, { required, oneOf }, [lei.result, domain.result], 30, 30);
  assert.equal(await check([cr("lei"), cr("domain")]), true);
  assert.equal(await check([cr("lei"), cr("did")]), false, "one passing required member is insufficient");
  assert.equal(await check([cr("lei"), cr("domain")], undefined, [lei.claim]), false);
  assert.equal(await check([], [[cr("did"), cr("lei")], [cr("domain"), cr("key")]]), true);
  assert.equal(await check([], [[cr("lei"), cr("did")], [cr("key"), cr("domain")]]), true);
  assert.equal(await check([], [[cr("lei")], [cr("key"), cr("did")]]), false, "every group needs a match");
  assert.equal(await check([], [[cr("lei")], []]), false);
  assert.equal(await check([cr("did")], [[cr("lei")]]), false, "oneOf does not override required");
}));

test("verificationRequired controls decision while freshness and exact-primary verification always apply", async () => withPolicies(async () => {
  for (const decision of ["pass", "fail", "indeterminate", "error"]) {
    for (const verificationRequired of [true, false]) {
      const p = proof("lei", "ABC", { decision });
      const req = { required: [{ scheme: "lei", verificationRequired }] };
      const identity = { claims: [p.claim], presentedBy: "lei:ABC" };
      const check = (at = 30, selector = false) => matchesVetRequirement(identity,
        { ...req, ...(selector ? { primaryClaimSelector: "lei" } : {}) }, [p.result], at, at);
      assert.equal(await check(), !verificationRequired || decision === "pass", `${decision}/${verificationRequired}`);
      assert.equal(await check(101), false, "unverified claims still require freshness");
      assert.equal(await check(30, true), decision === "pass", "selector always requires pass");
      assert.equal(await check(101, true), false, "selected primary must be fresh");
    }
  }
}));

test("vet requires a live exact-version recipe, allowed method and trusted signer even with validUntil", async () => {
  const p = proof();
  const check = (recipes?: import("../src/catalog/recipePolicy.js").RecipePolicy[], raw = p.result.raw, claim = p.claim) =>
    evaluateVetRequirement({ claims: [claim] }, { required: [{ scheme: "lei", verificationRequired: true }] },
      [{ ...p.result, raw }], 30, 30, recipes);
  const live = policy("lei") as import("../src/catalog/recipePolicy.js").RecipePolicy;
  assert.equal(await check([live]), true);
  assert.equal(await check(), false, "no session recipe roster");
  assert.equal(await check([]), false, "no matching recipe");
  for (const availability of ["operator_gated", "closed_data", "bilateral", "mocked", "disabled", "failed"] as const)
    assert.equal(await check([{ ...live, availability }]), false, availability);
  for (const recipe of [{ ...live, recipeVersion: 2 }, { ...live, methods: ["external"] },
    { ...live, trustedResultSigners: [] }, { ...live, defaultMaxAgeSec: -1 }]) assert.equal(await check([recipe]), false);
  for (const recipeVersion of [undefined, 0, -1, 1.5, "1"]) {
    const claim = { ...p.claim, verifiedBy: { ...p.claim.verifiedBy as Obj, recipeVersion } };
    assert.equal(await check([live], { ...p.result.raw, recipeVersion }, claim), false, String(recipeVersion));
  }
  assert.equal(await check([live, live]), false, "ambiguous roster");
  assert.equal(await check([live], { ...p.result.raw, method: "external" }), false);
  assert.equal(await check([live], { ...p.result.raw, signature: { signer: `did:demos:agent:${"b".repeat(64)}`, algorithm: "ed25519" } }), false);
  const optional = proof("domain", "example.com");
  assert.equal(await evaluateVetRequirement({ claims: [p.claim] }, requirement("lei"), [p.result, optional.result], 30, 30, [live]), false,
    "every included result requires policy, including optional results");
});


test("vet rejects malformed verificationRequired in every required and oneOf member", async () => withPolicies(async () => {
  const malformed = [{ scheme: "lei" }, ...[undefined, null, "true", "false", 0, 1, {}, []]
    .map((verificationRequired) => ({ scheme: "lei", verificationRequired }))];
  for (const decision of ["pass", "fail", "indeterminate", "error"]) {
    const p = proof("lei", "ABC", { decision });
    const valid = { scheme: "lei", verificationRequired: false };
    const check = (req: Obj) => matchesVetRequirement({ claims: [p.claim] }, req, [p.result], 30, 30);
    assert.equal(await check({ required: [valid] }), true, `explicit false/${decision}`);
    assert.equal(await check({ required: [], oneOf: [[valid]] }), true);
    for (const member of malformed) {
      const label = `${decision}/${JSON.stringify(member)}`;
      assert.equal(await check({ required: [member] }), false, `required: ${label}`);
      assert.equal(await check({ required: [], oneOf: [[member]] }), false, `oneOf: ${label}`);
      for (const group of [[valid, member], [member, valid]])
        assert.equal(await check({ required: [], oneOf: [group] }), false, `all alternatives need valid shape: ${label}`);
      assert.equal(await check({ required: [], oneOf: [[valid, { ...member, scheme: "did" }]] }), false,
        `even an unmatched alternative needs valid shape: ${label}`);
    }
  }
}));

test("unverified requirements still reject malformed VerifyResult records", async () => withPolicies(async () => {
  const attestation = { anchor: { kind: "storage-program", locator }, contentHash: "d".repeat(64) };
  const invalid: Obj[] = [
    { resultVersion: undefined }, { resultVersion: 1 }, { resultVersion: "2" },
    { scheme: undefined }, { identifier: undefined }, { identifier: "" },
    { recipeVersion: undefined }, { recipeVersion: "1" }, { recipeVersion: 0 },
    { method: undefined }, { decision: undefined }, { decision: null }, { decision: true }, { decision: "unknown" },
    { reason: undefined }, { reason: null }, { reason: 1 },
    { fetchedAt: undefined }, { fetchedAt: "19" },
    { verifiedAt: undefined }, { verifiedAt: "20" },
    { validUntil: null }, { validUntil: "100" },
    { attestation: undefined }, { attestation: [] }, { attestation: {} },
    { attestation: { ...attestation, anchor: { kind: "unknown", locator } } },
    { attestation: { ...attestation, anchor: { kind: ["storage-program"], locator } } },
    { attestation: { ...attestation, anchor: { kind: "storage-program", locator: "" } } },
    { attestation: { ...attestation, contentHash: "invalid" } },
    { attestation: { ...attestation, signer: null } },
    { data: null }, { data: [] }, { data: "extraction" },
  ];
  const check = (p: ReturnType<typeof proof>, verificationRequired = false) => matchesVetRequirement(
    { claims: [p.claim] }, { required: [{ scheme: "lei", verificationRequired }] }, [p.result], 30, 30);
  assert.equal(await check(proof("lei", "ABC", { decision: "fail" })), true, "a well-formed failed result may match explicit false");
  assert.equal(await check(proof("lei", "ABC", { validUntil: undefined })), true, "validUntil remains optional");
  assert.equal(await check(proof("lei", "ABC", { data: { found: false } })), true, "structured data remains optional");
  for (const kind of ["storage-program", "ipfs", "https"])
    assert.equal(await check(proof("lei", "ABC", { attestation: { ...attestation, anchor: { kind, locator } } })), true,
      `supported attestation anchor: ${kind}`);
  for (const change of invalid) {
    // These malformed records are hash-bound and signed by the trusted fixture signer.
    for (const decision of ["pass", "fail"])
      assert.equal(await check(proof("lei", "ABC", { decision, ...change })), false,
        `${decision}/${JSON.stringify(change)}`);
  }
  for (const field of ["fetchedAt", "verifiedAt", "validUntil"]) {
    for (const value of [NaN, Infinity, -Infinity]) {
      const p = proof("lei", "ABC", { decision: "fail" });
      p.result.raw[field] = value;
      assert.equal(await check(p), false, `${field}/${value}`);
    }
  }
  for (const raw of [null, [], "result"]) {
    const p = proof();
    p.result.raw = raw as unknown as Obj;
    assert.equal(await check(p), false, `raw: ${JSON.stringify(raw)}`);
  }
  const otherKind = proof(); otherKind.result.kind = "attestation";
  assert.equal(await check(otherKind), false, "a different artifact kind is not a VerifyResult");
  for (const signature of [null, [], {}, { signer, algorithm: "ed25519" },
    { signer, algorithm: "ed25519", value: "" }, { signer, algorithm: "ed25519", value: 1 }]) {
    const p = proof("lei", "ABC", { decision: "fail" });
    p.result.raw.signature = signature;
    assert.equal(await check(p), false, `signature: ${JSON.stringify(signature)}`);
  }
}));
