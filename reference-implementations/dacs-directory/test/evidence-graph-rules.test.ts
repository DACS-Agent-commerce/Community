import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import {
  agreementListingConformance,
  agreementMatchesListing,
  agreementPrice,
  artifactHash,
  buildCurrentEvidenceGraph,
  COMMITTED_AT_INDETERMINATE,
  isCurrentRef,
  paymentFinalityOk,
  verifiedDiscoveryAgreement,
  type ArtifactKind,
  type EvidenceGraphDeps,
} from "../src/catalog/evidenceGraph.js";

// Each DACS rule the current-profile evidence graph enforces, one case per rule. Every mutated
// artifact is signed again, so only the rule under test can reject it.
type Obj = Record<string, unknown>;
const seeds = [51, 52, 53].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const dids = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const [BUYER, SELLER, OUTSIDER] = [0, 1, 2];
const at = (n: number) => `stor-${(0x9000 + n).toString(16).padStart(40, "0")}`;
const JOB = "rules-job";
const PREFIX: Record<string, string> = {
  listing: "dacs-listing:v1:", agreement: "dacs-agreement:v1:", evidence: "dacs-evidence:v1:", amendment: "dacs-amendment:v1:", rating: "dacs-rating:v1:",
  "verify-result": "dacs-verifyresult:v1:", composite: "dacs-composite:v1:", bundle: "dacs-bundle:v1:",
};
const prefixFor = (raw: Obj, kind: ArtifactKind) => kind === "agreement" && raw.payeeBoundAgreementVersion !== undefined
  ? "dacs-payee-bound-agreement:v1:" : kind === "bundle" && raw.faultBundleVersion !== undefined ? "dacs-fault-bundle:v1:" : PREFIX[kind];
const signatureValue = async (message: string, signer: number) =>
  Buffer.from(await ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seeds[signer]))).toString("base64url");
const envelope = async (raw: Obj, kind: ArtifactKind, signer: number, as = signer, field: "signer" | "party" = "signer") =>
  ({ [field]: dids[as], algorithm: "ed25519", value: await signatureValue(prefixFor(raw, kind) + artifactHash(raw, kind), signer) });
const refTo = (locator: string, raw: Obj, kind: ArtifactKind): Obj =>
  ({ anchor: { kind: "storage-program", locator }, contentHash: artifactHash(raw, kind) });
const clone = <T>(value: T): T => structuredClone(value);
const offered = { kind: "attested-payload", payloadFormat: "application/json" };

