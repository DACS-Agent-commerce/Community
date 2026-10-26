import assert from "node:assert/strict";
import test from "node:test";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey, ed25519Verify } from "@kynesyslabs/dacs/crypto";
import { artifactHash, type ResolvedEvidence } from "../src/catalog/evidenceGraph.js";
import { matchesVetRequirement as evaluateVetRequirement, type VerifyPrimaryClaimControl } from "../src/catalog/vetClaimRules.js";
const matchesVetRequirement: typeof evaluateVetRequirement = (identity, requirement, results, at, finalisedAt, recipes, verifyControl) =>
  evaluateVetRequirement(identity, requirement, results, at, finalisedAt, recipes ?? JSON.parse(process.env.DACS_RECIPE_POLICIES ?? "[]"), verifyControl);
// Non-control tests explicitly stub the separate, trusted adapter boundary.
const controlVerified: VerifyPrimaryClaimControl = async () => true;

type Obj = Record<string, unknown>;
const seed = new Uint8Array(32).fill(17);
const signer = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const locator = `stor-${"a".repeat(40)}`;
function proof(scheme = "lei", identifier = "ABC", change: Obj = {}, claimChange: Obj = {}) {
  const scope = { resultVersion: "1", scheme, identifier, recipeVersion: 1, method: "verifiable-credential", decision: "pass", verifiedAt: 20, validUntil: 100, reason: "registry response", fetchedAt: 19,
    attestation: { anchor: { kind: "storage-program", locator }, contentHash: "d".repeat(64) }, ...change };
  // An `undefined` change removes the member: the pinned SDK hashes only data-only JSON.
  for (const [key, value] of Object.entries(scope)) if (value === undefined) delete (scope as Obj)[key];
  const contentHash = artifactHash(scope, "verify-result");
  const raw = { ...scope, signature: { signer, algorithm: "ed25519", value: Buffer.from(ed25519Sign(Buffer.from(`dacs-verifyresult:v1:${contentHash}`), privateKeyFromSeed(seed))).toString("base64url") } };
  const result: ResolvedEvidence = { kind: "verify-result", raw, contentHash, locator };
  const claim: Obj = { ref: `${scheme}:${identifier}`, verifiedBy: { anchor: { kind: "storage-program", locator }, contentHash, recipeVersion: 1 }, ...claimChange };
  return { result, claim };
}
const policy = (scheme: string) => ({ scheme, recipeVersion: 1, methods: ["verifiable-credential"], availability: "live", defaultMaxAgeSec: 1, trustedResultSigners: [signer] });
const requirement = (scheme: string): Obj => ({ requirementVersion: "1", required: [{ scheme, verificationRequired: true }] });
async function withPolicies(run: () => Promise<void>) {
  const old = process.env.DACS_RECIPE_POLICIES;
  try { process.env.DACS_RECIPE_POLICIES = JSON.stringify(["lei", "did", "key", "domain", "sam-uei", "finra-crd", "erc8004", "stor-cred"].map(policy)); await run(); }
  finally { if (old === undefined) delete process.env.DACS_RECIPE_POLICIES; else process.env.DACS_RECIPE_POLICIES = old; }
}

test("a primary selector rejects an identity without presentedBy", async () => withPolicies(async () => {
  const p = proof();
  const identity = { claims: [p.claim] };
  assert.equal(await matchesVetRequirement(identity, requirement("lei"), [p.result], 30, 30), true);
  assert.equal(await matchesVetRequirement(identity, { ...requirement("lei"), primaryClaimSelector: "lei" },
    [p.result], 30, 30, undefined, controlVerified), false);
}));

