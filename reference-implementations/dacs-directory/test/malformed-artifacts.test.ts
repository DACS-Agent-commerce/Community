import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import type { BundleBinding, Registration, RegisteredDeal } from "../src/catalog/types.js";

// Regression vectors from the round-2 review probes: real SDK hashes and
// signatures, and one malformed artifact per scenario followed by valid work.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-malformed-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DACS_SCAN_FINALITY_DEPTH = "0";
const store = await import("../src/catalog/store.js");
const { scanChain } = await import("../src/catalog/scan.js");
const { verifyListing } = await import("../src/catalog/listingVerification.js");
const { logicalBundleAddress, verifyBundleBinding } = await import("../src/catalog/bundleBinding.js");
const { artifactHash, buildCurrentEvidenceGraph } = await import("../src/catalog/evidenceGraph.js");
const { deriveIdentityTier } = await import("../src/catalog/identityVerification.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");

type Obj = Record<string, unknown>;
type ArtifactKind = Parameters<typeof artifactHash>[1];
const seeds = [21, 22].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const dids = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const [buyer, seller] = dids;
const ownerOf = (did: string) => `0x${did.slice(-64)}`;
const outsider = `did:demos:agent:${"d".repeat(64)}`;
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const offline = async (): Promise<never> => { throw new Error("identity unavailable"); };

const PREFIXES: Record<string, string> = {
  listing: "dacs-listing:v1:", agreement: "dacs-agreement:v1:", evidence: "dacs-evidence:v1:",
  bundle: "dacs-bundle:v1:", "verify-result": "dacs-verifyresult:v1:",
};
const signature = async (hash: string, prefix: string, signer: number, encoding: "hex" | "base64url" = "hex") =>
  Buffer.from(await ed25519Sign(Buffer.from(prefix + hash), privateKeyFromSeed(seeds[signer]))).toString(encoding);
const signArtifact = async (raw: Obj, kind: ArtifactKind, signer: number, party = false) => {
  const value = await signature(artifactHash(raw, kind), PREFIXES[kind], signer);
  return party ? { party: dids[signer], algorithm: "ed25519", value } : { signer: dids[signer], algorithm: "ed25519", value };
};
const ref = (at: string, raw: Obj, kind: ArtifactKind, extra: Obj = {}) => ({
  anchor: { kind: "storage-program", locator: at }, contentHash: artifactHash(raw, kind), ...extra,
});

// SDK-profile listing, revocation marker and BundleBinding signed by the seller.
const listingScope = {
  listingId: "svc", listingVersion: 1, agentId: seller, serviceId: "svc", name: "Service", description: "Description",
  claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"],
  supportedDelivery: ["deliver-attested-payload"],
};
const listing = { ...listingScope, signature: { algorithm: "ed25519", signer: seller, value: await signature(contentHash(listingScope), PREFIXES.listing, 1) } };
const verifiedListing = await verifyListing(listing);
assert.ok(verifiedListing);
const markerScope = { listingId: "svc", listingVersion: 1, listingContentHash: verifiedListing.contentHash, revokedAt: 1 };
const marker = { ...markerScope, signature: { algorithm: "ed25519", signer: seller, value: await signature(contentHash(markerScope), "dacs-revocation:v1:", 1) } };
async function signedBinding(jobId: string, role: "buyer" | "seller", nativeAddress: string, bundleContentHash: string, signer: number) {
  const scope = {
    bindingVersion: "1" as const, jobId, role, logicalAddress: logicalBundleAddress(jobId, role),
    nativeAddress, bundleContentHash, signer: dids[signer],
  };
  const value = await signature(contentHash(scope), "dacs-bundle-binding:v1:", signer, "base64url");
  return { ...scope, signature: { algorithm: "ed25519", signer: dids[signer], value } } as BundleBinding;
}
const binding = await signedBinding("job", "buyer", locator(10), "c".repeat(64), 0);