async function listingFor(commitment = "commit-agreement", tail?: string): Promise<Obj> {
  const identity: Obj = { bundleVersion: "1", presentedBy: dids[SELLER], presentedAt: 1, claims: [{ ref: dids[SELLER] }] };
  const presentation = Buffer.from(await ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identity)}`),
    privateKeyFromSeed(seeds[SELLER]))).toString("hex");
  const scope: Obj = {
    dacsVersion: "1", listingVersion: 1, listingId: "rules", requiredCapabilities: ["SR-2"],
    seller: { identity: { ...identity, presentation: { kind: "per-claim", signatures: [{ ref: dids[SELLER], signature: presentation }] } }, displayName: "seller" },
    offering: { title: "rules", description: "rules", category: "services.test", tags: [], deliverable: offered },
    buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: commitment }, { kind: "pay-dem", parameters: { rail: "pay-dem" } }, ...(tail ? [{ kind: tail, ...(tail === "pay-dem" ? { parameters: { rail: "pay-dem" } } : {}) }] : [])],
    pricing: { kind: "fixed", price: { amount: "1.25", currency: "DEM" } }, acceptedRails: [{ railId: "pay-dem" }], terms: {}, validity: { notBefore: 1 },
  };
  return { ...scope, signature: await envelope(scope, "listing", SELLER) };
}
const listing = await listingFor();
const payeeBoundListing = await listingFor("commit-payee-bound-agreement");
const listingRefOf = (raw: Obj) => ({ listingId: "rules", version: 1, contentHash: artifactHash(raw, "listing") });

/** The scopes of one valid completed session; a case edits them before anything is signed. */
function baseScopes(forListing = listing) {
  const listingRef = listingRefOf(forListing);
  return {
    agreement: {
      agreementVersion: "1", jobId: JOB, listingRef, derivedFromPattern: "fixed-price",
      parties: [{ role: "buyer", primaryClaim: dids[BUYER] }, { role: "seller", primaryClaim: dids[SELLER] }],
      terms: { price: { amount: "1.25", currency: "DEM" }, rail: { railId: "pay-dem" }, deliverable: { deliverableType: "attested-payload", hash: contentHash(offered) } },
    } as Obj,
    evidence: {
      evidenceVersion: "1", jobId: JOB, phase: "pay-dem", outcome: "success", paymentTxRefs: [{ kind: "demos", txHash: "ab".repeat(32) }],
      paymentAmount: { amount: "1.25", currency: "DEM" }, settlementFinality: { model: "bft-final", finalityObservedAt: 100 }, observedAt: 100,
    } as Obj,
    rating: { ratingVersion: "1", jobId: JOB, rater: dids[BUYER], target: dids[SELLER], targetRole: "seller", value: 5, ratedAt: 110 } as Obj,
    bundle: {
      bundleVersion: "1", jobId: JOB, outcome: "completed", listingRef,
      parties: [{ role: "buyer", bundleHash: "a".repeat(64), primaryClaim: dids[BUYER] }, { role: "seller", bundleHash: "b".repeat(64), primaryClaim: dids[SELLER] }],
      phaseSummary: [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: (forListing.pipeline as Obj[])[1].kind, outcome: "ok" }, { index: 2, kind: "pay-dem", outcome: "ok" }], vetRecords: [],
      recipeRegistryVersion: 1, railRegistryVersion: 1, finalisedAt: 120,
    } as Obj,
  };
}
type Scopes = ReturnType<typeof baseScopes>;
interface Session { store: Map<string, Obj>; scopes: Scopes; stored: Record<string, Obj>; refs: Record<string, Obj> }
interface Case {
  listing?: Obj;
  anchorNames?: Record<string, string>;
  readAnchorRecord?: EvidenceGraphDeps["readAnchorRecord"];
  noAnchorMetadata?: boolean;
  scopes?: (scopes: Scopes) => void;
  /** Signs and stores the artifacts; the defaults are the parties who produce each one. */
  agreementSigners?: number[]; evidenceSigner?: number; ratingSigner?: number; bundleSigners?: number[];
  artifacts?: (session: Session) => Promise<void> | void;
  bundle?: (bundle: Obj, session: Session) => Promise<void> | void;
  anchoredByRole?: unknown;
  stored?: (bundle: Obj, session: Session) => void;
}

async function evaluate(c: Case = {}) {
  const forListing = c.listing ?? listing;
  const scopes = baseScopes(forListing);
  c.scopes?.(scopes);
  const store = new Map<string, Obj>([[at(1), forListing]]);
  const session: Session = { store, scopes, stored: {}, refs: {} };
  const agreement = { ...scopes.agreement, signatures: await Promise.all((c.agreementSigners ?? [BUYER, SELLER])
    .map((signer) => envelope(scopes.agreement, "agreement", signer, signer, "party"))) };
  const evidence = { ...scopes.evidence, signature: await envelope(scopes.evidence, "evidence", c.evidenceSigner ?? SELLER) };
  const rating = { ...scopes.rating, signature: await envelope(scopes.rating, "rating", c.ratingSigner ?? BUYER) };
  Object.assign(session.stored, { agreement, evidence, rating });
  session.refs = { agreement: refTo(at(2), agreement, "agreement"), evidence: refTo(at(3), evidence, "evidence"), rating: refTo(at(4), rating, "rating") };
  store.set(at(2), agreement).set(at(3), evidence).set(at(4), rating);
  await c.artifacts?.(session);
  const bundle: Obj = { ...scopes.bundle, agreementRef: session.refs.agreement, settlementEvidence: [session.refs.evidence], ratingRefs: [session.refs.rating] };
  await c.bundle?.(bundle, session);
  const signed: Obj = { ...bundle, signatures: await Promise.all((c.bundleSigners ?? [BUYER, SELLER])
    .map((signer) => envelope(bundle, "bundle", signer, signer, "party"))), anchoredByRole: c.anchoredByRole ?? "buyer" };
  c.stored?.(signed, session);
  store.set(at(5), signed);
  return buildCurrentEvidenceGraph(at(5), {
    read: async (locator) => store.get(locator) ?? null,
    readAnchorRecord: c.noAnchorMetadata ? undefined : c.readAnchorRecord ?? (async (locator) => {
      const data = store.get(locator);
      return data ? { data, programName: c.anchorNames?.[locator] ?? `dacs4:payment:${JOB}:pay-dem:${locator === at(42) ? 3 : 2}` } : null;
    }),
    resolveListing: async () => ({ locator: at(1), raw: forListing }),
  });
}

/** Store a signed artifact at a fresh locator and return its reference. */
async function publish(session: Session, n: number, scope: Obj, kind: ArtifactKind, signer: number): Promise<Obj> {
  const raw = { ...scope, signature: await envelope(scope, kind, signer) };
  session.store.set(at(n), raw);
  return refTo(at(n), raw, kind);
}
const SHAPE = "invalid current DACS-5 bundle shape";

async function verdicts(cases: Record<string, Case>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, c] of Object.entries(cases)) {
    const graph = await evaluate(c);
    out[name] = graph.ok ? "ok" : graph.reason ?? "failed without a reason";
  }
  return out;
}

test("the valid fixture session verifies, with every artifact in the graph", async () => {
  const graph = await evaluate();
  assert.equal(graph.ok, true, graph.reason);
  assert.equal(graph.refsVerified, true);
  assert.deepEqual(graph.artifacts.map((artifact) => artifact.kind).sort(), ["agreement", "evidence", "listing", "rating"]);
  assert.deepEqual(agreementPrice(graph.agreement), { amount: "1.25", currency: "DEM" });
});

test("DACS-5 §10.4.1: the bundle's own shape, parties and signatures", async () => {
  const phase = (change: Obj) => (bundle: Obj) => { bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: "pay-dem", outcome: "ok", ...change }]; };
  assert.deepEqual(await verdicts({
    "a singular signature member": { stored: (bundle) => { bundle.signature = bundle.signatures; } },
    "both version discriminators": { bundle: (bundle) => { bundle.faultBundleVersion = "1"; } },
    "another bundleVersion": { bundle: (bundle) => { bundle.bundleVersion = "2"; } },
    "a legacy bundle naming a faulted party": { bundle: (bundle) => { bundle.faultedParty = "none"; } },
    "a jobId that is not a string": { bundle: (bundle) => { bundle.jobId = 7; } },
    "an unknown outcome": { bundle: (bundle) => { bundle.outcome = "won"; } },
    "an unknown anchoredByRole": { anchoredByRole: "auditor" },
    "no listingRef": { bundle: (bundle) => { delete bundle.listingRef; } },
    "one party": { bundle: (bundle) => { bundle.parties = (bundle.parties as Obj[]).slice(0, 1); } },
    "phaseSummary not an array": { bundle: (bundle) => { bundle.phaseSummary = {}; } },
    "a phase entry that is not an object": { bundle: (bundle) => { bundle.phaseSummary = ["pay-dem"]; } },
    "a negative phase index": { bundle: phase({ index: -1 }) },
    "a phase index that is not an integer": { bundle: phase({ index: "2" }) },
    "a phase kind that is not a string": { bundle: phase({ kind: 7 }) },
    "an unknown phase outcome": { bundle: phase({ outcome: "maybe" }) },
    "an unknown errorClass": { bundle: phase({ outcome: "fail", errorClass: "cosmic" }) },
    "two phases with one index": { bundle: (bundle) => { bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: "pay-dem", outcome: "ok" }, { index: 2, kind: "rate", outcome: "ok" }]; } },
    "vetRecords not an array": { bundle: (bundle) => { bundle.vetRecords = {}; } },
    "settlementEvidence not an array": { bundle: (bundle) => { bundle.settlementEvidence = {}; } },
    "ratingRefs not an array": { bundle: (bundle) => { bundle.ratingRefs = "none"; } },
    "an amendments entry naming the settlement evidence": { bundle: (bundle, session) => { bundle.amendments = [session.refs.evidence]; } },
    "a recipe registry version of 0": { bundle: (bundle) => { bundle.recipeRegistryVersion = 0; } },
    "a rail registry version as a string": { bundle: (bundle) => { bundle.railRegistryVersion = "1"; } },
    "finalisedAt as a string": { bundle: (bundle) => { bundle.finalisedAt = "120"; } },
    "two buyers": { bundle: (bundle) => { bundle.parties = [...(bundle.parties as Obj[]), { role: "buyer", bundleHash: "c".repeat(64), primaryClaim: dids[OUTSIDER] }]; } },
    "no seller": { bundle: (bundle) => { bundle.parties = [(bundle.parties as Obj[])[0], { role: "orchestrator", bundleHash: "c".repeat(64), primaryClaim: dids[SELLER] }]; } },
    "a party with an unknown role": { bundle: (bundle) => { bundle.parties = [...(bundle.parties as Obj[]), { role: "auditor", bundleHash: "c".repeat(64), primaryClaim: dids[OUTSIDER] }]; } },
    "a party without a primary claim": { bundle: (bundle) => { (bundle.parties as Obj[])[1] = { role: "seller", bundleHash: "b".repeat(64) }; } },
    "a party bundleHash that is not a hash": { bundle: (bundle) => { (bundle.parties as Obj[])[1] = { ...(bundle.parties as Obj[])[1], bundleHash: "b" }; } },
    "signatures not an array": { stored: (bundle) => { bundle.signatures = (bundle.signatures as Obj[])[0]; } },
    "a signature entry that is not an object": { stored: (bundle) => { bundle.signatures = [...(bundle.signatures as Obj[]), null]; } },
    "a seller signature made with another key": { stored: (bundle) => { (bundle.signatures as Obj[])[1] = { ...(bundle.signatures as Obj[])[1], value: (bundle.signatures as Obj[])[0].value }; } },
    "a signature with another algorithm": { stored: (bundle) => { (bundle.signatures as Obj[])[1] = { ...(bundle.signatures as Obj[])[1], algorithm: "ecdsa-secp256k1" }; } },
    "a signature without a party": { stored: (bundle) => { const { party: _, ...rest } = (bundle.signatures as Obj[])[1]; (bundle.signatures as Obj[])[1] = rest; } },
    "a completed bundle signed by the buyer alone": { bundleSigners: [BUYER] },
    "no agreementRef on a completed session": { bundle: (bundle) => { delete bundle.agreementRef; } },
  }), {
    "a singular signature member": SHAPE, "both version discriminators": SHAPE, "another bundleVersion": SHAPE,
    "a legacy bundle naming a faulted party": SHAPE, "a jobId that is not a string": SHAPE, "an unknown outcome": SHAPE,
    "an unknown anchoredByRole": SHAPE, "no listingRef": SHAPE, "one party": SHAPE, "phaseSummary not an array": SHAPE,
    "a phase entry that is not an object": SHAPE, "a negative phase index": SHAPE, "a phase index that is not an integer": SHAPE,
    "a phase kind that is not a string": SHAPE, "an unknown phase outcome": SHAPE, "an unknown errorClass": SHAPE,
    "two phases with one index": SHAPE, "vetRecords not an array": SHAPE, "settlementEvidence not an array": SHAPE,
    "ratingRefs not an array": SHAPE, "an amendments entry naming the settlement evidence": "duplicate or invalid top-level reference",
    "a recipe registry version of 0": SHAPE,
    "a rail registry version as a string": SHAPE, "finalisedAt as a string": SHAPE,
    "two buyers": "invalid or duplicate bundle parties", "no seller": "invalid or duplicate bundle parties",
    "a party with an unknown role": "invalid or duplicate bundle parties", "a party without a primary claim": "invalid or duplicate bundle parties",
    "a party bundleHash that is not a hash": "invalid or duplicate bundle parties",
    "signatures not an array": "bundle signatures contain malformed entries",
    "a signature entry that is not an object": "bundle signatures contain malformed entries",
    "a seller signature made with another key": "required current bundle signatures are missing or invalid",
    "a signature with another algorithm": "required current bundle signatures are missing or invalid",
    "a signature without a party": "required current bundle signatures are missing or invalid",
    "a completed bundle signed by the buyer alone": "required current bundle signatures are missing or invalid",
    "no agreementRef on a completed session": "non-abort bundle has no agreement",
  });
  // An empty amendments list and a self-aborted session signed by its anchor alone are valid.
  assert.equal((await evaluate({ bundle: (bundle) => { bundle.amendments = []; } })).ok, true);
  assert.equal((await evaluate({ bundleSigners: [BUYER], bundle: (bundle) => { bundle.outcome = "aborted-by-self"; delete bundle.agreementRef; } })).ok, true);
});

test("DACS-5 FaultAttributionBundle: faultedParty agrees with the outcome and the anchoring role", async () => {
  const fault = (outcome: string, faultedParty: unknown, anchoredByRole = "buyer"): Case => ({
    anchoredByRole,
    bundle: (bundle) => {
      delete bundle.bundleVersion;
      Object.assign(bundle, { faultBundleVersion: "1", outcome, faultedParty });
      if (outcome.startsWith("aborted")) delete bundle.agreementRef;
    },
  });
  const ok = "ok"; const bad = "invalid fault attribution";
  assert.deepEqual(await verdicts({
    "completed, none": fault("completed", "none"),
    "completed, seller": fault("completed", "seller"),
    "failed-substrate, none": fault("failed-substrate", "none"),
    "failed-substrate, buyer": fault("failed-substrate", "buyer"),
    "failed-perm, the anchor": fault("failed-perm", "buyer"),
    "failed-perm, the other party": fault("failed-perm", "seller"),
    "aborted-by-self, the anchor": fault("aborted-by-self", "seller", "seller"),
    "aborted-by-self, none": fault("aborted-by-self", "none", "seller"),
    "failed-counterparty, the other party": fault("failed-counterparty", "seller"),
    "failed-counterparty, the anchor": fault("failed-counterparty", "buyer"),
    "failed-counterparty, a role not in the session": fault("failed-counterparty", "orchestrator"),
    "failed-counterparty, not a string": fault("failed-counterparty", 7),
    "aborted-by-other, the other party": fault("aborted-by-other", "buyer", "seller"),
    "aborted-by-other, the anchor": fault("aborted-by-other", "seller", "seller"),
  }), {
    "completed, none": ok, "completed, seller": bad, "failed-substrate, none": ok, "failed-substrate, buyer": bad,
    "failed-perm, the anchor": ok, "failed-perm, the other party": bad, "aborted-by-self, the anchor": ok, "aborted-by-self, none": bad,
    "failed-counterparty, the other party": ok, "failed-counterparty, the anchor": bad,
    "failed-counterparty, a role not in the session": bad, "failed-counterparty, not a string": bad,
    "aborted-by-other, the other party": ok, "aborted-by-other, the anchor": bad,
  });
});

test("DACS-5 §10.4.3: top-level references are current, unique, hash-bound and from this session", async () => {
  const other = (n: number, scope: Obj, kind: ArtifactKind, signer: number) => async (session: Session) => {
    const ref = await publish(session, n, scope, kind, signer);
    session.refs[kind === "evidence" ? "evidence" : kind === "rating" ? "rating" : "agreement"] = ref;
  };
  assert.deepEqual(await verdicts({
    "an agreementRef with another content hash": { bundle: (bundle) => { bundle.agreementRef = { ...(bundle.agreementRef as Obj), contentHash: "0".repeat(64) }; } },
    "an agreementRef on another anchor kind": { bundle: (bundle) => { bundle.agreementRef = { ...(bundle.agreementRef as Obj), anchor: { kind: "ipfs", locator: at(2) } }; } },
    "an agreementRef to a non-native locator": { bundle: (bundle) => { bundle.agreementRef = { ...(bundle.agreementRef as Obj), anchor: { kind: "storage-program", locator: at(2).toUpperCase() } }; } },
    "an evidence ref with another content hash": { bundle: (bundle) => { bundle.settlementEvidence = [{ ...(bundle.settlementEvidence as Obj[])[0], contentHash: "0".repeat(64) }]; } },
    "one evidence listed twice": { bundle: (bundle, session) => { bundle.settlementEvidence = [session.refs.evidence, session.refs.evidence]; } },
    "evidence at the agreement's locator": { bundle: (bundle, session) => { bundle.settlementEvidence = [{ ...session.refs.evidence, anchor: (session.refs.agreement as Obj).anchor }]; } },
    "evidence reusing the agreement's hash": { bundle: (bundle, session) => { bundle.settlementEvidence = [{ ...session.refs.evidence, contentHash: (session.refs.agreement as Obj).contentHash }]; } },
    "an agreement for another job": { scopes: (scopes) => { scopes.agreement.jobId = "other-job"; } },
    "evidence for another job": { scopes: (scopes) => { scopes.evidence.jobId = "other-job"; } },
    "a rating for another job": { scopes: (scopes) => { scopes.rating.jobId = "other-job"; } },
    "evidence signed by an outsider": { evidenceSigner: OUTSIDER },
    "a rating by an outsider": { ratingSigner: OUTSIDER, scopes: (scopes) => { scopes.rating.rater = dids[OUTSIDER]; } },
    "a rating of an outsider": { scopes: (scopes) => { scopes.rating.target = dids[OUTSIDER]; } },
    "a rating naming the wrong target role": { scopes: (scopes) => { scopes.rating.targetRole = "buyer"; } },
    "a second evidence at a fresh locator": { artifacts: other(6, { ...baseScopes().evidence, phaseIndex: 3, paymentTxRefs: [{ kind: "demos", txHash: "ac".repeat(32) }] }, "evidence", SELLER) },
    "the agreement's sha256-prefixed hash": { bundle: (bundle) => { bundle.agreementRef = { ...(bundle.agreementRef as Obj), contentHash: `sha256:${(bundle.agreementRef as Obj).contentHash}` }; } },
  }), {
    "an agreementRef with another content hash": "agreement reference failed",
    "an agreementRef on another anchor kind": "duplicate or invalid top-level reference",
    "an agreementRef to a non-native locator": "duplicate or invalid top-level reference",
    "an evidence ref with another content hash": "evidence reference failed",
    "one evidence listed twice": "duplicate or invalid top-level reference",
    "evidence at the agreement's locator": "duplicate or invalid top-level reference",
    "evidence reusing the agreement's hash": "duplicate or invalid top-level reference",
    "an agreement for another job": "agreement belongs to another job",
    "evidence for another job": "evidence belongs to another job",
    "a rating for another job": "rating belongs to another job",
    "evidence signed by an outsider": "evidence signer is not a session party",
    "a rating by an outsider": "rating party binding failed",
    "a rating of an outsider": "rating party binding failed",
    "a rating naming the wrong target role": "rating party binding failed",
    "a second evidence at a fresh locator": "ok",
    "the agreement's sha256-prefixed hash": "ok",
  });
  // A rating listed twice under one hash collapses; the same locator under another hash does not.
  assert.equal((await evaluate({ bundle: (bundle, session) => { bundle.ratingRefs = [session.refs.rating, session.refs.rating]; } })).ok, true);
  assert.equal((await evaluate({ bundle: (bundle, session) => { bundle.ratingRefs = [session.refs.rating, { ...session.refs.rating, contentHash: "0".repeat(64) }]; } })).reason,
    "duplicate or invalid top-level reference");
});

test("DACS-3 and DACS-5 artifact shapes and signatures: a malformed or wrongly signed artifact fails its reference", async () => {
  const agreement = (change: (scope: Obj) => void): Case => ({ scopes: (scopes) => change(scopes.agreement) });
  const evidence = (change: (scope: Obj) => void): Case => ({ scopes: (scopes) => change(scopes.evidence) });
  const rating = (change: (scope: Obj) => void): Case => ({ scopes: (scopes) => change(scopes.rating) });
  const restore = (kind: "agreement" | "evidence" | "rating", change: (raw: Obj) => void) => (session: Session) => {
    const raw = clone(session.stored[kind]); change(raw);
    session.store.set((session.refs[kind].anchor as Obj).locator as string, raw);
  };
  const AGREEMENT = "agreement reference failed"; const EVIDENCE = "evidence reference failed"; const RATING = "rating reference failed";
  assert.deepEqual(await verdicts({
    "an agreement signed by the buyer alone": { agreementSigners: [BUYER] },
    "an agreement with a forged seller signature": { artifacts: restore("agreement", (raw) => { (raw.signatures as Obj[])[1] = { ...(raw.signatures as Obj[])[1], value: (raw.signatures as Obj[])[0].value }; }) },
    "an agreement carrying a singular signature too": { artifacts: restore("agreement", (raw) => { raw.signature = (raw.signatures as Obj[])[0]; }) },
    "agreement signatures not an array": { artifacts: restore("agreement", (raw) => { raw.signatures = (raw.signatures as Obj[])[0]; }) },
    "an agreement signature entry that is not an object": { artifacts: restore("agreement", (raw) => { raw.signatures = [...(raw.signatures as Obj[]), "sig"]; }) },
    "an agreement with three role holders": agreement((scope) => { scope.parties = [...(scope.parties as Obj[]), { role: "buyer", primaryClaim: dids[OUTSIDER] }]; }),
    "an agreement with one party": agreement((scope) => { scope.parties = (scope.parties as Obj[]).slice(0, 1); }),
    "an agreement without a listingRef": agreement((scope) => { delete scope.listingRef; }),
    "an agreement price with a leading zero": agreement((scope) => { (scope.terms as Obj).price = { amount: "01.25", currency: "DEM" }; }),
    "an agreement price of zero": agreement((scope) => { (scope.terms as Obj).price = { amount: "0", currency: "DEM" }; }),
    "an agreement price without a currency": agreement((scope) => { (scope.terms as Obj).price = { amount: "1.25", currency: "" }; }),
    "an agreement with both discriminators": agreement((scope) => { scope.payeeBoundAgreementVersion = "1"; }),
    "agreementVersion 2": agreement((scope) => { scope.agreementVersion = "2"; }),
    "a plain agreement carrying payout bindings": agreement((scope) => { (scope.terms as Obj).payoutBindings = []; }),
    "evidenceVersion 2": evidence((scope) => { scope.evidenceVersion = "2"; }),
    "an evidence phase that is not a string": evidence((scope) => { scope.phase = 7; }),
    "an unknown evidence outcome": evidence((scope) => { scope.outcome = "maybe"; }),
    "evidence observedAt as a string": evidence((scope) => { scope.observedAt = "100"; }),
    "evidence amendmentRefs not an array": evidence((scope) => { scope.amendmentRefs = {}; }),
    "an evidence attestationRef that is not a reference": evidence((scope) => { scope.attestationRef = { anchor: { kind: "storage-program", locator: at(9) } }; }),
    "evidence with a signatures list": { artifacts: restore("evidence", (raw) => { raw.signatures = [raw.signature]; }) },
    "evidence signed with another algorithm": { artifacts: restore("evidence", (raw) => { raw.signature = { ...(raw.signature as Obj), algorithm: "ecdsa-secp256k1" }; }) },
    "evidence whose signer is not a string": { artifacts: restore("evidence", (raw) => { raw.signature = { ...(raw.signature as Obj), signer: 7 }; }) },
    "evidence without a signature": { artifacts: restore("evidence", (raw) => { delete raw.signature; }) },
    "ratingVersion 2": rating((scope) => { scope.ratingVersion = "2"; }),
    "a rating of 0": rating((scope) => { scope.value = 0; }),
    "a rating of 6": rating((scope) => { scope.value = 6; }),
    "a rating that is not an integer": rating((scope) => { scope.value = "5"; }),
    "a rating of an orchestrator": rating((scope) => { scope.targetRole = "orchestrator"; }),
    "ratedAt as a string": rating((scope) => { scope.ratedAt = "110"; }),
    "free text over 1,000 characters": rating((scope) => { scope.freeText = "x".repeat(1001); }),
    "a rating signed by the seller for the buyer": { ratingSigner: SELLER },
    "a rating whose rater is not a string": { scopes: (scopes) => { scopes.rating.rater = 7; } },
  }), {
    "an agreement signed by the buyer alone": AGREEMENT, "an agreement with a forged seller signature": AGREEMENT,
    "an agreement carrying a singular signature too": AGREEMENT, "agreement signatures not an array": AGREEMENT,
    "an agreement signature entry that is not an object": AGREEMENT, "an agreement with three role holders": AGREEMENT,
    "an agreement with one party": AGREEMENT, "an agreement without a listingRef": AGREEMENT,
    "an agreement price with a leading zero": AGREEMENT, "an agreement price of zero": AGREEMENT,
    "an agreement price without a currency": AGREEMENT, "an agreement with both discriminators": AGREEMENT,
    "agreementVersion 2": AGREEMENT, "a plain agreement carrying payout bindings": AGREEMENT,
    "evidenceVersion 2": EVIDENCE, "an evidence phase that is not a string": EVIDENCE, "an unknown evidence outcome": EVIDENCE,
    "evidence observedAt as a string": EVIDENCE, "evidence amendmentRefs not an array": EVIDENCE,
    "an evidence attestationRef that is not a reference": EVIDENCE, "evidence with a signatures list": EVIDENCE,
    "evidence signed with another algorithm": EVIDENCE, "evidence whose signer is not a string": EVIDENCE,
    "evidence without a signature": EVIDENCE,
    "ratingVersion 2": RATING, "a rating of 0": RATING, "a rating of 6": RATING, "a rating that is not an integer": RATING,
    "a rating of an orchestrator": RATING, "ratedAt as a string": RATING, "free text over 1,000 characters": RATING,
    "a rating signed by the seller for the buyer": RATING, "a rating whose rater is not a string": RATING,
  });
  // Boundaries that stay valid: failure evidence for a failed phase, ratings of 1 and 5, and exactly 1,000 characters of free text.
  const failedPayment: Case = { scopes: (scopes) => {
    scopes.evidence.outcome = "failure"; delete scopes.evidence.settlementFinality;
    scopes.bundle.outcome = "failed-perm";
    scopes.bundle.phaseSummary = [{ index: 2, kind: "pay-dem", outcome: "fail", errorClass: "permanent" }];
  } };
  for (const c of [failedPayment, rating((scope) => { scope.value = 1; }),
    rating((scope) => { scope.freeText = "x".repeat(1000); })]) {
    const graph = await evaluate(c);
    assert.equal(graph.ok, true, graph.reason);
  }
});

test("DACS-2 vet records and DACS-4 evidence chains are dereferenced and checked transitively", async () => {
  const requirementHash = contentHash((listing.buyerRequirement as Obj));
  const attestationRaw = { authority: "registry", body: "ok" };
  const attest = (session: Session, n = 20) => {
    session.store.set(at(n), attestationRaw);
    return { anchor: { kind: "storage-program", locator: at(n) }, contentHash: contentHash(attestationRaw) };
  };
  const verifyResult = (session: Session, change: Obj = {}) => ({
    resultVersion: "1", scheme: "lei", identifier: "5493001KJTIIGC8Y1R12", recipeVersion: 1, method: "verifiable-credential", decision: "pass",
    reason: "registry match", attestation: attest(session), fetchedAt: 10, verifiedAt: 20, ...change,
  });
  const composite = (change: Obj = {}) => ({
    recordVersion: "1", jobId: JOB, evaluatedParty: dids[BUYER], bundleHash: "a".repeat(64), requirementHash,
    freshness: [], supplementary: [], dealSpecific: [], overallDecision: "pass", generatedAt: 30, ...change,
  });
  const vetted = (build: (session: Session) => Promise<Obj>): Case => ({
    bundle: async (bundle, session) => { bundle.vetRecords = [await publish(session, 30, await build(session), "composite", SELLER)]; },
  });
  const withResult = (change: Obj = {}, refChange: (ref: Obj) => Obj = (ref) => ref) => vetted(async (session) => {
    const ref = await publish(session, 31, verifyResult(session, change), "verify-result", OUTSIDER);
    return composite({ freshness: [refChange({ ...ref, recipeVersion: 1 })] });
  });
  const signal = (change: Obj) => vetted(async () => composite({ supplementary: [{ source: "dacs-5", signalType: "completion-rate", value: 90, observedAt: 5, ...change }] }));
  // A SettlementAmendment (DACS-4 §9.7.1), listed in the bundle's amendments and naming the evidence it amends.
  const amendmentOf = (amends: Obj, change: Obj = {}) => ({
    amendmentVersion: "1", jobId: JOB, amendsEvidenceRef: amends, amendmentType: "partial-refund",
    refundAmount: { amount: "0.25", currency: "DEM" }, reason: "late delivery", observedAt: 130, ...change,
  });
  const amended = (scope: (base: Obj) => Obj, signer = SELLER): Case => ({
    bundle: async (bundle, session) => {
      bundle.amendments = [await publish(session, 40, scope(amendmentOf(session.refs.evidence)), "amendment", signer)];
    },
  });
  const chained = (key: "supersedesEvidenceRef"): Case => ({
    artifacts: async (session) => {
      const { settlementFinality: _, ...failed } = baseScopes().evidence;
      const interim = await publish(session, 40, { ...failed, outcome: "failure" }, "evidence", SELLER);
      session.refs.evidence = await publish(session, 41, { ...session.scopes.evidence, [key]: interim }, "evidence", SELLER);
    },
  });
  const COMPOSITE = "composite reference failed"; const NESTED = "nested VerifyResult reference failed";
  assert.deepEqual(await verdicts({
    "a verified result and its attestation": withResult(),
    "a result whose decision is not in the enum": withResult({ decision: "maybe" }),
    "a result whose attestation is not a reference": withResult({ attestation: { anchor: { kind: "storage-program", locator: at(20) } } }),
    "a result reference with another content hash": withResult({}, (ref) => ({ ...ref, contentHash: "0".repeat(64) })),
    "a result whose attestation hash does not match": vetted(async (session) => {
      const result = verifyResult(session, { attestation: { ...attest(session), contentHash: "0".repeat(64) } });
      return composite({ dealSpecific: [{ ...(await publish(session, 31, result, "verify-result", OUTSIDER)), recipeVersion: 1 }] });
    }),
    "a supplementary signal from dacs-5": signal({}),
    "an external signal without an attestation": signal({ source: "external" }),
    "an external signal with its attestation": vetted(async (session) => composite({ supplementary: [{ source: "external", signalType: "rating-avg", value: "4.5", observedAt: 5, attestation: attest(session) }] })),
    "a signal value that is a boolean": signal({ value: true }),
    "a signal source that is not a string": signal({ source: 7 }),
    "a signal without a type": signal({ signalType: undefined }),
    "a signal without observedAt": signal({ observedAt: undefined }),
    "a signal that is not an object": vetted(async () => composite({ supplementary: ["signal"] })),
    "a record for another job": vetted(async () => composite({ jobId: "other-job" })),
    "a record with an unknown decision": vetted(async () => composite({ overallDecision: "maybe" })),
    "freshness not an array": vetted(async () => composite({ freshness: {} })),
    "an amendment from the seller": amended((scope) => scope),
    "an amendment for another job": amended((scope) => ({ ...scope, jobId: "other-job" })),
    "an amendment signed by an outsider": amended((scope) => scope, OUTSIDER),
    "an amendment of another type": amended((scope) => ({ ...scope, amendmentType: "chargeback" })),
    "an amendment shaped as evidence": amended(() => ({ ...baseScopes().evidence, observedAt: 101 })),
    "a superseded evidence reference": chained("supersedesEvidenceRef"),
    "a superseded reference with another hash": { artifacts: async (session) => {
      const first = { ...session.scopes.evidence, supersedesEvidenceRef: { ...session.refs.evidence, contentHash: "0".repeat(64) } };
      session.refs.evidence = await publish(session, 41, first, "evidence", SELLER);
    } },
    "a delivery attestation that matches": { artifacts: async (session) => {
      session.refs.evidence = await publish(session, 41, { ...session.scopes.evidence, attestationRef: attest(session) }, "evidence", SELLER);
    } },
    "a delivery attestation with another hash": { artifacts: async (session) => {
      session.refs.evidence = await publish(session, 41, { ...session.scopes.evidence, attestationRef: { ...attest(session), contentHash: "0".repeat(64) } }, "evidence", SELLER);
    } },
    "a phase attestationRef to the verified evidence": { bundle: (bundle, session) => { bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: "pay-dem", outcome: "ok", attestationRef: session.refs.evidence }]; } },
    "a phase attestationRef outside the graph": { bundle: (bundle, session) => { bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: "pay-dem", outcome: "ok", attestationRef: { ...session.refs.evidence, contentHash: "0".repeat(64) } }]; } },
    "a phase attestationRef that is not a reference": { bundle: (bundle) => { bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: "pay-dem", outcome: "ok", attestationRef: "evidence" }]; } },
    // DACS-2 §7.5 VerifyResult and §7.7 CompositeVerificationRecord members, one each.
    "a result with resultVersion 2": withResult({ resultVersion: "2" }),
    "a result whose scheme is not a string": withResult({ scheme: 7 }),
    "a result without an identifier": withResult({ identifier: undefined }),
    "a result whose verifiedAt is a string": withResult({ verifiedAt: "20" }),
    "a record with recordVersion 2": vetted(async () => composite({ recordVersion: "2" })),
    "a record whose dealSpecific is not an array": vetted(async () => composite({ dealSpecific: {} })),
    // CORE §B.3: a VerifyResultRef met twice must name the resolved result's recipeVersion both times.
    "a result referenced again under another recipeVersion": vetted(async (session) => {
      const ref = await publish(session, 31, verifyResult(session), "verify-result", OUTSIDER);
      return composite({ freshness: [{ ...ref, recipeVersion: 1 }], dealSpecific: [{ ...ref, recipeVersion: 2 }] });
    }),
    // Malformed nested references fail the graph instead of being skipped.
    "an evidence supersedesEvidenceRef that is not a reference": { artifacts: async (session) => {
      session.refs.evidence = await publish(session, 41, { ...session.scopes.evidence, supersedesEvidenceRef: "evidence" }, "evidence", SELLER);
    } },
    "an evidence amendmentRefs entry that is not a reference": { artifacts: async (session) => {
      session.refs.evidence = await publish(session, 41, { ...session.scopes.evidence, amendmentRefs: [{ anchor: { kind: "storage-program" } }] }, "evidence", SELLER);
    } },
  }), {
    "a verified result and its attestation": "ok", "a result whose decision is not in the enum": NESTED,
    "a result whose attestation is not a reference": NESTED, "a result reference with another content hash": NESTED,
    "a result whose attestation hash does not match": "VerifyResult attestation reference failed",
    "a supplementary signal from dacs-5": "ok", "an external signal without an attestation": COMPOSITE,
    "an external signal with its attestation": "ok", "a signal value that is a boolean": COMPOSITE,
    "a signal source that is not a string": COMPOSITE, "a signal without a type": COMPOSITE, "a signal without observedAt": COMPOSITE,
    "a signal that is not an object": COMPOSITE, "a record for another job": "composite belongs to another job",
    "a record with an unknown decision": COMPOSITE, "freshness not an array": COMPOSITE,
    "an amendment from the seller": "ok", "an amendment for another job": "amendment belongs to another job",
    "an amendment signed by an outsider": "amendment signer is not a session party",
    "an amendment of another type": "amendment reference failed", "an amendment shaped as evidence": "amendment reference failed",
    "a superseded evidence reference": "ok",
    "a superseded reference with another hash": "settlement evidence chain failed",
    "a delivery attestation that matches": "ok", "a delivery attestation with another hash": "delivery attestation reference failed",
    "a phase attestationRef to the verified evidence": "ok",
    "a phase attestationRef outside the graph": "phase attestation reference is outside the verified graph",
    "a phase attestationRef that is not a reference": "phase attestation reference is outside the verified graph",
    "a result with resultVersion 2": NESTED, "a result whose scheme is not a string": NESTED,
    "a result without an identifier": NESTED, "a result whose verifiedAt is a string": NESTED,
    "a record with recordVersion 2": COMPOSITE, "a record whose dealSpecific is not an array": COMPOSITE,
    "a result referenced again under another recipeVersion": NESTED,
    "an evidence supersedesEvidenceRef that is not a reference": "settlement evidence chain failed",
    "an evidence amendmentRefs entry that is not a reference": "settlement amendment reference failed",
  });
});

test("DACS-5 §10.4.3 and DACS-4 §9.7: settlement evidence covers each executed settle phase and a success states amount and finality", async () => {
  const phase = (change: Obj = {}) => ({ index: 2, kind: "pay-dem", outcome: "ok", ...change });
  const evidence = (change: (scope: Obj) => void): Case => ({ scopes: (scopes) => change(scopes.evidence) });
  const COVERAGE = "settlement evidence does not match the executed settle phases";
  const POINTER = "a settle phase's attestationRef does not name its own settlement evidence";
  const deliveryListing = await listingFor("commit-agreement", "deliver-attested-payload");
  const repeatedListing = await listingFor("commit-agreement", "pay-dem");
  const delivery = { evidenceVersion: "1", jobId: JOB, phase: "deliver-attested-payload", outcome: "success", observedAt: 105 };
  assert.deepEqual(await verdicts({
    "a completed payment phase with no evidence": { bundle: (bundle) => { bundle.settlementEvidence = []; } },
    "evidence for a phase the bundle never ran": { bundle: (bundle) => { bundle.phaseSummary = []; } },
    "two records for one payment phase": { bundle: async (bundle, session) => {
      bundle.settlementEvidence = [session.refs.evidence, await publish(session, 42, { ...session.scopes.evidence, observedAt: 101 }, "evidence", SELLER)];
    } },
    "a delivery phase with its delivery evidence": { listing: deliveryListing, bundle: async (bundle, session) => {
      bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, phase(), { index: 3, kind: "deliver-attested-payload", outcome: "ok" }];
      bundle.settlementEvidence = [session.refs.evidence, await publish(session, 42, delivery, "evidence", SELLER)];
    } },
    "a delivery phase whose evidence is missing": { bundle: (bundle) => { bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, phase(), { index: 3, kind: "deliver-attested-payload", outcome: "ok" }]; } },
    "a successful payment phase resting on failure evidence": evidence((scope) => { scope.outcome = "failure"; delete scope.settlementFinality; }),
    "a failed payment phase resting on success evidence": { bundle: (bundle) => { bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, phase({ outcome: "fail", errorClass: "permanent" })]; } },
    "a phase pointer naming evidence of another phase": { bundle: async (bundle, session) => {
      const ref = await publish(session, 42, delivery, "evidence", SELLER);
      bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, phase({ attestationRef: ref }), { index: 3, kind: "deliver-attested-payload", outcome: "ok", attestationRef: session.refs.evidence }];
      bundle.settlementEvidence = [session.refs.evidence, ref];
    } },
    "a success without paymentAmount": evidence((scope) => { delete scope.paymentAmount; }),
    "a success without settlementFinality": evidence((scope) => { delete scope.settlementFinality; }),
    "a success under an unknown finality model": evidence((scope) => { scope.settlementFinality = { model: "vibes" }; }),
    "a success citing no transaction": evidence((scope) => { scope.paymentTxRefs = []; }),
    "a failure carrying a finality record": evidence((scope) => { scope.outcome = "failure"; }),
    "evidence for a non-settle phase": evidence((scope) => { scope.phase = "rate"; }),
    "delivery evidence carrying a finality record": { bundle: async (bundle, session) => {
      bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, phase(), { index: 3, kind: "deliver-attested-payload", outcome: "ok" }];
      bundle.settlementEvidence = [session.refs.evidence, await publish(session, 42, { ...delivery, settlementFinality: { model: "bft-final", finalityObservedAt: 100 } }, "evidence", SELLER)];
    } },
  }), {
    "a completed payment phase with no evidence": COVERAGE, "evidence for a phase the bundle never ran": COVERAGE,
    "two records for one payment phase": COVERAGE, "a delivery phase with its delivery evidence": "ok",
    "a delivery phase whose evidence is missing": COVERAGE,
    "a successful payment phase resting on failure evidence": "a settle phase's outcome contradicts its settlement evidence",
    "a failed payment phase resting on success evidence": "a settle phase's outcome contradicts its settlement evidence",
    "a phase pointer naming evidence of another phase": POINTER,
    "a success without paymentAmount": "evidence reference failed", "a success without settlementFinality": "evidence reference failed",
    "a success under an unknown finality model": "evidence reference failed", "a success citing no transaction": "evidence reference failed",
    "a failure carrying a finality record": "evidence reference failed", "evidence for a non-settle phase": "evidence reference failed",
    "delivery evidence carrying a finality record": "evidence reference failed",
  });
  // SB-1: the phase index comes from the bundle's phase entry, by pointer or as the only entry of its kind.
  const single = await evaluate();
  assert.deepEqual(single.settlement.map((entry) => entry.phaseIndex), [2]);
  const twoPays = await evaluate({ listing: repeatedListing, anchorNames: { [at(3)]: `dacs4:payment:${JOB}:pay-dem:3`, [at(42)]: `dacs4:payment:${JOB}:pay-dem:2` }, bundle: async (bundle, session) => {
    const second = await publish(session, 42, { ...session.scopes.evidence, observedAt: 102 }, "evidence", SELLER);
    bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, phase({ attestationRef: second }), phase({ index: 3, attestationRef: session.refs.evidence })];
    bundle.settlementEvidence = [session.refs.evidence, second];
  } });
  assert.equal(twoPays.ok, true, twoPays.reason);
  assert.deepEqual(twoPays.settlement.map((entry) => entry.phaseIndex), [3, 2]);
  const unpointed = await evaluate({ listing: repeatedListing, bundle: async (bundle, session) => {
    bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, phase(), phase({ index: 3 })];
    bundle.settlementEvidence = [session.refs.evidence, await publish(session, 42, { ...session.scopes.evidence, observedAt: 102 }, "evidence", SELLER)];
  } });
  assert.equal(unpointed.ok, true, unpointed.reason);
  assert.deepEqual(unpointed.settlement.map((entry) => entry.phaseIndex), [2, 3], "SB-1 recovers repeated invocation indices from anchor metadata");
});

test("DACS-4 AMEND-1..4: an amendment that fails its rules is flagged, kept for audit, and never an unwind", async () => {
  const amendment = (change: Obj = {}, amends?: (session: Session) => Obj) => async (bundle: Obj, session: Session) => {
    const scope = { amendmentVersion: "1", jobId: JOB, amendsEvidenceRef: amends ? amends(session) : session.refs.evidence,
      amendmentType: "partial-refund", refundAmount: { amount: "0.25", currency: "DEM" }, reason: "late", observedAt: 130, ...change };
    bundle.amendments = [...(bundle.amendments as Obj[] ?? []), await publish(session, 40 + ((bundle.amendments as Obj[] | undefined)?.length ?? 0), scope, "amendment", SELLER)];
  };
  const flags = async (...steps: Array<(bundle: Obj, session: Session) => Promise<void>>) => {
    const graph = await evaluate({ bundle: async (bundle, session) => { for (const step of steps) await step(bundle, session); } });
    assert.equal(graph.ok, true, graph.reason);
    return graph.flaggedAmendments.map((flag) => flag.reason);
  };
  assert.deepEqual(await flags(amendment()), []);
  assert.deepEqual(await flags(amendment({ amendmentType: "correction", refundAmount: undefined })), []);
  assert.deepEqual(await flags(amendment({ amendmentType: "correction" })), ["AMEND-2: a correction carries a refundAmount"]);
  assert.deepEqual(await flags(amendment({ refundAmount: { amount: "0.25", currency: "USD" } })), ["AMEND-3: the refund is not in the settled currency"]);
  assert.deepEqual(await flags(amendment({ amendmentType: "refund", refundAmount: undefined })), ["AMEND-3: the refund is not in the settled currency"]);
  // Refunds of 1 and then 0.5 against a settled 1.25: the later one overdraws.
  assert.deepEqual(await flags(amendment({ refundAmount: { amount: "1", currency: "DEM" } }), amendment({ refundAmount: { amount: "0.5", currency: "DEM" }, observedAt: 140 })),
    ["AMEND-3: refunds exceed the settled amount"]);
  assert.deepEqual(await flags(amendment({ refundAmount: { amount: "1.25", currency: "DEM" } })), [], "a full refund is within the settled amount");
  assert.deepEqual(await flags(amendment({}, (session) => ({ ...session.refs.evidence, contentHash: "0".repeat(64) }))),
    ["AMEND-1: the amended evidence does not resolve for this job"]);
  const failed = await evaluate({
    scopes: (scopes) => {
      scopes.evidence.outcome = "failure"; delete scopes.evidence.settlementFinality;
      scopes.bundle.outcome = "failed-perm";
      scopes.bundle.phaseSummary = [{ index: 2, kind: "pay-dem", outcome: "fail", errorClass: "permanent" }];
    },
    bundle: amendment({ amendmentType: "refund" }),
  });
  assert.deepEqual(failed.flaggedAmendments.map((flag) => flag.reason), ["AMEND-2: a refund amends evidence that did not succeed"]);
});

test("bundle signatures: every presented signature must verify, and standing comes from the verified set", async () => {
  const extra = await evaluate({ stored: (bundle) => {
    bundle.signatures = [...(bundle.signatures as Obj[]), { party: dids[OUTSIDER], algorithm: "ed25519", value: (bundle.signatures as Obj[])[0].value }];
  } });
  assert.equal(extra.reason, "required current bundle signatures are missing or invalid");
  assert.deepEqual(extra.signedParties, []);
  const graph = await evaluate();
  assert.deepEqual([...graph.signedParties].sort(), [dids[BUYER], dids[SELLER]].sort());
  const aborted = await evaluate({ bundleSigners: [BUYER], bundle: (bundle) => { bundle.outcome = "aborted-by-self"; delete bundle.agreementRef; bundle.settlementEvidence = []; bundle.phaseSummary = []; } });
  assert.equal(aborted.ok, true, aborted.reason);
  assert.deepEqual(aborted.signedParties, [dids[BUYER]]);
});

test("DACS-1 LR-1, §8.5.2 checks 5-6 and malformed top-level entries", async () => {
  const listingWith = async (change: (scope: Obj) => void): Promise<Obj> => {
    const scope = clone(signedScopeOf(listing)); change(scope);
    return { ...scope, signature: await envelope(scope, "listing", SELLER) };
  };
  const tupleRef = (change: Obj): Case => ({ bundle: (bundle) => { bundle.listingRef = { ...(bundle.listingRef as Obj), ...change }; } });
  const INDETERMINATE = "agreement listing conformance is indeterminate: checks 5 and 6 need the commitment's committedAt";
  const TOP = "duplicate or invalid top-level reference";
  assert.deepEqual(await verdicts({
    "a listingRef naming another listingId": tupleRef({ listingId: "other" }),
    "a listingRef naming another version": tupleRef({ version: 2 }),
    "a listingRef without a version": tupleRef({ version: undefined }),
    "a listing with a commit deadline window": { listing: await listingWith((scope) => { (scope.terms as Obj).deadlineSecAfterCommit = 3600; }),
      scopes: (scopes) => { (scopes.agreement.terms as Obj).deadline = 4_000_000; } },
    "a listing with an expiry": { listing: await listingWith((scope) => { (scope.validity as Obj).notAfter = 9_999_999_999_999; }) },
    "a non-reference settlementEvidence entry": { bundle: (bundle) => { bundle.settlementEvidence = [...(bundle.settlementEvidence as Obj[]), "evidence"]; } },
    "a non-reference vetRecords entry": { bundle: (bundle) => { bundle.vetRecords = [7]; } },
    "a non-reference ratingRefs entry": { bundle: (bundle) => { bundle.ratingRefs = [...(bundle.ratingRefs as Obj[]), null]; } },
    "a non-reference amendments entry": { bundle: (bundle) => { bundle.amendments = [{}]; } },
  }), {
    "a listingRef naming another listingId": "listing reference failed", "a listingRef naming another version": "listing reference failed",
    "a listingRef without a version": "listing reference failed",
    "a listing with a commit deadline window": INDETERMINATE, "a listing with an expiry": INDETERMINATE,
    "a non-reference settlementEvidence entry": TOP, "a non-reference vetRecords entry": TOP,
    "a non-reference ratingRefs entry": TOP, "a non-reference amendments entry": TOP,
  });
  // With committedAt supplied, checks 5 and 6 decide; a later failure still beats an unresolved check.
  const agreement = baseScopes().agreement;
  const dated = { ...agreement, terms: { ...(agreement.terms as Obj), deadline: 1_003_600_000 } };
  const bounded = { ...listing, terms: { deadlineSecAfterCommit: 3600 }, validity: { notBefore: 1, notAfter: 2_000_000_000 } };
  const check = (value: Obj, offer: Obj, committedAt: number | null) => agreementListingConformance(value, offer, dids[SELLER], committedAt);
  assert.equal(check(dated, bounded, 1_000_000_000), null);
  assert.equal(check(dated, bounded, 999_999_999), "deadline");
  assert.equal(check(dated, bounded, 2_000_000_001), "not-expired");
  assert.equal(check(dated, bounded, null), COMMITTED_AT_INDETERMINATE);
  assert.equal(check(agreement, bounded, 1_000_000_000), "deadline", "a listing deadline window needs an agreed deadline");
  assert.equal(check({ ...dated, derivedFromPattern: "rfq" }, bounded, null), "pattern", "a failure beats an unresolved check");
  assert.equal(check(agreement, listing, null), null, "no listing bound leaves checks 5 and 6 vacuous");
  // Fixed-price over negotiable still needs a band whose lower bound is above zero.
  const tiny = { ...listing, pricing: { kind: "negotiable", bandCenter: { amount: "0.01", currency: "DEM" }, minPct: 60, maxPct: 10 } };
  const atCentre = { ...agreement, terms: { ...(agreement.terms as Obj), price: { amount: "0.01", currency: "DEM" } } };
  assert.equal(check(atCentre, tiny, null), "price");
  assert.equal(check(atCentre, { ...tiny, pricing: { ...(tiny.pricing as Obj), minPct: 40 } }, null), null);
});

test("DACS-3 §8.5 and CA-7: the agreement binds the session's listing and parties, and payee-bound payouts cover the pipeline", async () => {
  const payee = (bindings: unknown): Case => ({
    listing: payeeBoundListing,
    scopes: (scopes) => {
      delete scopes.agreement.agreementVersion;
      scopes.agreement.payeeBoundAgreementVersion = "1";
      (scopes.agreement.terms as Obj).payoutBindings = bindings;
    },
  });
  const binding = (change: Obj = {}) => ({ railId: "pay-dem", phaseIndex: 2, payeeAddress: dids[SELLER], ...change });
  const COVERAGE = "agreement fails listing conformance check: commitment-artifact";
  assert.deepEqual(await verdicts({
    "the bundle pins another listing hash": { bundle: (bundle) => { bundle.listingRef = { ...(bundle.listingRef as Obj), contentHash: "0".repeat(64) }; } },
    "the agreement pins another listing version": { scopes: (scopes) => { scopes.agreement.listingRef = { ...(scopes.agreement.listingRef as Obj), version: 2 }; } },
    "the agreement's seller is not the bundle's": { agreementSigners: [BUYER, OUTSIDER], scopes: (scopes) => {
      scopes.agreement.parties = [{ role: "buyer", primaryClaim: dids[BUYER] }, { role: "seller", primaryClaim: dids[OUTSIDER] }];
    } },
    "a plain agreement on a payee-bound listing": { listing: payeeBoundListing },
    "exact payout coverage": payee([binding()]),
    "no payout bindings": payee([]),
    "an extra payout binding": payee([binding(), binding({ phaseIndex: 3 })]),
    "a duplicated payout binding": payee([binding(), binding()]),
    "a payout binding on another rail": payee([binding({ railId: "pay-x402" })]),
    "a payout binding for another phase": payee([binding({ phaseIndex: 1 })]),
    "a negative phase index": payee([binding({ phaseIndex: -1 })]),
    "an empty payee address": payee([binding({ payeeAddress: "" })]),
    "an empty rail id": payee([binding({ railId: "" })]),
    "payout bindings not an array": payee(binding()),
    "a payout binding that is not an object": payee(["pay-dem"]),
  }), {
    "the bundle pins another listing hash": "listing reference failed",
    "the agreement pins another listing version": "agreement listing binding failed",
    "the agreement's seller is not the bundle's": "agreement party binding failed",
    "a plain agreement on a payee-bound listing": COVERAGE,
    "exact payout coverage": "ok", "no payout bindings": COVERAGE, "an extra payout binding": COVERAGE,
    "a duplicated payout binding": COVERAGE, "a payout binding on another rail": COVERAGE, "a payout binding for another phase": COVERAGE,
    "a negative phase index": "agreement reference failed", "an empty payee address": "agreement reference failed",
    "an empty rail id": "agreement reference failed", "payout bindings not an array": "agreement reference failed",
    "a payout binding that is not an object": "agreement reference failed",
  });
});

test("DACS-3 §8.5.2: terms, pricing kinds and the band's inputs are checked before any amount", () => {
  const base = baseScopes().agreement;
  const withListing = (pricing: unknown, pipeline: unknown = listing.pipeline, extra: Obj = {}) => ({ ...listing, pricing, pipeline, ...extra });
  const check = (agreement: Obj, offer: Obj) => agreementListingConformance(agreement, offer, dids[SELLER]);
  const price = (amount: string, currency = "DEM") => ({ ...base, terms: { ...(base.terms as Obj), price: { amount, currency } } });
  assert.equal(check(base, listing), null);
  assert.equal(check({ ...base, terms: undefined }, listing), "terms");
  assert.equal(check(base, withListing(undefined)), "terms");
  assert.equal(check({ ...base, terms: { ...(base.terms as Obj), price: undefined } }, listing), "terms");
  assert.equal(check(price("0"), listing), "terms");
  // Auction pricing: the reserve's currency binds the agreement; the reserve is an inclusive ceiling
  // for lowest-price and an inclusive floor for every other rule (DACS-4 PricingSpec, DACS-3 §8.4.3).
  // No reserve leaves only the other checks.
  const sealed = [{ kind: "negotiate-sealed-envelope" }, ...(listing.pipeline as Obj[]).slice(1)];
  const auction = (reservePrice?: Obj, selectionRule = "lowest-price") =>
    withListing({ kind: "auction", selectionRule, ...(reservePrice ? { reservePrice } : {}) }, sealed);
  const won = { ...base, derivedFromPattern: "sealed-envelope" };
  const reserve = (amount: string, currency = "DEM") => ({ amount, currency });
  assert.equal(check(won, auction()), null);
  assert.equal(check(won, auction(reserve("1", "USD"))), "currency");
  assert.equal(check(won, auction(reserve("1"))), "price", "lowest-price: an agreed 1.25 is above a reserve ceiling of 1");
  assert.equal(check(won, auction(reserve("1.25"))), null, "lowest-price: the ceiling is inclusive");
  assert.equal(check(won, auction(reserve("2"))), null);
  for (const rule of ["highest-price", "first-acceptable", `rule-ref:${"a".repeat(64)}:https://rules.example/r`]) {
    assert.equal(check(won, auction(reserve("2"), rule)), "price", `${rule}: an agreed 1.25 is below a reserve floor of 2`);
    assert.equal(check(won, auction(reserve("1.25"), rule)), null, `${rule}: the floor is inclusive`);
    assert.equal(check(won, auction(reserve("1"), rule)), null, rule);
  }
  // Metered pricing without a minimum total is unitPrice × quantity exactly.
  const metered = withListing({ kind: "metered", unitPrice: { amount: "0.25", currency: "DEM" }, unit: "call" });
  const usage = (amount: string, quantity: string) => ({ ...price(amount), terms: { ...(price(amount).terms as Obj), meteredQuantity: { quantity, unit: "call" } } });
  assert.equal(check(usage("1.25", "5"), metered), null);
  assert.equal(check(usage("1.5", "5"), metered), "price");
  assert.equal(check(usage("0", "0"), metered), "terms", "a zero total is not a positive price");
  // A minimum total equal to the computed total is not "greater"; the total stands.
  const floored = withListing({ kind: "metered", unitPrice: { amount: "0.25", currency: "DEM" }, unit: "call", minTotal: { amount: "1.25", currency: "DEM" } });
  assert.equal(check(usage("1.25", "5"), floored), null);
  // A band whose percentages are not plain non-negative numbers has no bounds.
  const rfq = [{ kind: "negotiate-rfq", parameters: { maxTurns: 6, timeoutSec: 60 } }, ...(listing.pipeline as Obj[]).slice(1)];
  const quoted = { ...price("1.25"), derivedFromPattern: "rfq" };
  const band = (minPct: unknown, maxPct: unknown) => withListing({ kind: "negotiable", bandCenter: { amount: "1.25", currency: "DEM" }, minPct, maxPct }, rfq);
  assert.equal(check(quoted, band(10, 10)), null);
  for (const [minPct, maxPct] of [["10", 10], [10, "10"], [-1, 10], [10, 1e-7], [10, Number.NaN]] as const) {
    assert.equal(check(quoted, band(minPct, maxPct)), "price", `${String(minPct)} ${String(maxPct)}`);
  }
  // Rail versions bind only when both sides state one; another rail id never matches.
  const railed = (rail: Obj, accepted: Obj[]) => check({ ...base, terms: { ...(base.terms as Obj), rail } }, withListing(listing.pricing, listing.pipeline, { acceptedRails: accepted }));
  assert.equal(railed({ railId: "pay-dem", railVersion: 2 }, [{ railId: "pay-dem" }]), null);
  assert.equal(railed({ railId: "pay-dem" }, [{ railId: "pay-dem", railVersion: 2 }]), null);
  assert.equal(railed({ railId: "pay-dem" }, [{ railId: "pay-x402" }, { railId: "pay-dem" }]), null);
  assert.equal(railed({ railId: "pay-dem" }, [{ railId: "pay-x402" }]), "rail");
  // A listing whose offering has no deliverable, or whose pipeline has no negotiation step, cannot conform.
  assert.equal(check(base, { ...listing, offering: {} }), "deliverable");
  assert.equal(check(base, withListing(listing.pricing, (listing.pipeline as Obj[]).slice(1))), "pattern");
});

