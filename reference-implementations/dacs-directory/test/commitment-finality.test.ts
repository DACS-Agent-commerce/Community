import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import "./fixtures/isolated-data-dir.js";
import { buildCurrentEvidenceGraph, artifactHash, signedScope } from "../src/catalog/evidenceGraph.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import { admitRevocationCandidates, recordWellKnownWithdrawalCheck } from "../src/catalog/store.js";
import { revocationLogicalAddress } from "../src/catalog/listingVerification.js";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed } from "@kynesyslabs/dacs/crypto";
import { dids, seeds, maps, sign, locator, vector, payeeBoundVector, bindingFor, installAgreement, registeredDeal, type Obj }
  from "./fixtures/current-evidence.js";
import { commitmentProof, fixtureCommitments, signCommitment, signReceipt } from "./fixtures/commitment-proof.js";
import type { CommitmentProof, CommitmentVerifier } from "../src/catalog/commitmentFinality.js";

const offline = async (): Promise<never> => { throw new Error("offline"); };
const seller = dids[1];
const owner = `0x${seller.slice(-64)}`;
function storage(t: TestContext) {
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const raw = maps.get(String(input).split("/").pop() ?? "");
    return raw ? Response.json({ success: true, owner, data: raw })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  });
}

async function prepared(payee = false, validity: Obj = { notBefore: 60, notAfter: 100 }) {
  const fixture = await (payee ? payeeBoundVector : vector)("proof-job", 6000);
  const scope = { ...signedScope(fixture.listing, "listing"), validity };
  fixture.listing = { ...scope, signature: await sign(scope, "listing", 1) };
  maps.set(fixture.locators.listing, fixture.listing);
  const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
  fixture.buyerBundle.listingRef = listingRef;
  fixture.sellerBundle.listingRef = listingRef;
  await installAgreement(fixture, { ...signedScope(fixture.agreement, "agreement"), listingRef });
  return fixture;
}

async function graph(fixture: Awaited<ReturnType<typeof prepared>>, proof?: CommitmentProof,
  verifier: CommitmentVerifier["verifyReceipt"] = fixtureCommitments.verifyReceipt) {
  return buildCurrentEvidenceGraph(fixture.locators.buyer, {
    read: async (at) => maps.get(at) ?? null,
    resolveListing: async () => ({ raw: fixture.listing, locator: fixture.locators.listing }),
    ...(proof ? { commitment: { resolve: async () => proof, verifyReceipt: verifier } } : {}),
  });
}

async function indexed(fixture: Awaited<ReturnType<typeof prepared>>, proof?: CommitmentProof,
  prior?: Awaited<ReturnType<typeof indexRegistration>>) {
  const jobId = String(fixture.agreement.jobId);
  return indexRegistration({ primaryClaim: seller, displayName: "seller", listingAnchors: [fixture.locators.listing],
    deals: [registeredDeal(jobId, fixture.locators.buyer, fixture.locators.seller)], bundleBindings: [
      await bindingFor(jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
      await bindingFor(jobId, "seller", fixture.locators.seller, fixture.sellerBundle, 1),
    ] }, prior, offline, undefined, undefined, undefined,
  proof ? { resolve: async () => proof, verifyReceipt: fixtureCommitments.verifyReceipt } : undefined);
}

test("Listing-bound current deals without authenticated commitment proof receive no verified references", async () => {
  const fixture = await prepared();
  const result = await graph(fixture);
  assert.equal(result.refsVerified, false);
  assert.equal(result.refsVerified, false);
  assert.match(result.reason ?? "", /commitment/);
});

test("both agreement profiles accept finalized commitments signed by the session authority", async () => {
  for (const payee of [false, true]) for (const legacy of [false, true]) {
    const fixture = await prepared(payee);
    const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, 90, legacy);
    const result = await graph(fixture, proof);
    assert.equal(result.refsVerified, true, result.reason);
  }
});

