import { revocationLogicalAddress, verifyListing } from "../src/catalog/listingVerification.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { A2A_PROTOCOL_VERSION, A2A_TRANSPORTS } from "../src/catalog/a2a.js";
import type { Catalog, ListingSummary, SellerRecord } from "../src/catalog/types.js";
import { requestWellKnownFiles } from "../src/components/wellknown-files.js";
import { schemaErrors } from "./helpers/jsonSchema.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-discovery-exports-"));
process.env.DACS_DIRECTORY_DATA = directory;
const { saveCatalog } = await import("../src/catalog/store.js");
const { GET: wellKnown } = await import("../app/api/dacs/wellknown-files/route.js");
const { GET: sellerView } = await import("../app/api/dacs/sellers/[primaryClaimRef]/route.js");
const { default: sitemap } = await import("../app/sitemap.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));

// A2A v0.3.0 specification/json/a2a.json, byte-identical at the SPEC_PIN commit.
const a2aSchemaBytes = readFileSync(new URL("./fixtures/a2a/a2a.json", import.meta.url));
const a2aSchema = JSON.parse(a2aSchemaBytes.toString("utf8"));
const agentCardErrors = (card: unknown) => schemaErrors(a2aSchema, a2aSchema.definitions.AgentCard, card);

const seed = new Uint8Array(32).fill(23);
const claim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const locator = (id: string) => `stor-${sha256Hex(id).slice(0, 40)}`;
const anchored: Record<string, Record<string, unknown>> = {};
const listing = async (id: string, rail: string, status: "active" | "revoked" = "active"): Promise<ListingSummary> => {
  const scope = { listingId: id, listingVersion: 1, agentId: claim, serviceId: id, name: id, description: id, claimRequirements: [],
    supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: [rail], supportedDelivery: ["deliver-attested-payload"] };
  const value = Buffer.from(ed25519Sign(Buffer.from(`dacs-listing:v1:${contentHash(scope)}`), privateKeyFromSeed(seed))).toString("base64url");
  anchored[locator(id)] = { ...scope, signature: { algorithm: "ed25519", signer: claim, value } };
  const verified = await verifyListing(anchored[locator(id)]);
  assert.ok(verified, `positive control: ${id} verifies`);
  return { listingId: id, version: 1, contentHash: verified.contentHash, artifactProfile: "dacs-v0.1", status,
    anchor: { kind: "storage-program", locator: locator(id) }, seller: { primaryClaim: claim, displayName: "Seller" },
    offering: { title: id, description: id, category: "test", tags: [], rails: [rail] }, pricing: {}, catalogObservedAt: 1,
  } as ListingSummary;
};
const listings = [await listing("old-dem", "pay-dem"), await listing("old-x402", "pay-x402"),
  await listing("native", "demos-native:DEM"), await listing("x402", "x402:default"), await listing("revoked", "demos-native:DEM", "revoked")];
listings[4].revocation = { sellerPrimaryClaim: claim, listingId: "revoked", listingVersion: 1,
  listingContentHash: listings[4].contentHash, logicalAddress: revocationLogicalAddress(claim, "revoked", 1),
  markerAnchor: { kind: "storage-program", locator: `stor-${"c".repeat(40)}` }, markerContentHash: "d".repeat(64) };
const seller = { primaryClaim: claim, displayName: "Seller", listings, deals: [], cci: [], lastIndexedAt: 1,
  reputation: { completed: 0, totalAgreements: 0 } } as unknown as SellerRecord;
const a2a = "a2aEndpoint=https%3A%2F%2Fservice.example%2Fa2a&a2aTransport=HTTP%2BJSON";
const generate = (query: string) => wellKnown(new NextRequest(`https://directory.example/api/dacs/wellknown-files?claim=${claim}&domain=agent.example&${query}`));

async function withNode<T>(run: (read: string[]) => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  const read: string[] = [];
  globalThis.fetch = async (input) => {
    const at = new URL(String(input)).pathname.split("/").pop()!;
    if (!at.startsWith("stor-")) return Response.json({ result: 200, response: [] });
    read.push(at);
    return anchored[at] ? Response.json({ success: true, data: anchored[at] }) : new Response("upstream", { status: 503 });
  };
  try { return await run(read); } finally { globalThis.fetch = previous; }
}

test("machine discovery retains tombstones while skills and sitemap advertise executable offers", async () => {
  saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller] } as Catalog);
  // The withdrawn version's anchor is unreadable: RB-3 retains it whatever it reads now.
  delete anchored[locator("revoked")];
  await withNode(async (read) => {
    const response = await generate(a2a);
    assert.equal(response.status, 200);
    const { files, omitted } = await response.json();
    const index = JSON.parse(files["/.well-known/dacs/listings.json"]);
    const card = JSON.parse(files["/.well-known/agent-card.json"]);
    assert.equal(files["/.well-known/agent-card.json"], files["/.well-known/agent.json"]);
    assert.deepEqual(index.listings.map((l: ListingSummary) => l.listingId), ["native", "x402", "revoked"]);
    assert.deepEqual(omitted, []);
    assert.equal(card.url, "https://service.example/a2a");
    assert.equal(card.preferredTransport, "HTTP+JSON");
    assert.deepEqual(index.listings[2].revocation, listings[4].revocation);
    assert.equal(Object.hasOwn(index.listings[0], "revocation"), false);
    assert.deepEqual(index.listings.map((l: ListingSummary) => l.contentHash), listings.slice(2).map((l) => l.contentHash));
    assert.deepEqual(card.skills.map((s: { id: string }) => s.id), ["native", "x402"]);
    assert.equal(card.dacs.listings.indexHash, `sha256-${sha256Hex(files["/.well-known/dacs/listings.json"])}`);
    assert.deepEqual(read, listings.slice(2, 4).map((l) => l.anchor.locator), "only executable offers are re-read");
  });
  const view = await sellerView(new NextRequest("https://directory.example/api/dacs/sellers/agent"),
    { params: Promise.resolve({ primaryClaimRef: claim }) });
  assert.deepEqual((await view.json()).listings.map((l: ListingSummary) => l.listingId), ["native", "x402", "revoked"]);
  const urls = sitemap().map((entry) => entry.url);
  assert.equal(urls.filter((url) => url.includes("/service/")).length, 2);
  assert.ok(!urls.some((url) => /old-|revoked/.test(url)));
});