test("a current reference names a native storage locator and a sha256 content hash", () => {
  const hash = "a".repeat(64);
  assert.equal(isCurrentRef({ anchor: { kind: "storage-program", locator: at(1) }, contentHash: hash }), true);
  assert.equal(isCurrentRef({ anchor: { kind: "storage-program", locator: at(1) }, contentHash: `sha256:${hash}` }), true);
  for (const value of [
    null, "ref", { contentHash: hash }, { anchor: { kind: "ipfs", locator: at(1) }, contentHash: hash },
    { anchor: { kind: "storage-program", locator: 7 }, contentHash: hash }, { anchor: { kind: "storage-program", locator: "stor-12" }, contentHash: hash },
    { anchor: { kind: "storage-program", locator: at(1) }, contentHash: "a".repeat(63) }, { anchor: { kind: "storage-program", locator: at(1) } },
  ]) assert.equal(isCurrentRef(value), false, JSON.stringify(value));
});

test("further graph rules: discriminators, profiles, bounds, external verifiers and phase back-pointers", async () => {
  // CA-5: an agreement carrying both discriminators is rejected under either signing domain.
  const bothDiscriminators = (prefix: string): Case => ({ artifacts: async (session) => {
    const scope = { ...session.scopes.agreement, payeeBoundAgreementVersion: "1" };
    const raw = { ...scope, signatures: await Promise.all([BUYER, SELLER].map(async (signer) =>
      ({ party: dids[signer], algorithm: "ed25519", value: await signatureValue(prefix + artifactHash(scope, "agreement"), signer) }))) };
    session.store.set(at(2), raw);
    session.refs.agreement = refTo(at(2), raw, "agreement");
  } });
  const COVERAGE = "agreement fails listing conformance check: commitment-artifact";
  const twoPays = await (async () => {
    const scope = { ...signedScopeOf(payeeBoundListing), pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-payee-bound-agreement" },
      { kind: "pay-dem", parameters: { rail: "pay-dem" } }, { kind: "pay-dem", parameters: { rail: "pay-dem" } }] };
    return { ...scope, signature: await envelope(scope, "listing", SELLER) };
  })();
  const payee = (forListing: Obj, bindings: unknown): Case => ({
    listing: forListing,
    scopes: (scopes) => { delete scopes.agreement.agreementVersion; scopes.agreement.payeeBoundAgreementVersion = "1"; (scopes.agreement.terms as Obj).payoutBindings = bindings; },
    bundle: async (bundle, session) => {
      const tail = (forListing.pipeline as Obj[])[3];
      if (!tail) return;
      const scope = tail.kind === "pay-dem" ? { ...session.scopes.evidence, observedAt: 102 }
        : { evidenceVersion: "1", jobId: JOB, phase: tail.kind, outcome: "success", observedAt: 102 };
      bundle.phaseSummary = [...bundle.phaseSummary as Obj[], { index: 3, kind: tail.kind, outcome: "ok" }];
      bundle.settlementEvidence = [...bundle.settlementEvidence as Obj[], await publish(session, 42, scope, "evidence", SELLER)];
    },
  });
  const payout = (phaseIndex: number, railId = "pay-dem") => ({ railId, phaseIndex, payeeAddress: dids[SELLER] });
  // A delivery phase carrying a `rail` parameter is not a pay phase and needs no payout binding.
  const railedDelivery = await (async () => {
    const scope = { ...signedScopeOf(payeeBoundListing), pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-payee-bound-agreement" },
      { kind: "pay-dem", parameters: { rail: "pay-dem" } }, { kind: "deliver-attested-payload", parameters: { rail: "pay-dem" } }] };
    return { ...scope, signature: await envelope(scope, "listing", SELLER) };
  })();
  const attestation = { authority: "registry" };
  const big = "x".repeat(128 * 1024);
  assert.deepEqual(await verdicts({
    "both discriminators under the plain domain": bothDiscriminators("dacs-agreement:v1:"),
    "both discriminators under the payee-bound domain": bothDiscriminators("dacs-payee-bound-agreement:v1:"),
    "payeeBoundAgreementVersion 2": { listing: payeeBoundListing, scopes: (scopes) => {
      payee(payeeBoundListing, [payout(2)]).scopes!(scopes);
      scopes.agreement.payeeBoundAgreementVersion = "2";
    } },
    "faultBundleVersion 2": { bundle: (bundle) => { delete bundle.bundleVersion; Object.assign(bundle, { faultBundleVersion: "2", faultedParty: "none" }); } },
    "amendments as an object": { bundle: (bundle) => { bundle.amendments = {}; } },
    "a rail registry version of 0": { bundle: (bundle) => { bundle.railRegistryVersion = 0; } },
    "no buyer": { bundle: (bundle) => { bundle.parties = [{ role: "orchestrator", bundleHash: "c".repeat(64), primaryClaim: dids[BUYER] }, (bundle.parties as Obj[])[1]]; } },
    "evidence over the 128 KB cap": { scopes: (scopes) => { scopes.evidence.note = big; } },
    "a vet record signed by an external verifier": { bundle: async (bundle, session) => {
      bundle.vetRecords = [await publish(session, 30, { recordVersion: "1", jobId: JOB, evaluatedParty: dids[BUYER], bundleHash: "a".repeat(64),
        requirementHash: contentHash(listing.buyerRequirement as Obj), freshness: [], supplementary: [], dealSpecific: [], overallDecision: "pass", generatedAt: 30 }, "composite", OUTSIDER)];
    } },
    "an external signal whose attestation hash differs": { bundle: async (bundle, session) => {
      session.store.set(at(20), attestation);
      bundle.vetRecords = [await publish(session, 30, { recordVersion: "1", jobId: JOB, evaluatedParty: dids[BUYER], bundleHash: "a".repeat(64),
        requirementHash: contentHash(listing.buyerRequirement as Obj), freshness: [], dealSpecific: [], overallDecision: "pass", generatedAt: 30,
        supplementary: [{ source: "external", signalType: "rating-avg", value: 4, observedAt: 5, attestation: { anchor: { kind: "storage-program", locator: at(20) }, contentHash: "0".repeat(64) } }] }, "composite", SELLER)];
    } },
    "a phase attestationRef to the agreement": { bundle: (bundle, session) => { bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: "pay-dem", outcome: "ok", attestationRef: session.refs.agreement }]; } },
    "a phase attestationRef to a rating": { bundle: (bundle, session) => { bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: "pay-dem", outcome: "ok", attestationRef: session.refs.rating }]; } },
    "agreement roles swapped against the bundle": { scopes: (scopes) => { scopes.agreement.parties = [{ role: "buyer", primaryClaim: dids[SELLER] }, { role: "seller", primaryClaim: dids[BUYER] }]; } },
    "payouts for both pay phases": payee(twoPays, [payout(2), payout(3)]),
    "a payout for one pay phase twice": payee(twoPays, [payout(2), { ...payout(2), payeeAddress: dids[BUYER] }]),
    // PB-1: with two pay phases, one wrong (railId, phaseIndex) is enough to reject.
    "two payouts, the second on the delivery phase": payee(twoPays, [payout(2), payout(4)]),
    "two payouts, the second on another rail": payee(twoPays, [payout(2), payout(3, "pay-x402")]),
    "a rail parameter on a delivery phase": payee(railedDelivery, [payout(2)]),
  }), {
    "both discriminators under the plain domain": "agreement reference failed",
    "both discriminators under the payee-bound domain": "agreement reference failed",
    "payeeBoundAgreementVersion 2": "agreement reference failed",
    "faultBundleVersion 2": SHAPE, "amendments as an object": SHAPE, "a rail registry version of 0": SHAPE,
    "no buyer": "invalid or duplicate bundle parties",
    "evidence over the 128 KB cap": "evidence reference failed",
    "a vet record signed by an external verifier": "ok",
    "an external signal whose attestation hash differs": "supplementary attestation reference failed",
    "a phase attestationRef to the agreement": "phase attestation reference is outside the verified graph",
    "a phase attestationRef to a rating": "phase attestation reference is outside the verified graph",
    "agreement roles swapped against the bundle": "agreement party binding failed",
    "payouts for both pay phases": "ok",
    "a payout for one pay phase twice": COVERAGE,
    "two payouts, the second on the delivery phase": COVERAGE, "two payouts, the second on another rail": COVERAGE,
    "a rail parameter on a delivery phase": "ok",
  });
  // A graph that fails before its signatures verify never reports them verified.
  const shapeFailure = await evaluate({ bundle: (bundle) => { bundle.outcome = "won"; } });
  assert.equal(shapeFailure.signaturesVerified, false);
  const refFailure = await evaluate({ scopes: (scopes) => { scopes.evidence.jobId = "other-job"; } });
  assert.equal(refFailure.signaturesVerified, true);
});

