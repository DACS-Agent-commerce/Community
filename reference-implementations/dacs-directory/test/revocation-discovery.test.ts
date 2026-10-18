import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash, sha256Hex } from "../src/catalog/canonical.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
const directory = mkdtempSync(join(tmpdir(), "dacs-revocation-discovery-"));
process.env.DACS_DIRECTORY_DATA = directory;
const store = await import("../src/catalog/store.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { ingestWellKnownRevocations, reindexAll } = await import("../src/catalog/reindexCore.js");
const { verifyListing, findValidListingRevocation } = await import("../src/catalog/listingVerification.js");
const { crawlDomain, crawlDomains, wellKnownWithdrawalMessage } = await import("../src/catalog/wellknown.js");
const { GET: wellKnown } = await import("../app/api/dacs/wellknown-files/route.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));
const at = (n: number) => `stor-${String(n).padStart(40, "0")}`;
const offline = async (): Promise<never> => { throw new Error("offline"); };

test("authenticated withdrawal discovery survives incomplete bindings and full reindex retries", async (t) => {
  const seed = new Uint8Array(32).fill(94);
  const key = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
  const claim = `did:demos:agent:${key}`;
  const signBytes = (message: string, signerSeed: Uint8Array = seed) => Buffer.from(ed25519Sign(Buffer.from(message), privateKeyFromSeed(signerSeed))).toString("base64url");
  const sign = (raw: Record<string, unknown>, prefix: string) => ({ algorithm: "ed25519", signer: claim, value: signBytes(prefix + contentHash(raw)) });
  const scope = { listingId: "svc", listingVersion: 1, agentId: claim, serviceId: "svc", name: "Service", description: "Service",
    claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"], supportedDelivery: ["deliver-attested-payload"] };
  const listing = { ...scope, signature: sign(scope, "dacs-listing:v1:") };
  const verified = await verifyListing(listing); assert.ok(verified);
  const siblingScope = { ...scope, listingId: "sibling", serviceId: "sibling" };
  const sibling = { ...siblingScope, signature: sign(siblingScope, "dacs-listing:v1:") };
  const siblingVerified = await verifyListing(sibling); assert.ok(siblingVerified);
  const markerScope = { listingId: "svc", listingVersion: 1, listingContentHash: verified.contentHash, revokedAt: 1 };
  const marker = { ...markerScope, signature: sign(markerScope, "dacs-revocation:v1:") };
  const binding = await findValidListingRevocation([at(2)], verified, 1, async () => marker); assert.ok(binding);
  const previous = globalThis.fetch;
  let readable = true;
  globalThis.fetch = async (input) => {
    const locator = new URL(String(input)).pathname.split("/").pop();
    if (locator === at(2) && !readable) return Response.json({ success: false }, { status: 404 });
    if (![at(1), at(2), at(3)].includes(locator ?? "")) return Response.json({ result: 200, response: [] });
    return Response.json({ success: true, owner: `0x${key}`, data: locator === at(1) ? listing : locator === at(3) ? sibling : marker });
  };
  try {
    const reg = { primaryClaim: claim, displayName: "Service", listingAnchors: [at(1), at(3)], deals: [] };
    const active = await indexRegistration(reg, undefined, offline);
    assert.deepEqual(active.listings.map((l) => l.status), ["active", "active"], "positive control: cached offers are admitted");
    const revoked = { ...active, listings: [{ ...active.listings[0], status: "revoked" as const, revocation: binding }, active.listings[1]] };
    store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [revoked] });
    const { files, withdrawalSigning } = await (await wellKnown(new NextRequest(`https://directory.example/api/dacs/wellknown-files?claim=${claim}&domain=agent.example`))).json();
    const index = JSON.parse(files["/.well-known/dacs/listings.json"]);
    assert.deepEqual(index.listings[0].revocation, binding);
    assert.equal(withdrawalSigning.message, wellKnownWithdrawalMessage("agent.example", sha256Hex(files["/.well-known/dacs/listings.json"])));
    let indexEpoch = index.generatedAt;
    const documents = (body = index, domain = "agent.example", signerSeed: Uint8Array | null = seed) => {
      const raw = JSON.stringify({ ...body, generatedAt: ++indexEpoch }), card = JSON.parse(files["/.well-known/agent.json"]);
      card.dacs.listings.indexHash = `sha256-${sha256Hex(raw)}`;
      if (signerSeed) card.dacs.listings.publisherSignature = signBytes(wellKnownWithdrawalMessage(domain, sha256Hex(raw)), signerSeed);
      return { ...files, "/.well-known/agent.json": JSON.stringify(card), "/.well-known/dacs/listings.json": raw };
    };
    let hosted = documents();
    const deps = { validateUrl: async () => ({} as never), fetchJson: async (url: string) => {
      const raw = hosted[new URL(url).pathname]; return raw ? { raw, body: JSON.parse(raw) } : null;
    } };
    const crawl = async (domain = "agent.example") => {
      const result = await crawlDomain(domain, deps); assert.ok(!("error" in result)); return result;
    };
    // Daybreak N1: a hash-consistent unowned index cannot queue a missing marker.
    for (const signer of [null, new Uint8Array(32).fill(95)]) {
      const forgery = structuredClone(index); forgery.listings[0].revocation.markerAnchor.locator = at(99);
      hosted = documents(forgery, "attacker.example", signer);
      const forged = await crawl("attacker.example");
      assert.equal(forged.withdrawalAuthenticated, false);
      ingestWellKnownRevocations(forged);
      assert.equal(store.hasPendingRevocationCandidates(verified.contentHash), false);
      assert.deepEqual((await indexRegistration(reg, active, offline)).listings.map((l) => l.status), ["active", "active"]);
    }
    const olderActive = structuredClone(index); olderActive.listings[0].status = "active"; delete olderActive.listings[0].revocation;
    const oldActiveDocuments = documents(olderActive);
    hosted = documents(index);
    const agent = await crawl(); assert.equal(agent.withdrawalAuthenticated, true);
    // A signature cannot be replayed at another domain or across modified index bytes.
    assert.equal((await crawl("attacker.example")).withdrawalAuthenticated, false);
    const tampered = JSON.parse(hosted["/.well-known/agent.json"]); tampered.dacs.listings.indexHash = `sha256-${sha256Hex("{}")}`;
    hosted = { ...hosted, "/.well-known/agent.json": JSON.stringify(tampered), "/.well-known/dacs/listings.json": "{}" };
    assert.ok("error" in await crawlDomain("agent.example", deps));
    store.saveRegistrations([reg]); store.saveDomains(["agent.example"]);
    const run = () => reindexAll({ log: () => {}, resolveIdentities: offline, crawlWellKnown: (domains) => crawlDomains(domains, deps) });
    // Code N1: start with a cached active listing, and remove/malform its required binding.
    for (const malformed of [undefined, { ...binding, listingVersion: 99 },
      { ...binding, markerContentHash: { toString: null } },
      { ...binding, markerAnchor: { kind: "storage-program", locator: { toString: null } } }]) {
      const bad = structuredClone(index); bad.listings[0].revocation = malformed;
      hosted = documents(bad); store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [active] });
      await run();
      assert.deepEqual(store.loadCatalog().sellers[0].listings.map((l) => l.listingId), ["sibling"]);
      assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, verified.contentHash), true);
    }
    hosted = oldActiveDocuments; await run();
    assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, verified.contentHash), true, "older signed active indexes cannot clear newer incomplete checks");
    assert.ok(!store.loadCatalog().sellers[0].listings.some((l) => l.contentHash === verified.contentHash));
    // Same-index valid records survive an independently incomplete sibling.
    const mixed = structuredClone(index); mixed.listings[1].status = "revoked"; delete mixed.listings[1].revocation;
    hosted = documents(mixed); readable = false;
    await run();
    assert.equal(store.hasPendingRevocationCandidates(verified.contentHash), true);
    assert.deepEqual(store.loadCatalog().sellers[0].listings, []);
    // Failed later crawl retains authenticated incomplete checks, including after restart.
    hosted = {}; await run();
    assert.deepEqual((await indexRegistration(reg, active, offline)).listings, []);
    const { spawnSync } = await import("node:child_process");
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `const s=await import('./src/catalog/store.ts'); if(!s.hasIncompleteWellKnownWithdrawal(${JSON.stringify(claim)},${JSON.stringify(siblingVerified.contentHash)})) process.exit(1)`], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    hosted = documents(index); readable = true;
    const now = Date.now(); t.mock.method(Date, "now", () => now + 2000);
    await run();
    const indexed = store.loadCatalog().sellers[0];
    assert.deepEqual(indexed.listings.map((l) => l.status), ["revoked", "active"]);
    assert.deepEqual(indexed.listings[0].revocation, binding);
    assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, siblingVerified.contentHash), false);
    // Verified revocation dominates a subsequent incomplete check.
    hosted = {}; await run();
    assert.equal(store.loadCatalog().sellers[0].listings[0].status, "revoked");
  } finally { globalThis.fetch = previous; }
});