test("a well-formed oneOf group cannot hide a malformed later group", async () => withPolicies(async () => {
  const lei = proof();
  const domain = proof("domain", "example.com", { decision: "fail" });
  const identity = { claims: [lei.claim, domain.claim] };
  const req = { requirementVersion: "1", required: [], oneOf: [
    [{ scheme: "lei", verificationRequired: true }],
    [{ scheme: "domain", verificationRequired: "true" }],
  ] };
  assert.equal(await matchesVetRequirement(identity, { ...req, oneOf: [req.oneOf[0],
    [{ scheme: "domain", verificationRequired: false }]] }, [lei.result, domain.result], 30, 30), true);
  assert.equal(await matchesVetRequirement(identity, req, [lei.result, domain.result], 30, 30), false);
}));

test("a result verified after the signed vet time cannot satisfy a requirement", async () => withPolicies(async () => {
  const p = proof("lei", "ABC", { verifiedAt: 31, fetchedAt: 30 });
  const identity = { claims: [p.claim] };
  assert.equal(await matchesVetRequirement(identity, requirement("lei"), [p.result], 31, 31), true);
  assert.equal(await matchesVetRequirement(identity, requirement("lei"), [p.result], 30, 30), false);
}));

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

test("listing maxAge independently tightens a still-valid authority window in seconds", async () => withPolicies(async () => {
  const p = proof("lei", "ABC", { verifiedAt: 0, validUntil: 100_000 });
  const req = { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true, maxAge: 1 }] };
  const check = (at: number, requirement = req) => matchesVetRequirement({ claims: [p.claim] }, requirement, [p.result], at, at);
  assert.equal(await check(1000), true, "inclusive boundary and seconds-to-milliseconds conversion");
  assert.equal(await check(1001), false, "listing age expires before the authority window");
  assert.equal(await check(1001, { ...req, required: [{ ...req.required[0], maxAge: 2 }] }), true);
  assert.equal(await check(0, { ...req, required: [{ ...req.required[0], maxAge: 0 }] }), true);
  assert.equal(await check(1, { ...req, required: [{ ...req.required[0], maxAge: 0 }] }), false);
}));

test("claim reference hash and positive recipe version are independently exact", async () => withPolicies(async () => {
  const p = proof();
  const ref = p.claim.verifiedBy as Obj;
  const recipes = [policy("lei"), { ...policy("lei"), recipeVersion: 2 }] as import("../src/catalog/recipePolicy.js").RecipePolicy[];
  const req = { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true, recipeVersion: 1 }] };
  const check = (change: Obj = {}) => matchesVetRequirement({ claims: [{ ...p.claim, verifiedBy: { ...ref, ...change } }] }, req, [p.result], 30, 30, recipes);
  assert.equal(await check(), true);
  assert.equal(await check({ contentHash: "e".repeat(64) }), false, "correct locator with wrong hash");
  assert.equal(await check({ recipeVersion: 2 }), false, "different valid positive reference version");
  assert.equal(await matchesVetRequirement({ claims: [p.claim] }, { ...req, required: [{ ...req.required[0], recipeVersion: 2 }] },
    [p.result], 30, 30, recipes), false, "different explicit requirement version in the same roster");
}));

test("unknown schemes and missing verifiedBy fail independently of recipe policy and decision", async () => withPolicies(async () => {
  const p = proof("x-unknown", "ABC");
  const recipes = [policy("x-unknown")] as import("../src/catalog/recipePolicy.js").RecipePolicy[];
  assert.ok(await import("../src/catalog/recipePolicy.js").then(({ validateRecipeResult }) => validateRecipeResult(p.result.raw, async () => recipes[0])),
    "the otherwise-valid result has a live allowed policy and trusted signer");
  assert.equal(await matchesVetRequirement({ claims: [p.claim] }, requirement("x-unknown"), [p.result], 30, 30, recipes), false,
    "unknown scheme alone prevents matching");
  const known = proof();
  const req = { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: false }] };
  assert.equal(await matchesVetRequirement({ claims: [known.claim] }, req, [known.result], 30, 30), true);
  const { verifiedBy: _ref, ...unverified } = known.claim;
  assert.equal(await matchesVetRequirement({ claims: [unverified] }, req, [known.result], 30, 30), false,
    "explicit false cannot make a claim without an authority reference fresh");
}));