// Raw JSON text is built without JSON.stringify so deep values never touch the test's own stack.
// `deepText` cannot be serialized at all; `canonDeepText` still serializes (so it survives the
// registration store) but has no canonical form because canonicalization recurses further.
const nested = (depth: number) => "[".repeat(depth) + "0" + "]".repeat(depth);
const deepText = nested(20_000);
const canonDeepText = nested(3_000);
/** Append `"futureField": <value>` as the last top-level member. */
const withMember = (value: unknown, member: string) => JSON.stringify(value).replace(/}$/, `,"futureField":${member}}`);
/** Append `"futureField": <value>` inside the trailing `signature` object, outside the signed scope. */
const withSignatureMember = (value: unknown, member: string) => JSON.stringify(value).replace(/}}$/, `,"futureField":${member}}}`);

// Stubbed node: `storage` maps locator → raw `data` JSON text (plus optional name/owner).
interface StoredProgram { data: string; name?: string; owner?: unknown }
let storage: Record<string, StoredProgram> = {};
let transactions: Obj[] = [];
let reads = new Map<string, number>();
let reread: ((at: string, count: number) => string | undefined) | undefined;
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path.startsWith("/storage-program/")) {
    const at = path.slice("/storage-program/".length);
    const entry = storage[at];
    if (!entry) return new Response(null, { status: 404 });
    const count = (reads.get(at) ?? 0) + 1;
    reads.set(at, count);
    const owner = JSON.stringify(entry.owner ?? ownerOf(seller));
    return new Response(
      `{"success":true,"owner":${owner},"programName":${JSON.stringify(entry.name ?? "opaque")},"data":${reread?.(at, count) ?? entry.data}}`,
      { headers: { "content-type": "application/json" } },
    );
  }
  const call = JSON.parse(String(init?.body)).params?.[0];
  return Response.json({ result: 200, response: call?.message === "getTransactions" && call.data?.start === "latest" ? transactions : [] });
};
function chain(programs: Record<string, StoredProgram>, referenced: string[] = []) {
  storage = programs;
  reads = new Map();
  reread = undefined;
  // One memo transaction per locator, newest first, as the node returns them.
  transactions = referenced.map((at, index) => {
    const id = referenced.length - index;
    return { id, status: "confirmed", type: "transfer", hash: id.toString(16).padStart(64, "0"), blockNumber: id, to: "0x1", content: JSON.stringify({ memo: at }) };
  });
}
const scan = () => scanChain(null, { maxTxs: 100, sinceTxId: 0 });
function resetIndex(registrations: Registration[], generatedAt: number) {
  store.saveRegistrations(registrations);
  store.saveCatalog({ catalogVersion: "1", generatedAt, sellers: [] });
  store.saveScanState({
    schemaVersion: 8, lastSeenTxId: 0, listings: {}, deals: {}, programs: {}, revocations: {},
    verifiedRevocations: {}, bundleBindings: {}, bundleBindingOverflow: [], anchorBackfillComplete: true,
  });
}
const artifactRow = (at: string) => {
  const db = new Database(join(dataDirectory, "directory.sqlite"), { readonly: true });
  try {
    return db.prepare("SELECT kind,content_hash,anchor_time,data_json,status FROM artifacts WHERE locator = ?").get(at) as
      { kind: string; content_hash: string | null; anchor_time: number | null; data_json: string | null; status: string } | undefined;
  } finally {
    db.close();
  }
};

test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

test("reindex records a deeply nested rejected artifact as bounded metadata and indexes a later revocation", async () => {
  assert.throws(() => JSON.stringify(JSON.parse(deepText)), RangeError);
  const deepMarker = locator(1);
  const validMarker = locator(2);
  const listingAnchor = locator(3);
  chain({
    [deepMarker]: { data: withMember(marker, deepText) },
    [validMarker]: { data: JSON.stringify(marker) },
    [listingAnchor]: { data: JSON.stringify(listing) },
  }, [deepMarker, validMarker, listingAnchor]);
  resetIndex([{ primaryClaim: seller, displayName: "Seller", listingAnchors: [listingAnchor] }], 42);

  await reindexAll({ log: () => {}, resolveIdentities: offline });

  const catalog = store.loadCatalog();
  assert.ok(catalog.generatedAt > 42);
  const [indexed] = catalog.sellers[0].listings;
  assert.equal(indexed.status, "revoked");
  assert.equal(indexed.revocationBinding?.markerAnchor.locator, validMarker);
  assert.deepEqual(store.loadScanState().revocations?.[verifiedListing.contentHash], [validMarker]);
  assert.deepEqual(artifactRow(deepMarker), { kind: "other", content_hash: null, anchor_time: null, data_json: null, status: "retry" });
  assert.ok(store.loadRetryableArtifacts(Date.now() + 4_000_000).includes(deepMarker));
  assert.equal(artifactRow(validMarker)?.content_hash, contentHash(marker));
});

