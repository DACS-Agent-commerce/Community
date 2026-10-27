import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import "./fixtures/isolated-data-dir.js";
import { buildCurrentEvidenceGraph, artifactHash, signedScope } from "../src/catalog/evidenceGraph.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import { admitRevocationCandidates, recordWellKnownWithdrawalCheck, retainedListingRevocationMarker } from "../src/catalog/store.js";
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
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /commitment/);
});

test("both agreement profiles accept finalized commitments signed by the session authority", async () => {
  for (const payee of [false, true]) for (const legacy of [false, true]) {
    const fixture = await prepared(payee);
    const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, 90, legacy);
    const result = await graph(fixture, proof);
    assert.equal(result.ok, true, result.reason);
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
    ["oversized roster", (p) => { p.record.parties = Array(65).fill(dids[0]); }, true],
    ["oversized reply", (p) => { p.record.extra = "x".repeat(256 * 1024); }, true],
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
    assert.equal((await graph(fixture, proof)).ok, false, label);
  }
  const fixture = await prepared();
  const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj);
  assert.equal((await graph(fixture, proof, async () => false)).ok, false);
  assert.equal((await graph(fixture, proof, async () => { throw new Error("proof timeout"); })).ok, false);
});

test("commit time uses finalized consensus time and enforces both inclusive Listing bounds", async () => {
  for (const legacy of [false, true]) for (const [time, accepted] of [[59, false], [60, true], [100, true], [101, false]] as const) {
    const fixture = await prepared();
    const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, time, legacy);
    assert.equal((await graph(fixture, proof)).ok, accepted, `${legacy ? "legacy" : "finality"} at ${time}`);
  }
  const fixture = await prepared();
  const backdated = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, 90, true);
  backdated.receipt.blockRef = { id: "late-block", timestamp: 101 };
  signReceipt(backdated);
  assert.equal((await graph(fixture, backdated)).ok, false, "signed legacy time cannot backdate a later anchor");
  const finality = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, 101);
  assert.equal((await graph(fixture, finality)).ok, false, "createdAt and finalisedAt cannot backdate finality");
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
    assert.equal((await graph(fixture, proof)).ok, accepted);
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
  assert.equal(record.reputation.averageSellerRating, 5);
  assert.deepEqual((record.reputation.observedTransactionalVolume ?? []).map((v) => v.amount), ["1.25"]);
  const repeated = await indexed(fixture, undefined, record);
  assert.equal(repeated.deals[0].refsVerified, false, "saved credit is never a proof");
  assert.equal(repeated.reputation.completed, 0);
});

test("withdrawn Listing history requires strictly pre-withdrawal commitment finality", async (t) => {
  t.mock.method(Date, "now", () => 200);
  storage(t);
  for (const [time, accepted] of [[89, true], [90, false], [91, false]] as const) {
    const fixture = await prepared(false, { notBefore: 1 });
    const hash = artifactHash(fixture.listing, "listing");
    const scope = { listingId: "svc", listingVersion: 1, listingContentHash: hash, revokedAt: 90 };
    const value = Buffer.from(ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[1]))).toString("base64url");
    maps.set(locator(7100), { ...scope, signature: { algorithm: "ed25519", signer: seller, value } });
    admitRevocationCandidates(hash, [{ locator: locator(7100), owner }]);
    const record = await indexed(fixture, commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, time));
    assert.equal(record.deals[0].refsVerified, accepted, `commitment at ${time}`);
    assert.equal(record.reputation.completed, accepted ? 1 : 0);
  }
});

test("an unresolved owner withdrawal cannot credit a newly fabricated deal", async (t) => {
  t.mock.method(Date, "now", () => 300);
  storage(t);
  const fixture = await prepared(false, { notBefore: 2 });
  admitRevocationCandidates(artifactHash(fixture.listing, "listing"), [{ locator: locator(7200), owner }]);
  const record = await indexed(fixture, commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj));
  assert.deepEqual(record.listings, []);
  assert.equal(record.deals[0].refsVerified, false);
  assert.equal(record.reputation.completed, 0);
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
    assert.match(result.reason ?? "", label === "missing proof" ? /invalid record/ : /proof lookup timed out/);
  }
});

