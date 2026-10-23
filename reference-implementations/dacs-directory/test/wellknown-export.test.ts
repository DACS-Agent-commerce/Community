import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash, sha256Hex } from "../src/catalog/canonical.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import type { ListingSummary, SellerRecord } from "../src/catalog/types.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-wellknown-export-"));
process.env.DACS_DIRECTORY_DATA = directory;
const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const { verifyListing } = await import("../src/catalog/listingVerification.js");
const { MAX_INDEX_LISTINGS, crawlDomain, crawlDomains, wellKnownWithdrawalMessage } = await import("../src/catalog/wellknown.js");
const { GET: wellKnown } = await import("../app/api/dacs/wellknown-files/route.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));

const at = (n: number) => `stor-${String(n).padStart(40, "0")}`;
const offline = async (): Promise<never> => { throw new Error("offline"); };
const seed = new Uint8Array(32).fill(41);
const key = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
const claim = `did:demos:agent:${key}`;
const signBytes = (message: string) => Buffer.from(ed25519Sign(Buffer.from(message), privateKeyFromSeed(seed))).toString("base64url");
const a2a = "a2aEndpoint=https%3A%2F%2Fservice.example%2Fa2a&a2aTransport=JSONRPC";
const generate = (query: string) => wellKnown(new NextRequest(`https://directory.example/api/dacs/wellknown-files?claim=${claim}&${query}`));

/** A legacy-profile signed listing, as the indexer reads it from its anchor. */
async function signedListing(id: string, description = id) {
  const scope = { listingId: id, listingVersion: 1, agentId: claim, serviceId: id, name: id, description, claimRequirements: [],
    supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"], supportedDelivery: ["deliver-attested-payload"] };
  const raw = { ...scope, signature: { algorithm: "ed25519", signer: claim, value: signBytes(`dacs-listing:v1:${contentHash(scope)}`) } };
  const verified = await verifyListing(raw);
  assert.ok(verified, `positive control: ${id} verifies`);
  return { raw, hash: verified.contentHash };
}
const summary = (id: string, hash: string, locator: string, status: "active" | "revoked" = "active"): ListingSummary => ({
  listingId: id, version: 1, contentHash: hash, artifactProfile: "legacy-sdk-v0.1", status,
  anchor: { kind: "storage-program", locator }, seller: { primaryClaim: claim, displayName: "Seller" },
  offering: { title: id, description: id, category: "test", tags: [], rails: ["pay-dem"] }, pricing: {}, catalogObservedAt: 1,
} as ListingSummary);
const seller = (listings: ListingSummary[]) => ({ primaryClaim: claim, displayName: "Seller", listings, deals: [], cci: [],
  lastIndexedAt: 1, reputation: { completed: 0, totalAgreements: 0 } } as unknown as SellerRecord);

/** Node reads by locator; a function value answers that locator's request itself. */
function node(anchors: Record<string, unknown>) {
  return async (input: string | URL | Request) => {
    const locator = new URL(String(input)).pathname.split("/").pop() ?? "";
    const anchored = anchors[locator];
    if (typeof anchored === "function") return (anchored as () => Response | Promise<Response>)();
    if (anchored) return Response.json({ success: true, owner: `0x${key}`, data: anchored });
    if (locator.startsWith("stor-")) return Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
    return Response.json({ result: 200, response: [] });
  };
}
async function withNode<T>(anchors: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = node(anchors) as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = previous; }
}

test("a withdrawal cached without its binding stays revoked in the export, so a signed crawl withholds the stale active mirror", async () => {
  // Releases before revocation bindings (#63) cached `revoked` with no binding; store upgrades keep such rows.
  const svc = await signedListing("svc"), sibling = await signedListing("sibling");
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller([summary("svc", svc.hash, at(1), "revoked"), summary("sibling", sibling.hash, at(3))])] });
  const anchors = { [at(1)]: svc.raw, [at(3)]: sibling.raw };
  await withNode(anchors, async () => {
    const response = await generate(`domain=agent.example&${a2a}`);
    assert.equal(response.status, 200);
    const { files, withdrawalSigning } = await response.json();
    const card = JSON.parse(files["/.well-known/agent.json"]);
    card.dacs.listings.publisherSignature = signBytes(withdrawalSigning.message);
    const hosted: Record<string, string> = { ...files, "/.well-known/agent.json": JSON.stringify(card) };
    const deps = { validateUrl: async () => ({} as never), fetchJson: async (url: string) => {
      const raw = hosted[new URL(url).pathname]; return raw ? { raw, body: JSON.parse(raw) } : null;
    } };
    // The registration still names the listing's anchor, which reads as a valid active listing (the stale mirror).
    store.saveRegistrations([{ primaryClaim: claim, displayName: "Seller", listingAnchors: [at(1), at(3)], deals: [] }]);
    store.saveDomains(["agent.example"]);
    await reindexAll({ log: () => {}, resolveIdentities: offline, crawlWellKnown: (domains) => crawlDomains(domains, deps) });
    assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, svc.hash), true, "the signed index reports the withdrawal as incomplete (RB-5)");
    assert.deepEqual(store.loadCatalog().sellers[0].listings.map((l) => [l.listingId, l.status]), [["sibling", "active"]]);
    const entry = JSON.parse(files["/.well-known/dacs/listings.json"]).listings.find((l: { listingId: string }) => l.listingId === "svc");
    assert.equal(entry?.status, "revoked", "RB-3: the withdrawal is retained");
    assert.equal(Object.hasOwn(entry, "revocation"), false, "no binding is invented");
    assert.deepEqual(card.skills.map((s: { id: string }) => s.id), ["sibling"]);
  });
});