test("BundleBinding verification returns null for malformed fields inside and outside the signed scope", async () => {
  const valid = await verifyBundleBinding(binding);
  assert.ok(valid);
  for (const malformed of [
    withMember(binding, "1e400"),
    withMember(binding, canonDeepText),
    withMember(binding, deepText),
    withSignatureMember(binding, deepText),
  ]) {
    assert.equal(await verifyBundleBinding(JSON.parse(malformed)), null);
  }
});

test("scan rejects malformed artifacts without keeping their data and continues with a valid marker", async () => {
  const deepBindingEnvelope = locator(11);
  const infiniteBinding = locator(12);
  const deepMarkerEnvelope = locator(13);
  const validMarker = locator(14);
  chain({
    [deepBindingEnvelope]: { data: withSignatureMember(binding, deepText) },
    [infiniteBinding]: { data: withMember(binding, "1e400") },
    [deepMarkerEnvelope]: { data: withSignatureMember(marker, deepText) },
    [validMarker]: { data: JSON.stringify(marker) },
  }, [deepBindingEnvelope, infiniteBinding, deepMarkerEnvelope, validMarker]);

  const result = await scan();

  assert.equal(result.complete, true);
  const observed = new Map(result.observations.map((observation) => [observation.locator, observation]));
  for (const rejected of [deepBindingEnvelope, infiniteBinding, deepMarkerEnvelope]) {
    assert.equal(observed.get(rejected)?.kind, "other");
    assert.equal(observed.get(rejected)?.contentHash, undefined);
    assert.equal(observed.get(rejected)?.data, undefined);
    assert.ok(result.failures.some((failure) => failure.locator === rejected && failure.code === "ARTIFACT_REJECTED"));
  }
  assert.equal(observed.get(validMarker)?.kind, "listing-revocation");
  assert.equal(observed.get(validMarker)?.contentHash, contentHash(marker));
  assert.deepEqual(result.revocations.get(verifiedListing.contentHash), [validMarker]);
  assert.equal(result.bundleBindings.size, 0);
});

test("scan requires an object payload and string metadata from every storage read", async () => {
  const numeric = locator(21);
  const text = locator(22);
  const list = locator(23);
  const numericOwner = locator(24);
  const validMarker = locator(25);
  chain({
    [numeric]: { data: "7", name: "dacs1:listing:numeric" },
    [text]: { data: '"listing"', name: "dacs1:listing:text" },
    [list]: { data: "[]", name: "dacs1:listing:list" },
    [numericOwner]: { data: JSON.stringify(listing), name: "dacs1:listing:owner", owner: 7 },
    [validMarker]: { data: JSON.stringify(marker) },
  }, [numeric, text, list, numericOwner, validMarker]);

  const result = await scan();

  assert.equal(result.complete, true);
  assert.equal(result.listings.size, 0);
  for (const invalid of [numeric, text, list, numericOwner]) {
    assert.equal(result.observations.some((observation) => observation.locator === invalid), false);
    assert.ok(result.failures.some((failure) => failure.locator === invalid && failure.code === "STORAGE_INVALID_RESPONSE"));
  }
  assert.deepEqual(result.revocations.get(verifiedListing.contentHash), [validMarker]);
});

