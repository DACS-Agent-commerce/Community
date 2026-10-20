import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { contentHash, sha256Hex } from "../src/catalog/canonical.js";
import { crawlDomain } from "../src/catalog/wellknown.js";
import { findValidListingRevocation, verifyListing } from "../src/catalog/listingVerification.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-withdrawal-discovery-"));
process.env.DACS_DIRECTORY_DATA = directory;
const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const { GET } = await import("../app/api/dacs/listings/route.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));
const at = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;

test("unsigned incomplete withdrawal rows cannot introduce active offers", async t => {
  const seed = new Uint8Array(32).fill(43);
  const key = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
  const claim = `did:demos:agent:${key}`;
  const sign = (scope: Record<string, unknown>, prefix: string) => ({ algorithm: "ed25519", signer: claim,
    value: Buffer.from(ed25519Sign(Buffer.from(prefix + contentHash(scope)), privateKeyFromSeed(seed))).toString("base64url") });
  const identityScope = { bundleVersion: "1", presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
  const identity = { ...identityScope, presentation: { kind: "per-claim", signatures: [{ ref: claim,
    signature: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`),
      privateKeyFromSeed(seed))).toString("base64url") }] } };
  const cases = ["missing binding", "malformed binding", "wrong tuple", "unread marker", "tampered marker",
    "missing status", "malformed active", "conflicting rows", "reversed conflicting rows", "conflicting hashes", "active control", "revoked control", "active mirror control"];
  for (const [i, name] of cases.entries()) await t.test(name, async () => {
    const listingId = `withdrawal-${i}`;
    const scope = { dacsVersion: "1", listingVersion: 1, listingId, requiredCapabilities: ["SR-2"],
      seller: { displayName: "Service", identity },
      offering: { title: "Service", description: "Service", category: "services.other", tags: [],
        deliverable: { kind: "attested-payload", payloadFormat: "application/json", verificationMethod: { kind: "self-signed" } } },
      buyerRequirement: { requirementVersion: "1", required: [] },
      pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "deliver-attested-payload" }],
      pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } }, terms: {}, validity: { notBefore: 1 } };
    const listing = { ...scope, signature: sign(scope, "dacs-listing:v1:") };
    const verified = await verifyListing(listing); assert.ok(verified);
    const markerScope = { listingId, listingVersion: 1, listingContentHash: verified.contentHash, revokedAt: 1 };
    const marker = { ...markerScope, signature: sign(markerScope, "dacs-revocation:v1:") };
    const binding = await findValidListingRevocation([at(2)], verified, 1, async () => marker); assert.ok(binding);
    const active = { listingId, version: 1, contentHash: verified.contentHash,
      anchor: { kind: "storage-program", locator: at(1) }, summary: { title: "Service", category: "services.other", tags: [] }, status: "active" };
    const entry: Record<string, unknown> = { ...active, status: "revoked", revocation: binding };
    if (["missing binding", "active mirror control", "conflicting rows", "reversed conflicting rows", "conflicting hashes"].includes(name)) delete entry.revocation;
    if (name === "malformed binding") entry.revocation = {};
    if (name === "wrong tuple") entry.revocation = { ...binding, listingId: "another-listing" };
    if (name === "missing status") { delete entry.status; delete entry.revocation; }
    if (name === "malformed active") { entry.status = "active"; delete entry.revocation; entry.summary = {}; }
    if (name === "active control") { entry.status = "active"; delete entry.revocation; }
    const crawl = async (entries: unknown[], domain: string) => {
      const raw = JSON.stringify({ indexVersion: "1", generatedAt: i + 1, seller: claim, listings: entries });
      const agent = await crawlDomain(domain, { validateUrl: async () => ({} as never), fetchJson: async url => {
        const body = url.endsWith("agent.json") ? JSON.stringify({ dacs: { dacsVersion: "1", listings: {
          indexUrl: `https://${domain}/listings.json`, indexHash: `sha256-${sha256Hex(raw)}`,
        } } }) : raw;
        return { body: JSON.parse(body), raw: body };
      } });
      assert.ok(!("error" in agent)); assert.equal(agent.withdrawalAuthenticated, false);
      return agent;
    };
    const entries = name === "conflicting rows" ? [active, entry]
      : name === "reversed conflicting rows" ? [entry, active]
        : name === "conflicting hashes" ? [{ ...active, contentHash: "f".repeat(64) }, entry] : [entry];
    const agents = [await crawl(entries, "seller.example")];
    if (name === "active mirror control") agents.push(await crawl([active], "mirror.example"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (init?.body) return Response.json({ result: 200, response: [] });
      if (String(input).endsWith(at(2))) {
        if (name === "unread marker") return Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
        return Response.json({ success: true, owner: `0x${key}`, data: name === "tampered marker" ? { ...marker, revokedAt: 2 } : marker });
      }
      return Response.json({ success: true, owner: `0x${key}`, data: listing });
    };
    try {
      store.saveRegistrations([]); store.saveDomains(["seller.example"]);
      await reindexAll({ nodeDeployment: async () => ({ ok: true as const }), log: () => {}, resolveIdentities: async () => { throw new Error("offline"); },
        crawlWellKnown: async () => ({ agents, errors: [] }) });
      const response = await GET(new NextRequest("https://directory.example/api/dacs/listings"));
      assert.equal(response.status, 200);
      const { listings } = await response.json();
      if (name === "active control" || name === "active mirror control") {
        assert.equal(listings.length, 1); assert.equal(listings[0].status, "active");
      } else if (name === "revoked control") {
        assert.equal(listings.length, 1); assert.equal(listings[0].status, "revoked");
        assert.deepEqual(listings[0].revocation, binding);
      } else assert.deepEqual(listings, [], `${name} must not be promoted to active discovery`);
      assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, verified.contentHash), false,
        "unsigned rows cannot create authenticated holds on independently discovered listings");
    } finally { globalThis.fetch = originalFetch; }
  });
});