test("a hung commitment adapter is bounded and returns a timeout cause", async (t) => {
  const { verifyListingCommitment } = await import("../src/catalog/commitmentFinality.js");
  const fixture = await prepared();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let aborted: AbortSignal | undefined;
  const pending = verifyListingCommitment({ jobId: "proof-job", listingRef: fixture.agreement.listingRef,
    agreementHash: artifactHash(fixture.agreement, "agreement"), pattern: "fixed-price", parties: dids.slice(0, 2) },
  { raw: fixture.listing, locator: fixture.locators.listing }, {
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
  assert.equal((await graph(fixture, proof)).ok, true);
  proof.record.extension = { retained: "tampered" };
  assert.equal((await graph(fixture, proof)).ok, false);
  const late = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, 101);
  const result = await graph(fixture, late, async (receipt, raw, signal) => {
    assert.equal(await fixtureCommitments.verifyReceipt(receipt, raw, signal), true);
    if (receipt.blockRef) receipt.blockRef.timestamp = 90;
    return true;
  });
  assert.equal(result.ok, false, "policy callback mutations cannot alter the checked snapshot");
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
  store.saveCatalog({ catalogVersion: "1", generatedAt: 150, sellers: [record] });
  const db = new Database(join(store.DATA_DIR, "directory.sqlite"));
  db.prepare("DELETE FROM kv_state WHERE key='commitment-finality-schema-version'").run();
  db.close();
  const restart = () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      "const s=await import('./src/catalog/store.ts'); console.log(JSON.stringify(s.loadCatalog()))"],
    { encoding: "utf8", env: process.env, timeout: 30_000 });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as ReturnType<typeof store.loadCatalog>;
  };
  const cleared = restart();
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
  assert.match(result.reason ?? "", /commitment.*agreement/);
});

test("commitment authority may be an authenticated orchestrator outside the buyer/seller roster", async () => {
  const fixture = await prepared();
  const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, 90, false,
    { claim: dids[2], seed: seeds[2] });
  assert.equal((await graph(fixture, proof)).ok, true);
});

test("a later withdrawal cannot overwrite an earlier authenticated cutoff, even if the original is unreadable", async (t) => {
  t.mock.method(Date, "now", () => 200);
  storage(t);
  const fixture = await prepared(false, { notBefore: 4 });
  const hash = artifactHash(fixture.listing, "listing");
  const marker = (revokedAt: number) => {
    const scope = { listingId: "svc", listingVersion: 1, listingContentHash: hash, revokedAt };
    const value = Buffer.from(ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[1]))).toString("base64url");
    return { ...scope, signature: { algorithm: "ed25519", signer: seller, value } };
  };
  maps.set(locator(7400), marker(100));
  admitRevocationCandidates(hash, [{ locator: locator(7400), owner }]);
  const first = await indexed(fixture, commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj));
  assert.equal(first.deals[0].refsVerified, true);
  const binding = first.listings[0].revocation;
  assert.ok(binding);
  const { retainListingRevocation, retainedListingRevocationMarker } = await import("../src/catalog/store.js");
  const later = marker(120);
  retainListingRevocation({ ...binding, markerAnchor: { kind: "storage-program", locator: locator(7401) },
    markerContentHash: contentHash(signedScope(later, "listing")) }, later);
  assert.equal(retainedListingRevocationMarker(hash)?.revokedAt, 100);
  maps.delete(locator(7400));
  const repeated = await indexed(fixture, commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, 110));
  assert.equal(repeated.deals[0].refsVerified, false);
  assert.equal(repeated.reputation.completed, 0);
});