test("an archival-only seller publishes no active skills, index entries or sitemap destinations", async () => {
  saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [{ ...seller, listings: listings.slice(0, 2) }] });
  await withNode(async (read) => {
    const { files } = await (await generate(a2a)).json();
    assert.deepEqual(JSON.parse(files["/.well-known/dacs/listings.json"]).listings, []);
    assert.deepEqual(JSON.parse(files["/.well-known/agent.json"]).skills, []);
    assert.deepEqual(agentCardErrors(JSON.parse(files["/.well-known/agent.json"])), []);
    assert.deepEqual(read, [], "historical aliases are not offers and are not read");
  });
  assert.ok(!sitemap().some((entry) => /\/(?:service|seller)\//.test(entry.url)));
});

test("A2A generation requires the service endpoint and its declared transport together", async () => {
  saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller] } as Catalog);
  await withNode(async () => {
    for (const query of ["", "a2aEndpoint=https://service.example/a2a", "a2aTransport=HTTP%2BJSON",
      "a2aEndpoint=http://service.example/a2a&a2aTransport=HTTP%2BJSON", "a2aEndpoint=https://service.example/a2a&a2aTransport=unknown",
      "a2aEndpoint=https://service.example/a2a&a2aTransport=jsonrpc", "a2aEndpoint=https%3A%2F%2Fu%3Ap%40service.example%2Fa2a&a2aTransport=GRPC",
      "a2aEndpoint=https%3A%2F%2Fu%40service.example%2Fa2a&a2aTransport=GRPC", "a2aEndpoint=https%3A%2F%2Fservice.example%2Fa2a%23x&a2aTransport=GRPC",
      "a2aEndpoint=https%3A%2F%2Fservice.example%2Fa2a%23&a2aTransport=GRPC", "a2aEndpoint=https%3A%2F%2Fserv%0Aice.example%2Fa2a&a2aTransport=GRPC",
      "a2aEndpoint=https%3A%2F%2Fserv%09ice.example%2Fa2a&a2aTransport=GRPC", "a2aEndpoint=service.example%2Fa2a&a2aTransport=GRPC"]) {
      const response = await generate(query);
      assert.equal(response.status, 400, query);
      assert.match((await response.json()).error, /a2aEndpoint/, query);
    }
    // Every pinned transport is accepted, and the card carries the parsed URL a client will request.
    for (const [endpoint, transport, url] of [["https://service.example/a2a", "JSONRPC", "https://service.example/a2a"],
      ["https://service.example", "GRPC", "https://service.example/"], [" https://Service.Example/a2a ", "HTTP+JSON", "https://service.example/a2a"],
      ["https:service.example/a2a", "JSONRPC", "https://service.example/a2a"]]) {
      const response = await generate(`a2aEndpoint=${encodeURIComponent(endpoint)}&a2aTransport=${encodeURIComponent(transport)}`);
      assert.equal(response.status, 200, endpoint);
      const card = JSON.parse((await response.json()).files["/.well-known/agent-card.json"]);
      assert.equal(card.url, url, endpoint);
      assert.equal(card.preferredTransport, transport);
      assert.equal(card.protocolVersion, "0.3.0");
      assert.equal(card.version, "1.0.0");
    }
  });
});