test("commitment bindings, signature authority and record discriminators fail closed", async () => {
  const changes: Array<[string, (proof: CommitmentProof) => void, boolean?]> = [
    ["another job", (p) => { p.record.jobId = "other-job"; }, true],
    ["another agreement", (p) => { p.record.agreementHash = "f".repeat(64); }, true],
    ["another Listing ID", (p) => { (p.record.listingRef as Obj).listingId = "other"; }, true],
    ["another Listing version", (p) => { (p.record.listingRef as Obj).version = 2; }, true],
    ["another Listing hash", (p) => { (p.record.listingRef as Obj).contentHash = "e".repeat(64); }, true],
    ["another party", (p) => { p.record.parties = [dids[0], dids[2]]; }, true],
    ["duplicate parties", (p) => { p.record.parties = [dids[0], dids[0], dids[1]]; }, true],
    ["another pattern", (p) => { p.record.pattern = "rfq"; }, true],
    ["untrusted signer", (p) => { p.orchestrator = dids[2]; }],
    ["bad record signature", (p) => { (p.record.signature as Obj).value = "A".repeat(86); }],
    ["noncanonical signature", (p) => { (p.record.signature as Obj).value += "="; }],
    ["dual discriminators", (p) => { p.record.dacsVersion = "1"; }, true],
    ["missing discriminator", (p) => { delete p.record.finalityCommitmentVersion; }, true],
    ["unsupported discriminator", (p) => { p.record.finalityCommitmentVersion = "2"; }, true],
    ["legacy timestamp on finality record", (p) => { p.record.committedAt = 90; }, true],
    ["legacy record without timestamp", (p) => { p.record.dacsVersion = "1"; delete p.record.finalityCommitmentVersion; delete p.record.createdAt; delete p.record.signature; }, true],
    ["oversized roster", (p) => { p.record.parties = Array(65).fill(dids[0]); }, true],
    ["oversized reply", (p) => { p.record.extra = "x".repeat(256 * 1024); }, true],
    ["deep proof", (p) => { let nested: Obj = {}; p.record.extra = nested; for (let i = 0; i < 80; i++) { const child = {}; nested.child = child; nested = child; } }],
    ["wrong signature domain", (p) => { const { signature: _signature, ...scope } = p.record;
      (p.record.signature as Obj).value = Buffer.from(ed25519Sign(Buffer.from(`dacs-commitment:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[0]))).toString("base64url");
      p.receipt.contentHash = contentHash(p.record); signReceipt(p); }],
  ];
  for (const [label, change, resign] of changes) {
    const fixture = await prepared();
    const proof = commitmentProof(fixture.agreement, structuredClone(fixture.agreement.listingRef as Obj));
    change(proof);
    if (resign) signCommitment(proof);
    assert.equal((await graph(fixture, proof)).refsVerified, false, label);
  }
});

test("receipt fields and node observations cannot substitute for authenticated finality", async () => {
  const changes: Array<[string, (proof: CommitmentProof) => void]> = [
    ["forged finality proof", (p) => { p.receipt.evidence.value = "invalid"; }],
    ["included only", (p) => { p.receipt.state = "included"; signReceipt(p); }],
    ["reorged", (p) => { p.receipt.state = "reorged"; signReceipt(p); }],
    ["indeterminate", (p) => { p.receipt.observationDisposition = "indeterminate"; signReceipt(p); }],
    ["wrong logical address", (p) => { p.receipt.logicalAddress = "dacs3:commit:other"; signReceipt(p); }],
    ["wrong native address", (p) => { p.receipt.nativeAddress = locator(7001); signReceipt(p); }],
    ["wrong content hash", (p) => { p.receipt.contentHash = "e".repeat(64); signReceipt(p); }],
    ["changed transaction", (p) => { p.receipt.transactionRef.value = "other"; }],
    ["changed writer", (p) => { p.receipt.writer = "other"; }],
    ["changed nonce", (p) => { p.receipt.nonce = "6"; }],
    ["changed network", (p) => { p.receipt.substrate = "other"; signReceipt(p); }],
    ["missing block time", (p) => { delete p.receipt.blockRef; signReceipt(p); }],
    ["fractional time", (p) => { p.receipt.blockRef = { id: "block", timestamp: 90.5 }; signReceipt(p); }],
  ];
  for (const [label, change] of changes) {
    const fixture = await prepared();
    const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj);
    change(proof);
    assert.equal((await graph(fixture, proof)).refsVerified, false, label);
  }
  const fixture = await prepared();
  const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj);
  assert.equal((await graph(fixture, proof, async () => false)).refsVerified, false);
  assert.equal((await graph(fixture, proof, async () => { throw new Error("proof timeout"); })).refsVerified, false);
});

test("commit time uses finalized consensus time and enforces both inclusive Listing bounds", async () => {
  for (const legacy of [false, true]) for (const [time, accepted] of [[59, false], [60, true], [100, true], [101, false]] as const) {
    const fixture = await prepared();
    const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, time, legacy);
    assert.equal((await graph(fixture, proof)).refsVerified, accepted, `${legacy ? "legacy" : "finality"} at ${time}`);
  }
  const fixture = await prepared();
  const backdated = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, 90, true);
  backdated.receipt.blockRef = { id: "late-block", timestamp: 101 };
  signReceipt(backdated);
  assert.equal((await graph(fixture, backdated)).refsVerified, false, "signed legacy time cannot backdate a later anchor");
  const finality = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, 101);
  assert.equal((await graph(fixture, finality)).refsVerified, false, "createdAt and finalisedAt cannot backdate finality");
});

test("commitment-relative deadline is checked against consensus time", async () => {
  const fixture = await prepared();
  const listingScope = signedScope(fixture.listing, "listing");
  listingScope.terms = { deadlineSecAfterCommit: 1 };
  fixture.listing = { ...listingScope, signature: await sign(listingScope, "listing", 1) };
  const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
  fixture.buyerBundle.listingRef = listingRef;
  fixture.sellerBundle.listingRef = listingRef;
  for (const [deadline, accepted] of [[1090, true], [1091, false]] as const) {
    await installAgreement(fixture, { ...signedScope(fixture.agreement, "agreement"), listingRef,
      terms: { ...(fixture.agreement.terms as Obj), deadline } });
    const proof = commitmentProof(fixture.agreement, listingRef);
    assert.equal((await graph(fixture, proof)).refsVerified, accepted);
  }
});

test("expired exact Listing tuples still credit authentically committed history while discovery stays empty", async (t) => {
  t.mock.method(Date, "now", () => 150);
  storage(t);
  const fixture = await prepared();
  const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj);
  const record = await indexed(fixture, proof);
  assert.deepEqual(record.listings, []);
  assert.equal(record.deals[0].refsVerified, true);
  assert.equal(record.reputation.completed, 1);
  assert.equal(record.reputation.averageSellerRating, null);
  assert.equal(record.deals[0].ratings?.[0].value, 5, "signed rating evidence is retained under TP-1");
  assert.deepEqual((record.reputation.observedTransactionalVolume ?? []).map((v) => v.amount), ["1.25"]);
  const repeated = await indexed(fixture, undefined, record);
  assert.equal(repeated.deals[0].refsVerified, false, "saved credit is never a proof");
  assert.equal(repeated.reputation.completed, 0);
});

const withdrawalMarker = (hash: string, revokedAt: number) => {
  const scope = { listingId: "svc", listingVersion: 1, listingContentHash: hash, revokedAt };
  const value = Buffer.from(ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[1]))).toString("base64url");
  return { ...scope, signature: { algorithm: "ed25519", signer: seller, value } };
};

test("a signed withdrawal anchored after a credited commitment removes no credit, whatever its revokedAt", async (t) => {
  t.mock.method(Date, "now", () => 200);
  storage(t);
  // Each case signs its own validity window, so its Listing hash and candidates are its own.
  for (const [n, revokedAt] of [[0, -1], [1, 0], [2, 1], [3, 89], [4, 90], [5, 120]] as const) {
    const fixture = await prepared(false, { notBefore: 10 + n });
    const hash = artifactHash(fixture.listing, "listing");
    const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, 89);
    assert.equal((await indexed(fixture, proof)).deals[0].refsVerified, true, `credited before revokedAt ${revokedAt}`);
    maps.set(locator(7100 + n), withdrawalMarker(hash, revokedAt));
    admitRevocationCandidates(hash, [{ locator: locator(7100 + n), owner }]);
    const record = await indexed(fixture, proof);
    assert.equal(record.listings[0]?.status, "revoked", `revokedAt ${revokedAt}`);
    assert.equal(record.deals[0].refsVerified, true, `revokedAt ${revokedAt}`);
    assert.equal(record.reputation.completed, 1);
  }
});

test("an unread owner withdrawal marker holds discovery but not authentically committed credit", async (t) => {
  t.mock.method(Date, "now", () => 300);
  storage(t);
  const fixture = await prepared(false, { notBefore: 2 });
  admitRevocationCandidates(artifactHash(fixture.listing, "listing"), [{ locator: locator(7200), owner }]);
  const record = await indexed(fixture, commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj));
  assert.deepEqual(record.listings, []);
  assert.equal(record.deals[0].refsVerified, true);
  assert.equal(record.reputation.completed, 1);
});

test("proof resolution failures keep their cause and supplied callbacks receive an abort deadline", async () => {
  const fixture = await prepared();
  for (const [label, resolve] of [
    ["missing proof", async () => null],
    ["proof lookup timed out", async () => { throw new Error("proof lookup timed out"); }],
  ] as const) {
    const result = await buildCurrentEvidenceGraph(fixture.locators.buyer, {
      read: async (at) => maps.get(at) ?? null,
      resolveListing: async () => ({ raw: fixture.listing, locator: fixture.locators.listing }),
      commitment: { resolve: async (_job, signal) => { assert.ok(signal instanceof AbortSignal); return resolve(); },
        verifyReceipt: fixtureCommitments.verifyReceipt },
    });
    assert.equal(result.refsVerified, false, label);
    assert.match(result.reason ?? "", label === "missing proof" ? /invalid record/ : /could not be processed/);
  }
});

test("a hung commitment adapter is bounded and returns a timeout cause", async (t) => {
  const { verifyListingCommitment } = await import("../src/catalog/commitmentFinality.js");
  const fixture = await prepared();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let aborted: AbortSignal | undefined;
  const { makeCommitmentContext } = await import("../src/catalog/commitmentContext.js");
  const context = makeCommitmentContext(fixture.buyerBundle, fixture.agreement, { raw: fixture.listing, locator: fixture.locators.listing }, artifactHash(fixture.agreement, "agreement"));
  assert.ok(context);
  const pending = verifyListingCommitment(context, {
    resolve: async (_job, signal) => { aborted = signal; return new Promise(() => {}); },
    verifyReceipt: fixtureCommitments.verifyReceipt,
  });
  t.mock.timers.runAll();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(aborted?.aborted, true);
  if (!result.ok) assert.match(result.reason, /timed out/);
});

test("complete additive signed commitment fields survive verification and adapter mutation cannot backdate time", async () => {
  const fixture = await prepared();
  const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj);
  proof.record.extension = { retained: "signed bytes" };
  signCommitment(proof);
  assert.equal((await graph(fixture, proof)).refsVerified, true);
  proof.record.extension = { retained: "tampered" };
  assert.equal((await graph(fixture, proof)).refsVerified, false);
  const late = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, 101);
  const result = await graph(fixture, late, async (receipt, raw, signal) => {
    assert.equal(await fixtureCommitments.verifyReceipt(receipt, raw, signal), true);
    if (receipt.blockRef) receipt.blockRef.timestamp = 90;
    return true;
  });
  assert.equal(result.refsVerified, false, "policy callback mutations cannot alter the checked snapshot");
});

test("startup clears pre-finality cached credit atomically and repeats preserve the cleared state", async (t) => {
  t.mock.method(Date, "now", () => 150);
  storage(t);
  const { spawnSync } = await import("node:child_process");
  const { default: Database } = await import("better-sqlite3");
  const { join } = await import("node:path");
  const store = await import("../src/catalog/store.js");
  const fixture = await prepared(false, { notBefore: 3 });
  const record = await indexed(fixture, commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj));
  assert.equal(record.reputation.completed, 1);
  assert.ok(record.deals[0].ratings?.length, "the authenticated fixture carries a rating");
  store.saveCatalog({ catalogVersion: "1", generatedAt: 150, sellers: [record] });
  const db = new Database(join(store.DATA_DIR, "directory.sqlite"));
  db.prepare("DELETE FROM kv_state WHERE key='commitment-finality-schema-version'").run();
  db.close();
  const restart = () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      "const s=await import('./src/catalog/store.ts'); console.log(JSON.stringify(s.loadStoredCatalog()))"],
    { encoding: "utf8", env: process.env, timeout: 30_000 });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as ReturnType<typeof store.loadCatalog>;
  };
  const cleared = restart();
  assert.deepEqual(cleared.sellers[0].deals[0].ratings, []);
  assert.equal(cleared.sellers[0].deals[0].refsVerified, false);
  assert.equal(cleared.sellers[0].deals[0].reputationEligible, false);
  assert.equal(cleared.sellers[0].reputation.completed, 0);
  assert.deepEqual(cleared.sellers[0].reputation.observedTransactionalVolume, []);
  assert.equal(cleared.sellers[0].listings[0].status, "active");
  assert.equal(cleared.sellers[0].listings[0].reputationHint, undefined);
  assert.deepEqual(restart(), cleared);
});

test("an aborted bundle without an authenticated agreement cannot bypass commitment verification", async () => {
  const fixture = await prepared();
  const scope = signedScope(fixture.buyerBundle, "bundle");
  delete scope.agreementRef;
  scope.outcome = "aborted-by-self";
  maps.set(fixture.locators.buyer, { ...scope, anchoredByRole: "buyer",
    signatures: [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)] });
  const result = await graph(fixture, commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj));
  assert.equal(result.refsVerified, false);
  assert.match(result.reason ?? "", /lifecycle/);
});

test("commitment authority may be an authenticated orchestrator outside the buyer/seller roster", async () => {
  const fixture = await prepared();
  const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, 90, false,
    { claim: dids[2], seed: seeds[2] });
  assert.equal((await graph(fixture, proof)).refsVerified, true);
});

test("commitment key resolver outages retain their original cause", async () => {
  const { verifyListingCommitment } = await import("../src/catalog/commitmentFinality.js");
  const fixture = await prepared();
  const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj);
  const { makeCommitmentContext } = await import("../src/catalog/commitmentContext.js");
  const context = makeCommitmentContext(fixture.buyerBundle, fixture.agreement, { raw: fixture.listing, locator: fixture.locators.listing }, artifactHash(fixture.agreement, "agreement"));
  assert.ok(context);
  const failure = new Error("session key service timed out", { cause: new Error("nested key transport cause") });
  const result = await verifyListingCommitment(context, { ...fixtureCommitments, resolve: async () => proof },
  async () => { throw failure; });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /could not be processed/);
    assert.equal(result.cause, failure);
    assert.match(String(failure.cause), /nested key transport cause/);
  }
});

test("an unread marker carried by an authenticated withdrawal source holds discovery but not committed credit", async (t) => {
  t.mock.method(Date, "now", () => 200);
  storage(t);
  const fixture = await prepared(false, { notBefore: 6 });
  const hash = artifactHash(fixture.listing, "listing");
  const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj);
  assert.equal((await indexed(fixture, proof)).deals[0].refsVerified, true);
  const carried = { sellerPrimaryClaim: seller, listingId: "svc", listingVersion: 1, listingContentHash: hash,
    logicalAddress: revocationLogicalAddress(seller, "svc", 1), markerAnchor: { kind: "storage-program" as const, locator: locator(7431) },
    markerContentHash: contentHash(withdrawalMarker(hash, 1)) };
  assert.ok(recordWellKnownWithdrawalCheck("https://carried.example", seller, [], [], { generatedAt: 1, hash: "c".repeat(64) }, [carried]));
  const held = await indexed(fixture, proof);
  assert.deepEqual(held.listings, [], "the unread carried marker holds discovery");
  assert.equal(held.deals[0].refsVerified, true);
  assert.equal(held.reputation.completed, 1);
});

test("an incomplete authenticated withdrawal source holds discovery but not committed credit", async (t) => {
  t.mock.method(Date, "now", () => 200);
  storage(t);
  const fixture = await prepared(false, { notBefore: 7 });
  const hash = artifactHash(fixture.listing, "listing");
  const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj);
  assert.equal((await indexed(fixture, proof)).deals[0].refsVerified, true);
  assert.ok(recordWellKnownWithdrawalCheck("https://incomplete.example", seller, [hash], [hash], { generatedAt: 1, hash: "d".repeat(64) }));
  const held = await indexed(fixture, proof);
  assert.deepEqual(held.listings, [], "the incomplete source holds discovery");
  assert.equal(held.deals[0].refsVerified, true);
  assert.equal(held.reputation.completed, 1);
});

test("typed historical contexts require complete integer validity, valid deadlines and positive durations", async () => {
  const { makeCommitmentContext } = await import("../src/catalog/commitmentContext.js");
  const f = await prepared();
  const listed = { raw: structuredClone(f.listing), locator: f.locators.listing };
  const agreementHash = artifactHash(f.agreement, "agreement");
  const context = () => makeCommitmentContext(f.buyerBundle, f.agreement, listed, agreementHash);
  for (const validity of [undefined, null, [], {}, { notAfter: 100 }, { notBefore: -1 }, { notBefore: 0.5 },
    { notBefore: Number.MAX_SAFE_INTEGER + 1 }, { notBefore: 100, notAfter: 99 }, { notBefore: 0, notAfter: -1 },
    { notBefore: 0, notAfter: 1.5 }, { notBefore: 0, notAfter: Number.MAX_SAFE_INTEGER + 1 }]) {
    listed.raw.validity = validity;
    assert.equal(context(), null, JSON.stringify(validity));
  }
  listed.raw.validity = { notBefore: 0, notAfter: 100 };
  for (const deadline of [undefined, null, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) {
    (f.agreement.terms as Obj).deadline = deadline;
    assert.equal(context(), null, String(deadline));
  }
  (f.agreement.terms as Obj).deadline = 100;
  for (const duration of [0, -1, 0.5, "1", Number.MAX_SAFE_INTEGER]) {
    listed.raw.terms = { deadlineSecAfterCommit: duration };
    assert.equal(context(), null, String(duration));
  }
  listed.raw.terms = { deadlineSecAfterCommit: 1 };
  for (const parties of [[{ role: "buyer", primaryClaim: dids[0] }, { role: "buyer", primaryClaim: dids[1] }],
    [{ role: "buyer", primaryClaim: dids[0] }, { role: "seller", primaryClaim: dids[0] }],
    [...f.agreement.parties as Obj[], { role: "seller", primaryClaim: dids[2] }]]) {
    const original = f.agreement.parties; f.agreement.parties = parties;
    assert.equal(context(), null); f.agreement.parties = original;
  }
  assert.ok(context());
});

test("resolver context mutation and arithmetic overflow cannot change the credit snapshot", async () => {
  const { makeCommitmentContext } = await import("../src/catalog/commitmentContext.js");
  const { verifyListingCommitment } = await import("../src/catalog/commitmentFinality.js");
  const f = await prepared();
  const proof = commitmentProof(f.agreement, f.agreement.listingRef as Obj, 101);
  const result = await buildCurrentEvidenceGraph(f.locators.buyer, {
    read: async at => maps.get(at) ?? null, resolveListing: async () => ({ raw: f.listing, locator: f.locators.listing }),
    commitment: { ...fixtureCommitments, resolve: async context => {
      Object.assign(context.validity, { notAfter: 200 }); Object.assign(context.listingRef, { version: 2 }); return proof;
    } },
  });
  assert.equal(result.refsVerified, false);
  f.listing.validity = { notBefore: 0 }; f.listing.terms = { deadlineSecAfterCommit: 1 };
  (f.agreement.terms as Obj).deadline = Number.MAX_SAFE_INTEGER;
  const context = makeCommitmentContext(f.buyerBundle, f.agreement, { raw: f.listing, locator: f.locators.listing }, artifactHash(f.agreement, "agreement"));
  assert.ok(context);
  const overflow = commitmentProof(f.agreement, f.agreement.listingRef as Obj, Number.MAX_SAFE_INTEGER);
  assert.equal((await verifyListingCommitment(context, { ...fixtureCommitments, resolve: async () => overflow })).ok, false);
});

test("a receipt callback ignoring cancellation is still bounded by the hard deadline", async t => {
  const { makeCommitmentContext } = await import("../src/catalog/commitmentContext.js");
  const { verifyListingCommitment } = await import("../src/catalog/commitmentFinality.js");
  const f = await prepared();
  const context = makeCommitmentContext(f.buyerBundle, f.agreement, { raw: f.listing, locator: f.locators.listing }, artifactHash(f.agreement, "agreement"));
  assert.ok(context);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered = () => {};
  const receiptEntered = new Promise<void>(resolve => { entered = resolve; });
  const pending = verifyListingCommitment(context, { resolve: async () => commitmentProof(f.agreement, f.agreement.listingRef as Obj),
    verifyReceipt: async () => { entered(); return new Promise(() => {}); } });
  await receiptEntered; t.mock.timers.runAll();
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /timed out/);
});

test("failed policy-version write rolls back all derived-credit invalidation before fresh-proof recovery", async t => {
  t.mock.method(Date, "now", () => 150); storage(t);
  const { spawnSync } = await import("node:child_process");
  const { default: Database } = await import("better-sqlite3");
  const { join } = await import("node:path");
  const store = await import("../src/catalog/store.js");
  const f = await prepared(false, { notBefore: 4 });
  const proof = commitmentProof(f.agreement, f.agreement.listingRef as Obj);
  store.saveCatalog({ catalogVersion: "1", generatedAt: 150, sellers: [await indexed(f, proof)] });
  const before = store.loadCatalog(); const scan = store.loadScanState();
  const db = new Database(join(store.DATA_DIR, "directory.sqlite"));
  db.prepare("UPDATE kv_state SET value_json='1' WHERE key='commitment-finality-schema-version'").run();
  db.exec("CREATE TRIGGER refuse_credit_version BEFORE INSERT ON kv_state WHEN new.key='commitment-finality-schema-version' BEGIN SELECT RAISE(ABORT, 'credit version refused'); END");
  const restart = () => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "await import('./src/catalog/store.ts')"],
    { encoding: "utf8", env: process.env, timeout: 30_000 });
  try {
    const failed = restart(); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /credit version refused/);
    assert.deepEqual(store.loadCatalog(), before); assert.deepEqual(store.loadScanState(), scan);
    assert.deepEqual(db.prepare("SELECT value_json FROM kv_state WHERE key='commitment-finality-schema-version'").get(), { value_json: "1" });
  } finally { db.exec("DROP TRIGGER refuse_credit_version"); db.close(); }
  assert.equal(restart().status, 0);
  assert.equal(store.loadCatalog().sellers[0].deals[0].refsVerified, false);
  assert.deepEqual(store.loadCatalog().sellers[0].deals[0].ratings, []);
  assert.equal((await indexed(f, proof)).deals[0].refsVerified, true);
});

test("expired and future discovery entries retain exact committed history without reading markers", async t => {
  t.mock.method(Date, "now", () => 150);
  for (const [notBefore, notAfter, committedAt] of [[10, 100, 90], [200, 300, 250]]) {
    const f = await prepared(false, { notBefore, notAfter });
    const marker = locator(7550 + notBefore); let markerReads = 0;
    admitRevocationCandidates(artifactHash(f.listing, "listing"), [{ locator: marker, owner }]);
    t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0]) => {
      const at = String(url).split("/").pop() ?? ""; if (at === marker) markerReads++;
      const raw = maps.get(at);
      return raw ? Response.json({ success: true, owner, data: raw }) : new Response(null, { status: 404 });
    });
    const record = await indexed(f, commitmentProof(f.agreement, f.agreement.listingRef as Obj, committedAt));
    assert.deepEqual(record.listings, []); assert.equal(record.deals[0].refsVerified, true); assert.equal(markerReads, 0);
  }
});

test("either signed withdrawal marker order and an unread-marker restart retain committed credit", async t => {
  t.mock.method(Date, "now", () => 200); storage(t);
  const { spawnSync } = await import("node:child_process");
  for (const [n, times] of [[0, [-1, 0]], [1, [0, -1]]] as const) {
    const f = await prepared(false, { notBefore: 30 + n }); const hash = artifactHash(f.listing, "listing");
    const markers = times.map((time, i) => { const at = locator(7600 + n * 2 + i); maps.set(at, withdrawalMarker(hash, time)); return { locator: at, owner }; });
    admitRevocationCandidates(hash, markers);
    const proof = commitmentProof(f.agreement, f.agreement.listingRef as Obj);
    const record = await indexed(f, proof); assert.equal(record.listings[0].status, "revoked"); assert.equal(record.deals[0].refsVerified, true);
    const registration = { primaryClaim: seller, displayName: "seller", listingAnchors: [f.locators.listing],
      deals: [registeredDeal("proof-job", f.locators.buyer, f.locators.seller)], bundleBindings: [
        await bindingFor("proof-job", "buyer", f.locators.buyer, f.buyerBundle, 0), await bindingFor("proof-job", "seller", f.locators.seller, f.sellerBundle, 1)] };
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
      import { indexRegistration } from './src/catalog/indexer.ts'; import { fixtureCommitments } from './test/fixtures/commitment-proof.ts';
      const input=JSON.parse(readFileSync(0,'utf8')); const programs=new Map(input.programs); Date.now=()=>200;
      globalThis.fetch=async url=>{ const raw=programs.get(String(url).split('/').pop()); return raw ? Response.json({success:true,owner:input.owner,data:raw}) : new Response(null,{status:404}); };
      const record=await indexRegistration(input.registration,undefined,async()=>{throw new Error('offline')},undefined,undefined,undefined,{...fixtureCommitments,resolve:async()=>input.proof});
      assert.equal(record.listings[0].status,'revoked'); assert.equal(record.deals[0].refsVerified,true);
    `], { encoding: "utf8", timeout: 30_000, env: process.env, input: JSON.stringify({ registration, proof, owner,
      programs: [...maps].filter(([at]) => !markers.some(marker => marker.locator === at)) }) });
    assert.equal(child.status, 0, child.stderr);
  }
});

for (const version of [1, 2]) test(`startup schema ${version} removes cached ratings from storage and seller API across concurrent restarts`, async t => {
  t.mock.method(Date, "now", () => 150); storage(t);
  const { spawn } = await import("node:child_process");
  const { default: Database } = await import("better-sqlite3");
  const { join } = await import("node:path");
  const store = await import("../src/catalog/store.js");
  const f = await prepared(false, { notBefore: 4 });
  const record = await indexed(f, commitmentProof(f.agreement, f.agreement.listingRef as Obj));
  assert.ok(record.deals[0].ratings?.length);
  const records = [record, { ...record, primaryClaim: dids[2] }].map(s => ({ ...s,
    deals: s.deals.map(d => ({ ...d, ratings: [...(d.ratings ?? []), ...(d.ratings ?? [])],
      ...(version === 2 ? { refsVerified: false, reputationEligible: false } : {}) })) }));
  store.saveCatalog({ catalogVersion: "1", generatedAt: 150, sellers: records });
  const db = new Database(join(store.DATA_DIR, "directory.sqlite"));
  db.prepare("UPDATE kv_state SET value_json=? WHERE key='commitment-finality-schema-version'").run(JSON.stringify(version)); db.close();
  const restart = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { NextRequest } from 'next/server';
      import * as store from './src/catalog/store.ts';
      import { GET } from './app/api/dacs/sellers/[primaryClaimRef]/route.ts';
      for (const seller of store.loadCatalog().sellers) {
        for (const deal of seller.deals) { assert.deepEqual(deal.ratings, []); assert.equal(deal.refsVerified, false); }
        assert.equal(seller.reputation.completed,0); assert.deepEqual(seller.reputation.observedTransactionalVolume,[]);
        const response = await GET(new NextRequest('https://directory.example/api/dacs/sellers/'+encodeURIComponent(seller.primaryClaim)),
          { params: Promise.resolve({ primaryClaimRef:seller.primaryClaim }) });
        assert.equal(response.status,200); for (const deal of (await response.json()).deals) assert.deepEqual(deal.ratings,[]);
      }
    `], { env: process.env });
    let error = ""; child.stderr.on("data", data => { error += data; });
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all([restart(), restart()]);
  await restart();
  assert.deepEqual(store.loadCatalog().sellers.map(s => s.registeredAt), records.map(s => s.registeredAt));
  assert.deepEqual(store.loadCatalog().sellers.map(s => s.deals.map(d => d.buyerBundleRef)), records.map(s => s.deals.map(d => d.buyerBundleRef)));
  const check = new Database(join(store.DATA_DIR, "directory.sqlite"), { readonly: true });
  try { assert.deepEqual(check.prepare("SELECT value_json FROM kv_state WHERE key='commitment-finality-schema-version'").get(), { value_json: "3" }); }
  finally { check.close(); }
});