test("a rejected re-observation replaces the locator's content identity and its anchor time", async () => {
  const reused = locator(31);
  const first = { value: "first" };
  store.recordArtifact({ locator: reused, kind: "bundle", profile: "dacs-v0.1", contentHash: contentHash(first),
    observedAt: 1, anchorTime: 123_000, data: first });
  assert.equal(store.artifactAnchorTime(reused), 123_000);

  chain({ [reused]: { data: withMember(marker, "1e400") } }, [reused]);
  const rejected = (await scan()).observations.find((observation) => observation.locator === reused);
  assert.ok(rejected);
  store.recordArtifact(rejected);
  assert.deepEqual(artifactRow(reused), { kind: "other", content_hash: null, anchor_time: null, data_json: null, status: "observed" });
  assert.equal(store.artifactAnchorTime(reused), undefined);

  const second = { value: "second" };
  store.recordArtifact({ locator: reused, kind: "bundle", profile: "dacs-v0.1", contentHash: contentHash(second), observedAt: 3, data: second });
  assert.equal(artifactRow(reused)?.content_hash, contentHash(second));
  assert.equal(store.artifactAnchorTime(reused), undefined, "valid content cannot inherit a time from before the rejection");

  // Direct store callers: data is persisted only together with the hash that identifies it.
  store.recordArtifact({ locator: reused, kind: "other", profile: "dacs-v0.1", observedAt: 4, data: { futureField: null } });
  assert.equal(artifactRow(reused)?.content_hash, null);
  assert.equal(artifactRow(reused)?.data_json, null);
  store.recordArtifact({ locator: reused, kind: "bundle", profile: "dacs-v0.1", contentHash: contentHash(first),
    observedAt: 5, anchorTime: 456_000, data: JSON.parse(withMember(first, deepText)) });
  assert.deepEqual(artifactRow(reused), { kind: "bundle", content_hash: null, anchor_time: null, data_json: null, status: "observed" });
});

test("an unhashable program never shadows a valid agreement or supplies deal attribution", async () => {
  const bundle = locator(41);
  const agreement = locator(42);
  const otherAgreement = locator(43);
  const unhashable = locator(44);
  const name = "dacs3:agreement:job-attribution";
  const buyerBundle = { data: JSON.stringify({ bundleVersion: "1", jobId: "job-attribution", parties: [], anchoredByRole: "buyer" }), owner: ownerOf(buyer) };
  const scope = { agreementVersion: "1", jobId: "job-attribution", listingRef: { listingId: "svc", version: 1, contentHash: verifiedListing.contentHash },
    parties: [{ role: "buyer", primaryClaim: buyer }, { role: "seller", primaryClaim: seller }],
    terms: { price: { amount: "1.25", currency: "DEM" }, rail: { railId: "pay-dem" } } };
  const validAgreement = { ...scope, signatures: [await signArtifact(scope, "agreement", 0, true), await signArtifact(scope, "agreement", 1, true)] };
  const program = (sellerClaim: string, member?: string) => {
    const raw = sellerClaim === seller ? validAgreement : { seller: sellerClaim };
    return { data: member ? withMember(raw, member) : JSON.stringify(raw), name, owner: ownerOf(buyer) };
  };
  const key = store.programBindingKey(ownerOf(buyer), name);

  chain({ [bundle]: buyerBundle, [agreement]: program(seller), [unhashable]: program(outsider, "1e400") }, [bundle, agreement, unhashable]);
  let result = await scan();
  assert.equal(result.programs.get(key), agreement);
  assert.equal(result.deals.get("job-attribution")?.owners.seller, seller);

  // Competing owner/name programs remain indeterminate whatever the read order.
  for (const order of [[bundle, agreement, otherAgreement], [bundle, otherAgreement, agreement]]) {
    chain({ [bundle]: buyerBundle, [agreement]: program(seller), [otherAgreement]: program(outsider) }, order);
    result = await scan();
    assert.equal(result.programs.get(key), null);
    assert.equal(result.deals.get("job-attribution")?.owners.seller, "");
  }

  // The deal loop rereads the agreement; unhashable data on that read is rejected too.
  chain({ [bundle]: buyerBundle, [agreement]: program(seller) }, [bundle, agreement]);
  reread = (at, count) => at === agreement && count > 1 ? withMember({ seller: outsider }, "1e400") : undefined;
  result = await scan();
  assert.equal(result.programs.get(key), agreement);
  assert.equal(result.deals.get("job-attribution")?.sellerFromAgreement, undefined);
  assert.equal(result.deals.get("job-attribution")?.owners.seller, "");

  // A canonical agreement whose parties are not objects attributes nothing and stops nothing.
  chain({ [bundle]: buyerBundle, [agreement]: { data: JSON.stringify({ parties: [null, 7] }), name, owner: ownerOf(buyer) } }, [bundle, agreement]);
  result = await scan();
  assert.equal(result.complete, true);
  assert.equal(result.deals.get("job-attribution")?.owners.seller, "");
});