test("the register page's A2A fields reach the generator and set the card's service", async () => {
  saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller] } as Catalog);
  await withNode(async () => {
    const page = (path: string | URL | Request) => wellKnown(new NextRequest(`https://directory.example${String(path)}`));
    const result = await requestWellKnownFiles({ claim, domain: "agent.example", a2aEndpoint: "https://service.example/grpc", a2aTransport: "GRPC" }, page as typeof fetch);
    assert.ok(!("error" in result));
    const card = JSON.parse(result.files["/.well-known/agent-card.json"]);
    assert.equal(card.url, "https://service.example/grpc");
    assert.equal(card.preferredTransport, "GRPC");
    assert.deepEqual(agentCardErrors(card), []);
    assert.match((await requestWellKnownFiles({ claim, domain: "agent.example", a2aEndpoint: "", a2aTransport: "GRPC" }, page as typeof fetch) as { error: string }).error, /a2aEndpoint/);
  });
});

test("every generated card is a valid A2A v0.3.0 AgentCard under the vendored schema", async () => {
  const pinned = readFileSync(new URL("../SPEC_PIN", import.meta.url), "utf8");
  assert.match(pinned, new RegExp(`a2a\\.json\\s+${createHash("sha256").update(a2aSchemaBytes).digest("hex")}`), "SPEC_PIN records the vendored bytes");
  assert.deepEqual([...A2A_TRANSPORTS], a2aSchema.definitions.TransportProtocol.enum);
  assert.equal(A2A_PROTOCOL_VERSION, a2aSchema.definitions.AgentCard.properties.protocolVersion.default);
  assert.ok(agentCardErrors({ name: "x" }).some((error) => error.includes("missing required url")), "positive control: the validator rejects a partial card");
  saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller] } as Catalog);
  await withNode(async () => {
    for (const transport of A2A_TRANSPORTS) {
      const { files } = await (await generate(`a2aEndpoint=https%3A%2F%2Fservice.example%2Fa2a&a2aTransport=${encodeURIComponent(transport)}`)).json();
      for (const path of ["/.well-known/agent.json", "/.well-known/agent-card.json"]) {
        assert.deepEqual(agentCardErrors(JSON.parse(files[path])), [], `${path} ${transport}`);
      }
    }
  });
});