test("discovery accepts an agreement only with its shape and both parties' signatures", async () => {
  const scopes = baseScopes();
  const signedBy = async (scope: Obj, signers: number[]) => ({ ...scope, signatures: await Promise.all(signers.map((signer) => envelope(scope, "agreement", signer, signer, "party"))) });
  assert.equal(await verifiedDiscoveryAgreement(await signedBy(scopes.agreement, [BUYER, SELLER])), true);
  assert.equal(await verifiedDiscoveryAgreement(await signedBy(scopes.agreement, [BUYER])), false);
  assert.equal(await verifiedDiscoveryAgreement(await signedBy({ ...scopes.agreement, parties: [] }, [BUYER, SELLER])), false);
  assert.equal(await verifiedDiscoveryAgreement({ ...(await signedBy(scopes.agreement, [BUYER, SELLER])), extra: JSON.parse("1e400") }), false);
});

test("§8.5.2 pattern: the first negotiation step names the pattern, and the RFQ fallback admits only fixed-price", () => {
  const base = baseScopes().agreement;
  const check = (agreement: Obj, pipeline: Obj[], pricing: Obj = listing.pricing as Obj) =>
    agreementListingConformance(agreement, { ...listing, pipeline, pricing }, dids[SELLER]);
  const tail = (listing.pipeline as Obj[]).slice(1);
  assert.equal(check(base, [{ kind: "vet-credentials" }, { kind: "negotiate-fixed-price" }, ...tail]), null);
  const band = { kind: "negotiable", bandCenter: { amount: "1.25", currency: "DEM" }, minPct: 10, maxPct: 10 };
  const rfq = [{ kind: "negotiate-rfq", parameters: { maxTurns: 6, timeoutSec: 60, fixedPriceFallback: true } }, ...tail];
  assert.equal(check(base, rfq, band), null);
  assert.equal(check({ ...base, derivedFromPattern: "sealed-envelope" }, rfq, band), "pattern");
});