test("commitment key resolver outages retain their original cause", async () => {
  const { verifyListingCommitment } = await import("../src/catalog/commitmentFinality.js");
  const fixture = await prepared();
  const proof = commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj);
  const result = await verifyListingCommitment({ jobId: "proof-job", listingRef: fixture.agreement.listingRef,
    agreementHash: artifactHash(fixture.agreement, "agreement"), pattern: "fixed-price", parties: dids.slice(0, 2) },
  { raw: fixture.listing, locator: fixture.locators.listing }, { ...fixtureCommitments, resolve: async () => proof },
  async () => { throw new Error("session key service timed out"); });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /session key service timed out/);
});

// Each cutoff test signs its own validity window, so its Listing hash, candidates and retained marker are its own.
const withdrawalMarker = (hash: string, revokedAt: number) => {
  const scope = { listingId: "svc", listingVersion: 1, listingContentHash: hash, revokedAt };
  const value = Buffer.from(ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[1]))).toString("base64url");
  return { ...scope, signature: { algorithm: "ed25519", signer: seller, value } };
};
async function creditedAfterWithdrawalAt120(t: TestContext, notBefore: number, at: number) {
  t.mock.method(Date, "now", () => 200);
  storage(t);
  const fixture = await prepared(false, { notBefore });
  const hash = artifactHash(fixture.listing, "listing");
  maps.set(locator(at), withdrawalMarker(hash, 120));
  admitRevocationCandidates(hash, [{ locator: locator(at), owner }]);
  const first = await indexed(fixture, commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, 110));
  assert.equal(first.deals[0].refsVerified, true, "a commitment before the only signed withdrawal is credited");
  return { fixture, hash, first, repeat: () => indexed(fixture, commitmentProof(fixture.agreement, fixture.agreement.listingRef as Obj, 110)) };
}

test("an earlier signed withdrawal discovered after a later one replaces the retained cutoff", async (t) => {
  const { hash, repeat } = await creditedAfterWithdrawalAt120(t, 5, 7410);
  maps.set(locator(7411), withdrawalMarker(hash, 100));
  admitRevocationCandidates(hash, [{ locator: locator(7411), owner }]);
  const repeated = await repeat();
  assert.equal(retainedListingRevocationMarker(hash)?.revokedAt, 100);
  assert.equal(repeated.deals[0].refsVerified, false);
  assert.equal(repeated.reputation.completed, 0);
});

test("an unread owner marker withholds credit beside a retained cutoff until a read settles it", async (t) => {
  const { hash, repeat } = await creditedAfterWithdrawalAt120(t, 6, 7420);
  admitRevocationCandidates(hash, [{ locator: locator(7421), owner }]);
  const held = await repeat();
  assert.equal(held.deals[0].refsVerified, false, "the unread owner marker may carry an earlier cutoff");
  assert.equal(held.reputation.completed, 0);
  maps.set(locator(7421), { listingId: "svc", listingVersion: 1, listingContentHash: hash, revokedAt: 90 });
  t.mock.method(Date, "now", () => 200 + 120_000);
  const settled = await repeat();
  assert.equal(settled.deals[0].refsVerified, true, "an unsigned marker is rejected, and the verified owner marker does not hold");
});

test("an unread marker carried by an authenticated withdrawal source withholds credit beside a retained cutoff", async (t) => {
  const { hash, first, repeat } = await creditedAfterWithdrawalAt120(t, 7, 7430);
  const binding = first.listings[0].revocation;
  assert.ok(binding);
  const carried = { ...binding, markerAnchor: { kind: "storage-program" as const, locator: locator(7431) } };
  assert.ok(recordWellKnownWithdrawalCheck("https://cutoff.example", seller, [], [], { generatedAt: 1, hash: "c".repeat(64) }, [carried]));
  const held = await repeat();
  assert.equal(held.deals[0].refsVerified, false, "the carried marker may carry an earlier cutoff");
  maps.set(locator(7431), withdrawalMarker(hash, 130));
  t.mock.method(Date, "now", () => 200 + 120_000);
  const settled = await repeat();
  assert.equal(settled.deals[0].refsVerified, true, "a verified carried marker settles its binding and the earliest cutoff stays 120");
});