test("a failed node read refuses the export instead of offering a partial index for signing", async () => {
  const alpha = await signedListing("alpha"), beta = await signedListing("beta");
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller([summary("alpha", alpha.hash, at(5)), summary("beta", beta.hash, at(6))])] });
  // The error keeps the read's cause, and says whether a retry can clear it.
  const transient = /retry later/, persistent = /every export fails until/;
  for (const [failure, reason, httpStatus, advice] of [
    [() => new Response("upstream", { status: 503 }), "node-error", 503, transient],
    [() => Response.json({ success: false, errorCode: "INTERNAL_ERROR" }, { status: 500 }), "node-error", 500, transient],
    [() => Response.json({ success: false, errorCode: "PERMISSION_DENIED" }, { status: 403 }), "denied", 403, persistent],
    [() => Response.json({ success: true, owner: `0x${key}`, data: { blob: "x".repeat(256 * 1024) } }), "oversized", undefined, persistent],
    [() => new Response("{\"success\":tr"), "malformed", undefined, transient],
    [() => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }, "timeout", undefined, transient],
    [() => { throw new TypeError("fetch failed"); }, "network", undefined, transient],
  ] as const) {
    await withNode({ [at(5)]: alpha.raw, [at(6)]: failure }, async () => {
      const response = await generate(`domain=agent.example&${a2a}`);
      assert.equal(response.status, 503, reason);
      const body = await response.json();
      assert.match(body.error, /beta/);
      assert.equal(body.listingId, "beta");
      assert.equal(body.reason, reason);
      assert.equal(body.httpStatus, httpStatus, reason);
      assert.ok(body.error.includes(`(${reason}${httpStatus ? `, HTTP ${httpStatus}` : ""})`), body.error);
      assert.match(body.error, advice, reason);
      assert.equal(body.files, undefined);
      assert.equal(body.withdrawalSigning, undefined, "no signing message for an incomplete index");
    });
  }
});

test("an index of more than MAX_INDEX_LISTINGS entries is refused, since the crawler would reject it", async () => {
  const alpha = await signedListing("alpha");
  // Withdrawn versions are published without a read, so the count alone decides.
  const withdrawn = (count: number) => Array.from({ length: count }, (_, n) => summary(`gone-${n}`, alpha.hash, at(1000 + n), "revoked"));
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller(withdrawn(MAX_INDEX_LISTINGS + 1))] });
  await withNode({}, async () => {
    const response = await generate(`domain=agent.example&${a2a}`);
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, new RegExp(`at most ${MAX_INDEX_LISTINGS} listings`));
  });
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller(withdrawn(MAX_INDEX_LISTINGS))] });
  const { files } = await withNode({}, async () => {
    const response = await generate(`domain=agent.example&${a2a}`);
    assert.equal(response.status, 200, "positive control: exactly the limit is generated");
    return response.json();
  });
  // The crawler applies the same limit: it accepts the generated index and refuses one more entry.
  const crawl = (listingsJson: string) => {
    const card = JSON.parse(files["/.well-known/agent.json"]);
    card.dacs.listings.indexHash = `sha256-${sha256Hex(listingsJson)}`;
    const hosted: Record<string, string> = { "/.well-known/agent.json": JSON.stringify(card), "/.well-known/dacs/listings.json": listingsJson };
    return crawlDomain("agent.example", { validateUrl: async () => ({} as never), fetchJson: async (url: string) => {
      const raw = hosted[new URL(url).pathname]; return raw ? { raw, body: JSON.parse(raw) } : null;
    } });
  };
  const index = JSON.parse(files["/.well-known/dacs/listings.json"]);
  assert.equal(index.listings.length, MAX_INDEX_LISTINGS);
  assert.ok(!("error" in await crawl(files["/.well-known/dacs/listings.json"])));
  const oneMore = await crawl(JSON.stringify({ ...index, listings: [...index.listings, index.listings[0]] }));
  assert.ok("error" in oneMore && oneMore.error.includes(`at most ${MAX_INDEX_LISTINGS} listings`));
});

