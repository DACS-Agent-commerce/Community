import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentHash } from "../src/catalog/canonical.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-revocation-candidate-priority-"));
process.env.DACS_DIRECTORY_DATA = directory;
const store = await import("../src/catalog/store.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { verifyListing, REVOCATION_VERIFICATIONS_PER_PASS: limit } = await import("../src/catalog/listingVerification.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));

const at = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const owner = `0x${"a".repeat(64)}`, signer = `did:demos:agent:${"b".repeat(64)}`;
const unrelated = `0x${"c".repeat(64)}`;
const backlog = Array.from({ length: limit + 1 }, (_, n) => ({ locator: at(n + 1), owner: unrelated }));

// In-memory test identities have no connection to wallets or live nodes.
function identity() {
  const keys = generateKeyPairSync("ed25519");
  const rawKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  return { claim: `did:demos:agent:${rawKey}`, owner: `0x${rawKey}`,
    sign: (message: string) => sign(null, Buffer.from(message), keys.privateKey).toString("base64url") };
}

test("the first indexer batch includes a marker carried by a different listing signing key", async (t) => {
  const seller = identity(), signing = identity();
  assert.notEqual(seller.owner, store.canonicalProgramOwner(signing.claim));
  const identityScope = { bundleVersion: "1", presentedBy: seller.claim, presentedAt: 1,
    claims: [{ ref: seller.claim }, { ref: signing.claim }] };
  const scope = { dacsVersion: "1", listingVersion: 1, listingId: "signer-priority",
    seller: { displayName: "seller", identity: { ...identityScope, presentation: { kind: "per-claim",
      signatures: [{ ref: seller.claim, signature: seller.sign(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`) }] } } },
    offering: { title: "signer priority", description: "signer priority", category: "test", tags: [],
      deliverable: { kind: "storage-program", accessModel: "public" } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } }, terms: {}, validity: { notBefore: 1 } };
  const hash = contentHash(scope);
  const listing = { ...scope, signature: { algorithm: "ed25519", signer: signing.claim,
    value: signing.sign(`dacs-listing:v1:${hash}`) } };
  const verified = await verifyListing(listing);
  assert.equal(verified?.signer, signing.claim);
  assert.equal(verified?.sellerClaim, seller.claim);
  const listingAt = at(100), markerAt = at(101);
  const markerScope = { listingId: scope.listingId, listingVersion: 1, listingContentHash: hash, revokedAt: 1 };
  const marker = { ...markerScope, signature: { algorithm: "ed25519", signer: signing.claim,
    value: signing.sign(`dacs-revocation:v1:${contentHash(markerScope)}`) } };
  store.admitRevocationCandidates(hash, [...backlog, { locator: markerAt, owner: signing.claim, carried: true }]);
  const reads: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const locator = new URL(String(input)).pathname.split("/").pop()!;
    if (locator === listingAt) return Response.json({ success: true, owner: seller.owner, data: listing });
    reads.push(locator);
    return Response.json({ success: true, owner: locator === markerAt ? signing.owner : unrelated,
      data: locator === markerAt ? marker : {} });
  });
  const record = await indexRegistration({ primaryClaim: seller.claim, displayName: "seller", listingAnchors: [listingAt] },
    undefined, async () => { throw new Error("offline"); });
  assert.ok(reads.includes(markerAt), "the signing key's marker must be read in the first batch");
  assert.equal(reads[0], markerAt, "the signing key's marker precedes the unrelated backlog");
  assert.ok(reads.length <= limit, "the first pass respects the verification cap");
  assert.equal(record.listings[0]?.status, "revoked");
  assert.equal(record.listings[0]?.revocation?.markerAnchor.locator, markerAt);
});

test("owner and signer candidates share arrival order before the unrelated backlog", () => {
  const hash = "1".repeat(64), signerAt = at(201), ownerAt = at(202);
  store.admitRevocationCandidates(hash, [...backlog, { locator: signerAt, owner: signer }, { locator: ownerAt, owner }]);
  assert.deepEqual(store.nextRevocationCandidates(hash, owner, limit, signer),
    [signerAt, ownerAt, ...backlog.slice(0, limit - 2).map((candidate) => candidate.locator)]);
});

test("equivalent owner and signer spellings do not duplicate candidates or shorten the batch", () => {
  const hash = "2".repeat(64), ownedAt = at(301);
  store.admitRevocationCandidates(hash, [...backlog, { locator: ownedAt, owner }]);
  const batch = store.nextRevocationCandidates(hash, owner.toUpperCase(), limit, `did:demos:agent:${owner.slice(2)}`);
  assert.deepEqual(batch, [ownedAt, ...backlog.slice(0, limit - 1).map((candidate) => candidate.locator)]);
  assert.equal(new Set(batch).size, limit);
});

test("a signer is prioritized when the storage owner is null", () => {
  const hash = "3".repeat(64), markerAt = at(401);
  store.admitRevocationCandidates(hash, [...backlog, { locator: markerAt, owner: signer }]);
  assert.deepEqual(store.nextRevocationCandidates(hash, null, limit, `0x${signer.slice(-64).toUpperCase()}`),
    [markerAt, ...backlog.slice(0, limit - 1).map((candidate) => candidate.locator)]);
});

test("the shared owner and signer batch remains capped when it fills the pass", () => {
  const hash = "4".repeat(64);
  const priority = Array.from({ length: limit + 1 }, (_, n) => ({ locator: at(500 + n), owner: n % 2 ? owner : signer }));
  store.admitRevocationCandidates(hash, [...backlog, ...priority]);
  assert.deepEqual(store.nextRevocationCandidates(hash, owner, limit, signer),
    priority.slice(0, limit).map((candidate) => candidate.locator));
});