test("current evidence graph fails closed on malformed bundles without hashing them again", async () => {
  const bundleScope: Obj = {
    bundleVersion: "1", jobId: "job-graph", outcome: "completed", listingRef: { listingId: "svc", version: 1, contentHash: "a".repeat(64) },
    parties: [{ role: "buyer", bundleHash: "a".repeat(64), primaryClaim: buyer }, { role: "seller", bundleHash: "b".repeat(64), primaryClaim: seller }],
    phaseSummary: [], vetRecords: [], settlementEvidence: [], recipeRegistryVersion: 1, railRegistryVersion: 1, finalisedAt: 1,
  };
  const signed = { ...bundleScope, signatures: [await signArtifact(bundleScope, "bundle", 0, true), await signArtifact(bundleScope, "bundle", 1, true)], anchoredByRole: "buyer" };
  const at = locator(51);
  for (const malformed of [
    withMember(signed, "1e400"),
    withMember(signed, deepText),
    JSON.stringify(signed).replace('"signatures":[{', `"signatures":[{"futureField":${deepText},`),
    JSON.stringify(signed).replace('"outcome":"completed"', '"outcome":{"toString":1}'),
  ]) {
    const graph = await buildCurrentEvidenceGraph(at, {
      read: async () => JSON.parse(malformed),
      resolveListing: async () => null,
    });
    assert.equal(graph.ok, false);
    assert.equal(graph.bundleContentHash, "");
    assert.equal(graph.bundle.bundleVersion, "1", "a failed current bundle keeps its profile discriminator");
  }
});

// Current-profile deal: listing, agreement, evidence and both bundle copies with BundleBindings.
async function currentDeal(jobId: string, offset: number, paymentTxRefs: unknown[] = [`tx-${jobId}`]) {
  const at = (n: number) => locator(offset + n);
  const listingRaw: Obj = {
    dacsVersion: "1", listingVersion: 1, listingId: "svc-current", requiredCapabilities: ["SR-2"],
    seller: { identity: { bundleVersion: "1", presentedBy: seller, presentedAt: 1, claims: [{ ref: seller }], presentation: { kind: "per-claim", signatures: [] } }, displayName: "seller" },
    offering: { title: "test", description: "test service", category: "services.test", tags: [], deliverable: { kind: "attested-payload", payloadFormat: "application/json" } },
    buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "pay-dem", parameters: { rail: "pay-dem" } }, { kind: "deliver-attested-payload" }],
    pricing: { kind: "fixed", price: { amount: "1.25", currency: "DEM", unit: "job" } }, acceptedRails: [{ railId: "pay-dem" }], terms: {}, validity: { notBefore: 1 },
  };
  const identity = (listingRaw.seller as Obj).identity as Obj;
  const identityScope = { ...identity };
  delete identityScope.presentation;
  (identity.presentation as Obj).signatures = [{ ref: seller, signature: await signature(contentHash(identityScope), "dacs-bundle-presentation:v1:", 1) }];
  const currentListing = { ...listingRaw, signature: await signArtifact(listingRaw, "listing", 1) };
  const listingRef = { listingId: "svc-current", version: 1, contentHash: artifactHash(currentListing, "listing") };
  const agreementScope: Obj = {
    agreementVersion: "1", jobId, listingRef, parties: [{ role: "buyer", primaryClaim: buyer }, { role: "seller", primaryClaim: seller }],
    terms: { price: { amount: "1.25", currency: "DEM" }, rail: { railId: "pay-dem" } },
  };
  const agreement = { ...agreementScope, signatures: [await signArtifact(agreementScope, "agreement", 0, true), await signArtifact(agreementScope, "agreement", 1, true)] };
  const evidenceScope: Obj = { evidenceVersion: "1", jobId, phase: "pay-dem", phaseIndex: 2, outcome: "success", paymentTxRefs, observedAt: 100 };
  const evidence = { ...evidenceScope, signature: await signArtifact(evidenceScope, "evidence", 1) };
  const bundleScope: Obj = {
    bundleVersion: "1", jobId, outcome: "completed", listingRef, agreementRef: ref(at(2), agreement, "agreement"),
    parties: [{ role: "buyer", bundleHash: "a".repeat(64), primaryClaim: buyer }, { role: "seller", bundleHash: "b".repeat(64), primaryClaim: seller }],
    phaseSummary: [{ index: 2, kind: "settle", outcome: "ok" }], vetRecords: [], settlementEvidence: [ref(at(3), evidence, "evidence")],
    recipeRegistryVersion: 1, railRegistryVersion: 1, finalisedAt: 120,
  };
  const signatures = [await signArtifact(bundleScope, "bundle", 0, true), await signArtifact(bundleScope, "bundle", 1, true)];
  const buyerCopy = { ...bundleScope, signatures, anchoredByRole: "buyer" };
  const sellerCopy = { ...bundleScope, signatures, anchoredByRole: "seller" };
  return {
    listingAnchor: at(1),
    programs: {
      [at(1)]: { data: JSON.stringify(currentListing) }, [at(2)]: { data: JSON.stringify(agreement) },
      [at(3)]: { data: JSON.stringify(evidence) }, [at(5)]: { data: JSON.stringify(buyerCopy) }, [at(6)]: { data: JSON.stringify(sellerCopy) },
    },
    deal: { jobId, rail: "pay-dem", buyerBundleRef: at(5), sellerBundleRef: at(6), owners: { buyer, seller } } as RegisteredDeal,
    bindings: [
      await signedBinding(jobId, "buyer", at(5), artifactHash(buyerCopy, "bundle"), 0),
      await signedBinding(jobId, "seller", at(6), artifactHash(sellerCopy, "bundle"), 1),
    ],
  };
}