test("an offer whose anchor no longer holds the indexed listing is omitted, reported, and absent from skills", async () => {
  const alpha = await signedListing("alpha"), beta = await signedListing("beta"), gamma = await signedListing("gamma");
  const changed = await signedListing("gamma", "replaced content");
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller([summary("alpha", alpha.hash, at(5)),
    summary("beta", beta.hash, at(6)), summary("gamma", gamma.hash, at(7))])] });
  await withNode({ [at(5)]: alpha.raw, [at(7)]: changed.raw }, async () => {
    const response = await generate(`domain=agent.example&${a2a}`);
    assert.equal(response.status, 200);
    const { files, omitted, withdrawalSigning } = await response.json();
    const index = JSON.parse(files["/.well-known/dacs/listings.json"]);
    assert.deepEqual(index.listings.map((l: { listingId: string; contentHash: string }) => [l.listingId, l.contentHash]), [["alpha", alpha.hash]]);
    assert.deepEqual(JSON.parse(files["/.well-known/agent.json"]).skills.map((s: { id: string }) => s.id), ["alpha"]);
    assert.deepEqual(omitted, [{ listingId: "beta", reason: "absent" }, { listingId: "gamma", reason: "changed" }]);
    assert.equal(withdrawalSigning.message, wellKnownWithdrawalMessage("agent.example", sha256Hex(files["/.well-known/dacs/listings.json"])));
  });
});

test("the domain is validated like a domain registration before any file is generated", async () => {
  const alpha = await signedListing("alpha");
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller([summary("alpha", alpha.hash, at(5))])] });
  await withNode({ [at(5)]: alpha.raw }, async () => {
    for (const domain of ["agent.example.com:8443", "agent.example.com/dacs", "agent example.com", "agent.example.com?x=1",
      "https://user:pw@agent.example.com", "agent.example.com#top", "http://agent.example.com", `${"a".repeat(250)}.com`]) {
      const response = await generate(`domain=${encodeURIComponent(domain)}&${a2a}`);
      assert.equal(response.status, 400, domain);
      assert.equal(typeof (await response.json()).error, "string", domain);
    }
    // Hosts registration refuses before its DNS lookup: the same errors as crawlDomain's validatePublicHttpsUrl.
    // (NextURL rewrites a 127.x.x.x anywhere in a request URL to "localhost", so loopback is covered by [::1].)
    for (const [domain, error] of [["localhost", /local hostnames/], ["dev.localhost", /local hostnames/], ["agent.local", /local hostnames/],
      ["169.254.169.254", /non-public address/], ["10.0.0.5", /non-public address/], ["[::1]", /non-public address/],
      ["[::ffff:192.168.1.1]", /non-public address/]] as const) {
      const response = await generate(`domain=${encodeURIComponent(domain)}&${a2a}`);
      assert.equal(response.status, 400, domain);
      assert.match((await response.json()).error, error, domain);
      const registration = await crawlDomain(domain, { fetchJson: async () => assert.fail("refused before any request") });
      assert.ok("error" in registration && error.test(registration.error), `registration refuses ${domain} the same way`);
    }
    const publicAddress = await generate(`domain=93.184.215.14&${a2a}`);
    assert.equal(publicAddress.status, 200, "positive control: a public IP address passes the host rules");
    assert.match((await publicAddress.json()).withdrawalSigning.message, /\ndomain:https:\/\/93\.184\.215\.14\n/);
    const longest = ["a", "b", "c"].map((label) => label.repeat(63)).concat("d".repeat(61)).join(".");
    assert.equal(longest.length, 253);
    assert.equal((await generate(`domain=${longest}&${a2a}`)).status, 200, "positive control: a 253-character domain is accepted");
    for (const domain of ["HTTPS://Agent.Example.com", "agent.example.com/", " agent.example.com:443 "]) {
      const response = await generate(`domain=${encodeURIComponent(domain)}&${a2a}`);
      assert.equal(response.status, 200, domain);
      const { files, withdrawalSigning } = await response.json();
      assert.equal(JSON.parse(files["/.well-known/agent.json"]).dacs.listings.indexUrl, "https://agent.example.com/.well-known/dacs/listings.json");
      assert.match(withdrawalSigning.message, /\ndomain:https:\/\/agent\.example\.com\n/);
    }
  });
});