function signedScopeOf(raw: Obj): Obj { const { signature: _, ...scope } = raw; return clone(scope); }

// The review probes are permanent regressions: signatures and hashes are valid in every case.
test("completed sessions cannot omit pipeline settle phases or substitute their kinds", async () => {
  const deliveryListing = await listingFor("commit-agreement", "deliver-attested-payload");
  const cases: Array<[Case, string]> = [
    [{ bundle: (bundle) => { bundle.phaseSummary = []; bundle.settlementEvidence = []; } }, "completed session omits a mandatory phase from the listing pipeline"],
    [{ bundle: (bundle) => { bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }]; bundle.settlementEvidence = []; } }, "completed session omits a mandatory phase from the listing pipeline"],
    [{ listing: deliveryListing }, "completed session omits a mandatory phase from the listing pipeline"],
    [{ bundle: (bundle) => { bundle.phaseSummary = [{ index: 2, kind: "pay-foo", outcome: "ok" }]; bundle.settlementEvidence = []; } }, "phase summary does not match the listing pipeline"],
    [{ bundle: (bundle) => { bundle.phaseSummary = [{ index: 0, kind: "pay-dem", outcome: "ok" }]; } }, "phase summary does not match the listing pipeline"],
  ];
  for (const [c, reason] of cases) {
    const graph = await evaluate(c);
    assert.equal(graph.ok, false);
    assert.equal(graph.reason, reason);
  }
  for (const index of [0, 1]) {
    const graph = await evaluate({ bundle: (bundle) => { bundle.phaseSummary = (bundle.phaseSummary as Obj[]).filter((phase) => phase.index !== index); } });
    assert.equal(graph.reason, "completed session omits a mandatory phase from the listing pipeline");
  }
  assert.equal((await evaluate({ listing: await listingFor("commit-agreement", "rate") })).ok, true, "rating may be declined");
  // An interrupted session can legitimately stop before reaching payment.
  assert.equal((await evaluate({ bundle: (bundle) => { bundle.outcome = "aborted-by-self"; bundle.phaseSummary = []; bundle.settlementEvidence = []; delete bundle.agreementRef; } })).ok, true);
});