test("malformed bundles and a deal that cannot be summarized stay unverified while a later deal verifies", async () => {
  // Signed evidence whose transaction id converts to no primitive: the graph verifies, the deal summary throws.
  const poisoned = await currentDeal("job-poisoned", 100, [{ txId: { toString: 1 } }]);
  const valid = await currentDeal("job-valid", 200);
  const legacyBundle = locator(61);
  const currentBundle = locator(62);
  const currentBinding = await signedBinding("job-current-malformed", "buyer", currentBundle, "c".repeat(64), 0);
  chain({
    ...poisoned.programs,
    ...valid.programs,
    [legacyBundle]: { data: '{"futureField":1e400}' },
    [currentBundle]: { data: withMember({ bundleVersion: "1", jobId: "job-current-malformed", parties: [], anchoredByRole: "buyer", signatures: [] }, "1e400") },
  });
  const legacyDeal: RegisteredDeal = { jobId: "job-legacy-malformed", rail: "pay-dem", buyerBundleRef: legacyBundle, owners: { buyer, seller } };
  const currentMalformedDeal: RegisteredDeal = { jobId: "job-current-malformed", rail: "pay-dem", buyerBundleRef: currentBundle, owners: { buyer, seller } };

  const registration = {
    primaryClaim: seller,
    displayName: "Seller",
    listingAnchors: [valid.listingAnchor],
    deals: [legacyDeal, currentMalformedDeal, poisoned.deal, valid.deal],
    bundleBindings: [currentBinding, ...poisoned.bindings, ...valid.bindings],
  };
  const record = await indexRegistration(registration, undefined, offline);

  const byJob = new Map(record.deals.map((deal) => [deal.jobId, deal]));
  for (const jobId of ["job-legacy-malformed", "job-current-malformed", "job-poisoned"]) {
    assert.equal(byJob.get(jobId)?.signatureVerified, false, jobId);
    assert.equal(byJob.get(jobId)?.refsVerified, false, jobId);
    assert.equal(byJob.get(jobId)?.reputationEligible, false, jobId);
    assert.equal(byJob.get(jobId)?.bundleContentHash, undefined, jobId);
  }
  // The legacy verifier itself returns the unverified record; it is not the per-deal fallback.
  assert.equal(byJob.get("job-legacy-malformed")?.cancellationNeutral, false);
  assert.equal(byJob.get("job-valid")?.refsVerified, true);
  assert.equal(record.reputation.bundleCount, 1);
  resetIndex([registration], 45);
  await reindexAll({ log: () => {}, resolveIdentities: offline });
  const db = new Database(join(dataDirectory, "directory.sqlite"), { readonly: true });
  try {
    const run = db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").get() as { omitted_deals: number };
    assert.equal(run.omitted_deals, 1, "the failed summary is counted in operator diagnostics");
  } finally { db.close(); }
});