test("claim qualifiers do not change canonical identity", async () => withPolicies(async () => {
  for (const [scheme, identifier] of [["lei", "ABC"], ["domain", "bücher.example"]]) {
    const p = proof(scheme, identifier);
    for (const ref of [p.claim.ref, `${p.claim.ref}?region=eu&level=1`]) {
      assert.equal(await matchesVetRequirement({ claims: [{ ...p.claim, ref }] }, requirement(scheme), [p.result], 30, 30), true);
    }
  }
}));

test("domain identity rejects URL syntax and control bytes rather than discarding them", async () => withPolicies(async () => {
  const p = proof("domain", "example.com");
  const malformed = ["example.com/path", "example.com#other", "example.com\\path", "example.com\n", "example.com\r", "example.\tcom",
    " example.com", "example.com ", "user@example.com", "example.com:443", "example%2ecom", "example..com", "-example.com", "example_.com",
    `${"a".repeat(64)}.com`, Array(5).fill("a".repeat(63)).join(".")];
  for (const identifier of malformed) {
    const claim = { ...p.claim, ref: `domain:${identifier}` };
    assert.equal(await matchesVetRequirement({ claims: [claim] }, requirement("domain"), [p.result], 30, 30), false, identifier);
    const badResult = proof("domain", identifier, {}, { ref: "domain:example.com" });
    assert.equal(await matchesVetRequirement({ claims: [badResult.claim] }, requirement("domain"), [badResult.result], 30, 30), false,
      `malformed verified identifier: ${identifier}`);
    assert.equal(await matchesVetRequirement({ claims: [claim], presentedBy: `domain:${identifier}` },
      { ...requirement("domain"), primaryClaimSelector: "domain" }, [p.result], 30, 30, undefined, controlVerified), false, "selected primary");
  }
  for (const identifier of ["127.1", "0x7f000001", "2130706433", "0177.0.0.1"]) {
    const numeric = proof("domain", "127.0.0.1", {}, { ref: `domain:${identifier}` });
    assert.equal(await matchesVetRequirement({ claims: [numeric.claim] }, requirement("domain"), [numeric.result], 30, 30), false,
      `DNS labels must not be rewritten as IPv4: ${identifier}`);
    const exact = proof("domain", identifier);
    assert.equal(await matchesVetRequirement({ claims: [exact.claim] }, requirement("domain"), [exact.result], 30, 30), true,
      "numeric DNS labels retain their exact spelling");
  }
}));

test("BundleRequirement major version must be the supported string literal", async () => withPolicies(async () => {
  const p = proof();
  const check = (req: Obj) => matchesVetRequirement({ claims: [p.claim] }, req, [p.result], 30, 30);
  assert.equal(await check(requirement("lei")), true);
  const { requirementVersion: _version, ...missing } = requirement("lei");
  assert.equal(await check(missing), false);
  for (const requirementVersion of [undefined, null, 1, "", "2", "1.0", {}, []])
    assert.equal(await check({ ...requirement("lei"), requirementVersion }), false, JSON.stringify(requirementVersion));
}));

test("a primary selector preserves an explicit historical recipe pin", async () => withPolicies(async () => {
  const p = proof();
  const recipes = [policy("lei"), { ...policy("lei"), recipeVersion: 2 }] as import("../src/catalog/recipePolicy.js").RecipePolicy[];
  const req = { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true, recipeVersion: 1 }] };
  const identity = { claims: [p.claim], presentedBy: "lei:ABC" };
  assert.equal(await matchesVetRequirement({ claims: [p.claim] }, req, [p.result], 30, 30, recipes), true);
  assert.equal(await matchesVetRequirement(identity, { ...req, primaryClaimSelector: "lei" }, [p.result], 30, 30, recipes, controlVerified), true);
  assert.equal(await matchesVetRequirement(identity, { ...req, primaryClaimSelector: "lei", required: [{ ...req.required[0], recipeVersion: 2 }] },
    [p.result], 30, 30, recipes, controlVerified), false, "the selector cannot bypass an explicit requirement pin either");
  assert.equal(await matchesVetRequirement(identity, { ...requirement("lei"), primaryClaimSelector: "lei" }, [p.result], 30, 30, recipes, controlVerified), false,
    "an unpinned listing requirement still selects the latest roster version");
}));