test("payment finality records require observation time and the rail's own model and parameters", async () => {
  for (const finality of [{ model: "bft-final" }, { model: "bft-final", finalityObservedAt: "100" },
    ...["block-depth", "commitment-level", "provider-receipt", "htlc-reveal", "liquidity-tank"].map((model) => ({ model, finalityObservedAt: 100 }))]) {
    const graph = await evaluate({ scopes: (scopes) => { scopes.evidence.settlementFinality = finality; } });
    assert.equal(graph.reason, "evidence reference failed", JSON.stringify(finality));
  }
  for (const [phase, model] of Object.entries({ "pay-dem": "bft-final", "pay-evm-erc20": "block-depth", "pay-solana-spl": "commitment-level", "pay-ap2": "provider-receipt", "pay-cross-chain-htlc": "htlc-reveal", "pay-cross-chain-liquidity-tank": "liquidity-tank" })) {
    const raw = { phase, settlementFinality: { model, finalityObservedAt: 100, finalityBlocks: 12, finalityCommitmentLevel: "finalized" } };
    assert.equal(paymentFinalityOk(raw), true, phase);
    assert.equal(paymentFinalityOk({ ...raw, settlementFinality: { ...raw.settlementFinality, model: "other" } }), false, phase);
  }
  assert.equal(paymentFinalityOk({ phase: "pay-evm-erc20", settlementFinality: { model: "block-depth", finalityObservedAt: 100 } }), false);
  assert.equal(paymentFinalityOk({ phase: "pay-solana-spl", settlementFinality: { model: "commitment-level", finalityObservedAt: 100 } }), false);
  const x402 = { phase: "pay-x402", paymentTxRefs: [{ kind: "x402", settlementTxHash: "ab".repeat(32) }], settlementFinality: { model: "block-depth", finalityBlocks: 1, finalityObservedAt: 100 } };
  assert.equal(paymentFinalityOk(x402), true);
  assert.equal(paymentFinalityOk({ ...x402, settlementFinality: { model: "provider-receipt", finalityObservedAt: 100 } }), false);
  assert.equal(paymentFinalityOk({ ...x402, paymentTxRefs: [{ kind: "x402" }], settlementFinality: { model: "provider-receipt", finalityObservedAt: 100 } }), true);
});