test("identity tier skips claims whose verification artifacts have no canonical form", async () => {
  const objects: Record<string, string> = {};
  const read = async (at: string) => objects[at] ? JSON.parse(objects[at]) as Obj : null;
  const resultFor = async (attestation: string, attestationHash: string) => {
    const scope: Obj = {
      resultVersion: "1", scheme: "lei", identifier: "123", recipeVersion: 2, method: "consensus-backed-proxy", decision: "pass",
      attestation: { anchor: { kind: "storage-program", locator: attestation }, contentHash: attestationHash }, verifiedAt: 20, validUntil: 200,
    };
    return { ...scope, signature: await signArtifact(scope, "verify-result", 0) };
  };
  const attested = { authority: "ok" };
  objects[locator(71)] = JSON.stringify(attested);
  objects[locator(72)] = withMember(attested, "1e400");
  const valid = await resultFor(locator(71), contentHash(attested));
  const malformedAttestation = await resultFor(locator(72), "e".repeat(64));
  objects[locator(73)] = JSON.stringify(valid);
  objects[locator(74)] = JSON.stringify(malformedAttestation);
  objects[locator(75)] = withMember(valid, "1e400");
  const claim = (at: string, raw: Obj) => ({ ref: "lei:123", verifiedBy: ref(at, raw, "verify-result", { recipeVersion: 2 }) });
  const unhashableResult = { ref: "lei:123", verifiedBy: { anchor: { kind: "storage-program", locator: locator(75) }, contentHash: "f".repeat(64), recipeVersion: 2 } };
  const policy = { scheme: "lei", recipeVersion: 2, methods: ["consensus-backed-proxy"], defaultMaxAgeSec: 60, availability: "live" as const, trustedResultSigners: [buyer] };

  const malformedOnly = { claims: [unhashableResult, claim(locator(74), malformedAttestation)] };
  assert.equal(await deriveIdentityTier(malformedOnly, async () => policy, 100, read), "self-declared");
  const withValid = { claims: [unhashableResult, claim(locator(74), malformedAttestation), claim(locator(73), valid)] };
  assert.equal(await deriveIdentityTier(withValid, async () => policy, 100, read), "institutional");
});

test("reindex drops malformed carried bindings and still indexes every later seller", async () => {
  const listingAnchor = locator(81);
  chain({ [listingAnchor]: { data: JSON.stringify(listing) } }, [listingAnchor]);
  const carried = JSON.parse(withMember(binding, canonDeepText)) as BundleBinding;
  assert.doesNotThrow(() => JSON.stringify(carried));
  assert.throws(() => contentHash(carried), RangeError);
  resetIndex([
    { primaryClaim: buyer, displayName: "Carrier", listingAnchors: [], bundleBindings: [carried, binding] },
    { primaryClaim: seller, displayName: "Seller", listingAnchors: [listingAnchor] },
  ], 43);

  await reindexAll({ log: () => {}, resolveIdentities: offline });

  const catalog = store.loadCatalog();
  assert.ok(catalog.generatedAt > 43);
  assert.deepEqual(catalog.sellers.map((record) => record.displayName), ["Carrier", "Seller"]);
  assert.equal(catalog.sellers[1].listings[0].anchor.locator, listingAnchor);
  assert.deepEqual(store.loadScanState().bundleBindings?.job?.map((verified) => contentHash(verified)), [contentHash(binding)]);
});

test("a seller whose record cannot be indexed is logged and omitted while later sellers are indexed", async () => {
  const listingAnchor = locator(91);
  chain({ [listingAnchor]: { data: JSON.stringify(listing) } }, [listingAnchor]);
  // Legacy or hand-edited registration JSON is untrusted carriage too.
  const broken = { primaryClaim: buyer, displayName: "Broken", listingAnchors: null } as unknown as Registration;
  resetIndex([broken, { primaryClaim: seller, displayName: "Seller", listingAnchors: [listingAnchor] }], 44);
  const lines: string[] = [];

  await reindexAll({ log: (line) => lines.push(line), resolveIdentities: offline });

  const catalog = store.loadCatalog();
  assert.ok(catalog.generatedAt > 44);
  assert.deepEqual(catalog.sellers.map((record) => record.displayName), ["Seller"]);
  assert.equal(catalog.sellers[0].listings[0].anchor.locator, listingAnchor);
  assert.ok(lines.some((line) => line.includes("seller indexing failed") && line.includes(buyer.slice(0, 24))));
});
