import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash, sha256Hex } from "../src/catalog/canonical.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import type { WellKnownAgent } from "../src/catalog/wellknown.js";
const directory = mkdtempSync(join(tmpdir(), "dacs-revocation-discovery-"));
process.env.DACS_DIRECTORY_DATA = directory;
const { saveCatalog } = await import("../src/catalog/store.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { ingestWellKnownRevocations } = await import("../src/catalog/reindexCore.js");
const { verifyListing, findValidListingRevocation } = await import("../src/catalog/listingVerification.js");
const { crawlDomain } = await import("../src/catalog/wellknown.js");
const { GET: wellKnown } = await import("../app/api/dacs/wellknown-files/route.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));

test("export to crawl to index retains withdrawal bindings and withholds cached active offers on unreadable markers", async (t) => {
  const seed = new Uint8Array(32).fill(94);
  const key = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
  const claim = `did:demos:agent:${key}`;
  const at = (n: number) => `stor-${String(n).padStart(40, "0")}`;
  const sign = (raw: Record<string, unknown>, prefix: string) => ({ algorithm: "ed25519", signer: claim,
    value: Buffer.from(ed25519Sign(Buffer.from(prefix + contentHash(raw)), privateKeyFromSeed(seed))).toString("base64url") });
  const scope = { listingId: "svc", listingVersion: 1, agentId: claim, serviceId: "svc", name: "Service", description: "Service",
    claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"], supportedDelivery: ["deliver-attested-payload"] };
  const listing = { ...scope, signature: sign(scope, "dacs-listing:v1:") };
  const verified = await verifyListing(listing); assert.ok(verified);
  const markerScope = { listingId: "svc", listingVersion: 1, listingContentHash: verified.contentHash, revokedAt: 1 };
  const marker = { ...markerScope, signature: sign(markerScope, "dacs-revocation:v1:") };
  const binding = await findValidListingRevocation([at(2)], verified, 1, async () => marker); assert.ok(binding);
  const previous = globalThis.fetch;
  let readable = true;
  globalThis.fetch = async (input) => {
    const locator = new URL(String(input)).pathname.split("/").pop();
    if (locator === at(2) && !readable) return Response.json({ success: false }, { status: 503 });
    if (locator !== at(1) && locator !== at(2)) return Response.json({ result: 200, response: {} });
    return Response.json({ success: true, owner: `0x${key}`, data: locator === at(1) ? listing : marker });
  };
  try {
    const reg = { primaryClaim: claim, displayName: "Service", listingAnchors: [at(1)], deals: [] };
    const offline = async (): Promise<never> => { throw new Error("offline"); };
    const active = await indexRegistration(reg, undefined, offline);
    assert.equal(active.listings[0].status, "active");
    const revoked = { ...active, listings: [{ ...active.listings[0], status: "revoked" as const, revocation: binding }] };
    saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [revoked] });
    const { files } = await (await wellKnown(new NextRequest(`https://directory.example/api/dacs/wellknown-files?claim=${claim}&domain=agent.example`))).json();
    const index = JSON.parse(files["/.well-known/dacs/listings.json"]);
    assert.deepEqual(index.listings[0].revocation, binding);
    const crawl = async (documents = files) => crawlDomain("agent.example", {
      validateUrl: async () => ({} as never), fetchJson: async (url) => {
        const raw = documents[new URL(url).pathname]; return raw ? { raw, body: JSON.parse(raw) } : null;
      },
    });
    const agent = await crawl(); assert.ok(!("error" in agent));
    assert.deepEqual(agent.revocations, [binding]);
    assert.deepEqual(agent.listingAnchors, [at(1)]);
    ingestWellKnownRevocations(agent as WellKnownAgent);
    readable = false;
    assert.deepEqual((await indexRegistration(reg, active, offline)).listings, [], "unreadable withdrawal proof cannot leave the cached listing active");
    readable = true;
    const now = Date.now(); t.mock.method(Date, "now", () => now + 2000);
    const indexed = await indexRegistration(reg, active, offline);
    assert.equal(indexed.listings[0].status, "revoked");
    assert.deepEqual(indexed.listings[0].revocation, binding);
    const bad = structuredClone(index); delete bad.listings[0].revocation;
    const raw = JSON.stringify(bad);
    const card = JSON.parse(files["/.well-known/agent.json"]); card.dacs.listings.indexHash = `sha256-${sha256Hex(raw)}`;
    const invalid = await crawl({ ...files, "/.well-known/agent.json": JSON.stringify(card), "/.well-known/dacs/listings.json": raw });
    assert.ok("error" in invalid, "revoked-status-missing-binding is rejected through the exported surface");
  } finally { globalThis.fetch = previous; }
});