test("SB-1 recovers job, encoded rail and index independently from payment anchor metadata", async () => {
  for (const name of ["opaque", `dacs4:payment:other:pay-dem:2`, `dacs4:payment:${JOB}:other:2`,
    `dacs4:payment:${JOB}:pay-dem:3`, `dacs4:payment:${JOB}:pay-dem:02`, `dacs4:payment:${JOB}:pay-dem:9007199254740992`]) {
    const graph = await evaluate({ anchorNames: { [at(3)]: name } });
    assert.equal(graph.ok, false, name);
    assert.equal(graph.reason, "payment evidence anchor binding failed", name);
  }
  const resolved = await evaluate({ anchorNames: { [at(3)]: `dacs4:payment:${JOB}:pay-dem:2:resolved` } });
  assert.equal(resolved.ok, true, resolved.reason);
  assert.equal(resolved.settlement[0].phaseIndex, 2);
});

test("payment metadata is required, hash-bound to its reread and unique per invocation", async () => {
  for (const c of [
    { noAnchorMetadata: true },
    { readAnchorRecord: async () => null },
    { readAnchorRecord: async () => ({ data: { ...baseScopes().evidence, observedAt: 999 }, programName: `dacs4:payment:${JOB}:pay-dem:2` }) },
  ] satisfies Case[]) {
    const graph = await evaluate(c);
    assert.equal(graph.reason, "payment evidence anchor binding failed");
  }
  const repeated = await evaluate({ listing: await listingFor("commit-agreement", "pay-dem"),
    anchorNames: { [at(42)]: `dacs4:payment:${JOB}:pay-dem:2` },
    bundle: async (bundle, session) => {
      bundle.phaseSummary = [{ index: 0, kind: "negotiate-fixed-price", outcome: "ok" }, { index: 1, kind: "commit-agreement", outcome: "ok" }, { index: 2, kind: "pay-dem", outcome: "ok" }, { index: 3, kind: "pay-dem", outcome: "ok" }];
      bundle.settlementEvidence = [session.refs.evidence, await publish(session, 42, { ...session.scopes.evidence, observedAt: 102 }, "evidence", SELLER)];
    },
  });
  assert.equal(repeated.reason, "payment evidence anchor binding failed");
  const scope = signedScopeOf(listing);
  (scope.pipeline as Obj[])[2] = { kind: "pay-dem", parameters: { rail: "dem:native" } };
  scope.acceptedRails = [{ railId: "dem:native" }];
  const encodedListing = { ...scope, signature: await envelope(scope, "listing", SELLER) };
  const encoded: Case = { listing: encodedListing, anchorNames: { [at(3)]: `dacs4:payment:${JOB}:dem%3Anative:2` },
    scopes: (scopes) => { (scopes.agreement.terms as Obj).rail = { railId: "dem:native" }; } };
  assert.equal((await evaluate(encoded)).ok, true);
  assert.equal((await evaluate({ ...encoded, anchorNames: { [at(3)]: `dacs4:payment:${JOB}:dem:native:2` } })).reason, "payment evidence anchor binding failed");
});