test("selected primary needs authenticated exact-claim and session control beyond a registry result", async () => withPolicies(async () => {
  const p = proof();
  // A local fixture adapter has a trusted holder-key linkage independent of the
  // authority/result signer. Production methods must supply their own verifier.
  const holderSeed = new Uint8Array(32).fill(74);
  const message = (scheme: string, identifier: string, session: unknown, at: number) =>
    Buffer.from(JSON.stringify(["fixture-primary-control", scheme, identifier, session, at]));
  const signature = (scheme = "lei", identifier = "ABC", session = "session-a", signingSeed = holderSeed) =>
    Buffer.from(ed25519Sign(message(scheme, identifier, session, 30), privateKeyFromSeed(signingSeed))).toString("base64url");
  const verify: VerifyPrimaryClaimControl = async ({ identity, primary, claim, result, at, finalisedAt }) => {
    assert.equal(claim.ref, "lei:ABC");
    assert.equal(result, p.result);
    assert.equal(finalisedAt, 30);
    return primary.scheme === "lei" && primary.identifier === "ABC" && identity.session === "session-a" &&
      typeof identity.controlProof === "string" && ed25519Verify(message(primary.scheme, primary.identifier, identity.session, at),
        Buffer.from(identity.controlProof, "base64url"), publicKeyFromSeed(holderSeed));
  };
  const identity = { claims: [p.claim], presentedBy: "lei:ABC", session: "session-a" };
  const req = { ...requirement("lei"), primaryClaimSelector: "lei" };
  const check = (value: Obj, adapter?: VerifyPrimaryClaimControl, requirement: Obj = req) =>
    matchesVetRequirement(value, requirement, [p.result], 30, 30, undefined, adapter);
  assert.equal(await check(identity), false, "a bare passing registry result is not presenter control");
  assert.equal(await check(identity, verify), false, "no control proof");
  assert.equal(await check({ ...identity, controlVerified: true }, verify), false, "untrusted metadata is not control proof");
  assert.equal(await check({ ...identity, controlProof: signature() }), false, "proof without a trusted adapter is not authenticated");
  assert.equal(await check({ ...identity, controlProof: signature() }, verify), true);
  assert.equal(await check({ ...identity, presentedBy: "LEI:abc?region=eu", controlProof: signature() }, verify), true,
    "adapter sees the canonical exact primary");
  for (const controlProof of [signature("lei", "OTHER"), signature("did", "ABC"), signature("lei", "ABC", "other-session"), signature("lei", "ABC", "session-a", seed)])
    assert.equal(await check({ ...identity, controlProof }, verify), false, "control proof must cover the exact claim, trusted holder key and session");
  assert.equal(await check({ ...identity, session: "other-session", controlProof: signature() }, verify), false);
  assert.equal(await check({ ...identity, claims: [], controlProof: signature() }, verify), false, "proof cannot replace the selected claim's result");
  assert.equal(await check({ ...identity, controlProof: signature() }, async () => false), false);
  assert.equal(await check({ ...identity, controlProof: signature() }, async () => { throw new Error("control verifier unavailable"); }), false);
  const { primaryClaimSelector: _selector, ...noSelector } = req;
  assert.equal(await check(identity, undefined, noSelector), false, "omitting a listing selector cannot bypass control of presentedBy");
  assert.equal(await check({ ...identity, controlProof: signature() }, verify, noSelector), true);
}));