test("payment and agreement currency bounds, and failed payment refs, are independently enforced", async () => {
  for (const length of [64, 65]) {
    const currency = "C".repeat(length);
    const graph = await evaluate({ scopes: (scopes) => { scopes.evidence.paymentAmount = { amount: "1.25", currency }; } });
    assert.equal(graph.ok, length === 64, graph.reason);
    assert.deepEqual(agreementPrice({ terms: { price: { amount: "1.25", currency } } }), length === 64 ? { amount: "1.25", currency } : null);
  }
  for (const refs of [undefined, [], [{ kind: "demos", txHash: "ab".repeat(32) }]]) {
    const graph = await evaluate({ scopes: (scopes) => {
      scopes.bundle.outcome = "failed-perm";
      scopes.bundle.phaseSummary = [{ index: 2, kind: "pay-dem", outcome: "fail", errorClass: "permanent" }];
      scopes.evidence.outcome = "failure"; delete scopes.evidence.settlementFinality;
      if (refs === undefined) delete scopes.evidence.paymentTxRefs; else scopes.evidence.paymentTxRefs = refs;
    } });
    assert.equal(graph.ok, true, graph.reason);
  }
});

test("signed amendment shape failures cannot borrow valid signatures", async () => {
  const changes: Obj[] = [
    { amendmentVersion: "2" }, { jobId: 1 }, { amendsEvidenceRef: {} }, { amendsEvidenceRef: "not-a-reference" },
    { refundAmount: [] }, { refundAmount: { amount: "1", currency: 1 } }, { refundTxRefs: {} }, { reason: 1 }, { observedAt: "130" },
  ];
  for (const change of changes) {
    const graph = await evaluate({ bundle: async (bundle, session) => {
      bundle.amendments = [await publish(session, 40, { amendmentVersion: "1", jobId: JOB, amendsEvidenceRef: session.refs.evidence,
        amendmentType: "partial-refund", refundAmount: { amount: "0.25", currency: "DEM" }, reason: "late", observedAt: 130, ...change }, "amendment", SELLER)];
    } });
    assert.equal(graph.ok, false, JSON.stringify(change));
    assert.equal(graph.reason, "amendment reference failed", JSON.stringify(change));
  }
});

test("mixed-scale competing refunds choose the same exact overdraw in either arrival order", async () => {
  for (const equalTime of [false, true]) for (const reverse of [false, true]) {
    let expectedLocator = "";
    const graph = await evaluate({ bundle: async (bundle, session) => {
      const make = (amount: string, observedAt: number) => ({ amendmentVersion: "1", jobId: JOB, amendsEvidenceRef: session.refs.evidence,
        amendmentType: "partial-refund", refundAmount: { amount, currency: "DEM" }, reason: amount, observedAt });
      const scopes = [make("0.9", 130), make("0.45", equalTime ? 130 : 140)];
      const refs = await Promise.all(scopes.map((scope, index) => publish(session, 40 + index, scope, "amendment", SELLER)));
      const losing = equalTime ? (artifactHash(scopes[0], "amendment") < artifactHash(scopes[1], "amendment") ? 1 : 0) : 1;
      expectedLocator = at(40 + losing);
      bundle.amendments = reverse ? refs.reverse() : refs;
    } });
    assert.equal(graph.ok, true, graph.reason);
    assert.deepEqual(graph.flaggedAmendments, [{ locator: expectedLocator, reason: "AMEND-3: refunds exceed the settled amount" }]);
  }
  // Carry and scale in both directions, with an exact full-refund boundary.
  for (const amounts of [["0.9", "0.35"], ["0.35", "0.9"]]) {
    const graph = await evaluate({ bundle: async (bundle, session) => {
      bundle.amendments = await Promise.all(amounts.map((amount, index) => publish(session, 40 + index, {
        amendmentVersion: "1", jobId: JOB, amendsEvidenceRef: session.refs.evidence, amendmentType: "partial-refund",
        refundAmount: { amount, currency: "DEM" }, reason: "boundary", observedAt: 130 + index,
      }, "amendment", SELLER)));
    } });
    assert.equal(graph.ok, true, graph.reason); assert.deepEqual(graph.flaggedAmendments, []);
  }
});

test("nested evidence must retain its job and amendment references are audited even outside bundle.amendments", async () => {
  const alien = await evaluate({ artifacts: async (session) => {
    const prior = await publish(session, 40, { ...session.scopes.evidence, jobId: "alien" }, "evidence", SELLER);
    session.refs.evidence = await publish(session, 41, { ...session.scopes.evidence, supersedesEvidenceRef: prior }, "evidence", SELLER);
  } });
  assert.equal(alien.reason, "settlement evidence chain failed");
  const nested = await evaluate({ artifacts: async (session) => {
    const amendment = await publish(session, 40, { amendmentVersion: "1", jobId: JOB, amendsEvidenceRef: session.refs.evidence,
      amendmentType: "correction", reason: "metadata", observedAt: 130 }, "amendment", SELLER);
    session.refs.evidence = await publish(session, 41, { ...session.scopes.evidence, amendmentRefs: [amendment] }, "evidence", SELLER);
  } });
  assert.equal(nested.ok, true, nested.reason);
  assert.equal(nested.artifacts.some((artifact) => artifact.kind === "amendment" && artifact.locator === at(40)), true);
  assert.deepEqual(nested.flaggedAmendments, []);
});

test("finality block-depth boundaries and mixed x402 receipts keep the applied chain model", () => {
  const raw = { phase: "pay-evm-erc20", settlementFinality: { model: "block-depth", finalityObservedAt: 100, finalityBlocks: 1 } };
  for (const value of [0, -1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1])
    assert.equal(paymentFinalityOk({ ...raw, settlementFinality: { ...raw.settlementFinality, finalityBlocks: value } }), false);
  for (const value of [undefined, "100", NaN, Infinity])
    assert.equal(paymentFinalityOk({ ...raw, settlementFinality: { ...raw.settlementFinality, finalityObservedAt: value } }), false);
  for (const level of ["processed", "confirmed", "finalized"])
    assert.equal(paymentFinalityOk({ phase: "pay-solana-spl", settlementFinality: { model: "commitment-level", finalityObservedAt: 100, finalityCommitmentLevel: level } }), true);
  const mixed = { ...raw, phase: "pay-x402", paymentTxRefs: [{ kind: "x402" }, { kind: "x402", settlementTxHash: "ab".repeat(32) }] };
  assert.equal(paymentFinalityOk(mixed), true);
  assert.equal(paymentFinalityOk({ ...mixed, settlementFinality: { model: "provider-receipt", finalityObservedAt: 100 } }), false);
});

test("commitment-time bounds reject wrong types and include the exact listing expiry", () => {
  const agreement = baseScopes().agreement;
  const check = (listed: Obj, agreed = agreement) => agreementListingConformance(agreed, listed, dids[SELLER], 1000);
  assert.equal(check({ ...listing, validity: { notAfter: 1000 } }), null);
  assert.equal(check({ ...listing, validity: { notAfter: 999 } }), "not-expired");
  for (const notAfter of ["1000", {}, null]) assert.equal(check({ ...listing, validity: { notAfter } }), "not-expired");
  for (const window of ["1", {}, null]) assert.equal(check({ ...listing, terms: { deadlineSecAfterCommit: window } }), "deadline");
  assert.equal(check({ ...listing, terms: { deadlineSecAfterCommit: 1 } }, { ...agreement, terms: { ...agreement.terms as Obj, deadline: 2000 } }), null);
});


test("payee bindings independently validate rail and destination types and allow phase index zero", async () => {
  const valid = { railId: "pay-dem", phaseIndex: 2, payeeAddress: dids[SELLER] };
  for (const change of [{}, { railId: 1 }, { railId: "" }, { payeeAddress: 1 }, { payeeAddress: "" }]) {
    const graph = await evaluate({ listing: payeeBoundListing, scopes: (scopes) => {
      delete scopes.agreement.agreementVersion; scopes.agreement.payeeBoundAgreementVersion = "1";
      (scopes.agreement.terms as Obj).payoutBindings = [{ ...valid, ...change }];
    } });
    assert.equal(graph.ok, Object.keys(change).length === 0, graph.reason);
  }
  const agreed = baseScopes().agreement;
  delete agreed.agreementVersion; agreed.payeeBoundAgreementVersion = "1";
  (agreed.terms as Obj).payoutBindings = [{ ...valid, phaseIndex: 0 }];
  assert.equal(agreementMatchesListing(agreed, { pipeline: [{ kind: "pay-dem", parameters: { rail: "pay-dem" } }, { kind: "commit-payee-bound-agreement" }] }), true);
});

test("a malformed but correctly signed discovery agreement cannot establish seller attribution", async () => {
  const scope = { ...baseScopes().agreement, terms: { price: { amount: "1.25", currency: 1 } } };
  const signed = { ...scope, signatures: await Promise.all([BUYER, SELLER].map((signer) => envelope(scope, "agreement", signer, signer, "party"))) };
  assert.equal(await verifiedDiscoveryAgreement(signed), false);
});

test("fault counterparty attribution rejects non-string parties under valid bundle signatures", async () => {
  const graph = await evaluate({ scopes: (scopes) => {
    delete scopes.bundle.bundleVersion; Object.assign(scopes.bundle, { faultBundleVersion: "1", outcome: "failed-counterparty", faultedParty: {} });
  } });
  assert.equal(graph.ok, false);
});