test("VerifyResult methods cannot extend the closed registry through operator policy", async () => withPolicies(async () => {
  const p = proof("lei", "ABC", { method: "registry" });
  const recipes = [{ ...policy("lei"), methods: ["registry"] }] as import("../src/catalog/recipePolicy.js").RecipePolicy[];
  assert.equal(await matchesVetRequirement({ claims: [p.claim] }, requirement("lei"), [p.result], 30, 30, recipes), false);
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
  assert.equal(await check(p.claim, { ...p.result.raw, validUntil: 20 }, { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true, maxAge: 0 }] }, 20, 20), true);
  assert.equal(await check(p.claim, { ...p.result.raw, validUntil: 20 }, { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true, maxAge: 0 }] }, 21, 21), false);
  assert.equal(await check(p.claim, p.result.raw, { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true, parameters: {} }] }), true);
  assert.equal(await check(p.claim, p.result.raw, { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true, parameters: { unknown: true } }] }), false);
  process.env.DACS_RECIPE_POLICIES = JSON.stringify([{ ...policy("lei"), defaultMaxAgeSec: 0 }]);
  const raw = { ...p.result.raw }; delete raw.validUntil;
  assert.equal(await check(p.claim, raw, { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true, maxAge: 0 }] }, 20, 20), true);
  assert.equal(await check(p.claim, raw, requirement("lei"), 21, 21), false);
}));

test("selector requires the exact verified primary beside unrelated and malformed claims", async () => withPolicies(async () => {
  const primary = proof("did", "example:primary");
  const other = proof("did", "example:other"); other.result.locator = `stor-${"b".repeat(40)}`; (other.claim.verifiedBy as Obj).anchor = { kind: "storage-program", locator: other.result.locator };
  const sameId = proof("stor-cred", "example:primary"); sameId.result.locator = `stor-${"c".repeat(40)}`; (sameId.claim.verifiedBy as Obj).anchor = { kind: "storage-program", locator: sameId.result.locator };
  const req = { requirementVersion: "1", required: [], primaryClaimSelector: "DID" };
  const results = [primary.result, other.result, sameId.result];
  const check = (claims: Obj[], selector: unknown = "DID") => matchesVetRequirement({ presentedBy: "did:example:primary", claims }, { ...req, primaryClaimSelector: selector }, results, 30, 30, undefined, controlVerified);
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
    matchesVetRequirement({ claims }, { requirementVersion: "1", required, oneOf }, [lei.result, domain.result], 30, 30);
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
      const req = { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired }] };
      const identity = { claims: [p.claim], presentedBy: "lei:ABC" };
      const check = (at = 30, selector = false) => matchesVetRequirement(selector ? identity : { claims: identity.claims },
        { ...req, ...(selector ? { primaryClaimSelector: "lei" } : {}) }, [p.result], at, at, undefined, controlVerified);
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
    evaluateVetRequirement({ claims: [claim] }, { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true }] },
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
    assert.equal(await check({ requirementVersion: "1", required: [valid] }), true, `explicit false/${decision}`);
    assert.equal(await check({ requirementVersion: "1", required: [], oneOf: [[valid]] }), true);
    for (const member of malformed) {
      const label = `${decision}/${JSON.stringify(member)}`;
      assert.equal(await check({ requirementVersion: "1", required: [member] }), false, `required: ${label}`);
      assert.equal(await check({ requirementVersion: "1", required: [], oneOf: [[member]] }), false, `oneOf: ${label}`);
      for (const group of [[valid, member], [member, valid]])
        assert.equal(await check({ requirementVersion: "1", required: [], oneOf: [group] }), false, `all alternatives need valid shape: ${label}`);
      assert.equal(await check({ requirementVersion: "1", required: [], oneOf: [[valid, { ...member, scheme: "did" }]] }), false,
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
    { claims: [p.claim] }, { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired }] }, [p.result], 30, 30);
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
