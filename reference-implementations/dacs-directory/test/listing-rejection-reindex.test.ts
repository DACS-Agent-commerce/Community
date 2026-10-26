// First: the store must open in a fresh directory, never the checkout's data/.
import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ed25519Sign, privateKeyFromSeed } from "@kynesyslabs/dacs/crypto";
import { NextRequest } from "next/server";
import { GET as listings } from "../app/api/dacs/listings/route.js";
import { POST as indexNow } from "../app/api/dacs/index-now/route.js";
import { artifactHash, signedScope } from "../src/catalog/evidenceGraph.js";
import { PINNED_DEMOS_CHAIN_IDENTITY } from "../src/catalog/nodeDeployment.js";
import { reindexAll } from "../src/catalog/reindexCore.js";
import { registrationMessage } from "../src/catalog/registrationSig.js";
import { indexerDiagnostics, loadCatalog, recordListingRejection, saveDomains, saveRegistrations } from "../src/catalog/store.js";
import { crawlDomain, wellKnownWithdrawalMessage, type WellKnownAgent } from "../src/catalog/wellknown.js";
import { sha256Hex } from "../src/catalog/canonical.js";
import { dids, maps, seeds, sign, vector } from "./fixtures/current-evidence.js";

const owner = `0x${dids[1].slice(-64)}`;
const departedSeller = `did:demos:agent:${"d1".repeat(32)}`;
const crawlOnlySeller = `did:demos:agent:${"c2".repeat(32)}`;
let domain = "https://seller.example";
// Source authentication persists, so unrelated tests must use distinct origins.
test.beforeEach((context) => { domain = `https://${sha256Hex(context.name).slice(0, 16)}.example`; });
const rejectedAt = (digit: string) => `stor-${digit.repeat(40)}`;

const registration = (listingAnchors: string[]) => ({ primaryClaim: dids[1], displayName: "seller", listingAnchors, deals: [] });
const agentDeclaring = (anchor: string, declaredHash: string, authenticated: boolean): WellKnownAgent => ({
  domain, seller: dids[1], listingAnchors: [anchor], activeListingAnchors: [anchor], contentHashes: { [anchor]: declaredHash },
  revocations: [], bundleBindings: [], withdrawalAuthenticated: authenticated, withdrawalHashes: [anchor],
  withdrawalIndex: { generatedAt: 1, hash: "a".repeat(64) },
});
const crawling = (agents: WellKnownAgent[], failed: boolean) => async () => ({
  agents, errors: failed ? [{ domain, error: "offline" }] : [],
});

async function withChainFetch(run: () => Promise<unknown>, anchorOwner = owner): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.body) {
      const call = (JSON.parse(String(init.body)) as { params?: Array<{ message?: string; data?: { blockNumber?: number } }> }).params?.[0];
      // The chain pin the index-now route reads: block one names the chain.
      if (call?.message === "getBlockByNumber") {
        return Response.json(call.data?.blockNumber === 1
          ? { result: 200, response: { id: 2, number: 1, status: "confirmed", hash: "12".repeat(32),
            content: { previousHash: PINNED_DEMOS_CHAIN_IDENTITY, timestamp: 1 } } }
          : { result: 400, response: "error" });
      }
      return Response.json({ result: 200, response: [] });
    }
    const data = maps.get(String(input).split("/").pop() ?? "");
    return data ? Response.json({ success: true, owner: anchorOwner, programName: "dacs:test", data }) : new Response(null, { status: 404 });
  };
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const reindexWith = (crawl: ReturnType<typeof crawling>, anchorOwner = owner): Promise<void> => withChainFetch(
  () => reindexAll({ nodeDeployment: async () => ({ ok: true as const }), log: () => {}, resolveIdentities: async () => { throw new Error("offline"); }, crawlWellKnown: crawl }), anchorOwner);

const diagnostics = () => indexerDiagnostics().listingRejectionDiagnostics.items;

test("a publisher-authenticated declared hash that mismatches a registered anchor becomes a public notice", async () => {
  const { locators } = await vector("declared-hash-job", 300);
  saveDomains([domain]);
  saveRegistrations([registration([locators.listing])]);
  await reindexWith(crawling([agentDeclaring(locators.listing, "f".repeat(64), true)], false));
  const notice = diagnostics().find((item) => item.locator === locators.listing);
  assert.equal(notice?.code, "DECLARED_CONTENT_HASH_MISMATCH");
  assert.equal(notice?.publicNotice, true);
  assert.equal(notice?.listingId, "svc");
});

test("an unauthenticated declared hash neither rejects a registered anchor nor creates a notice", async () => {
  const { locators } = await vector("unsigned-declared-hash-job", 305);
  saveDomains([domain]);
  saveRegistrations([registration([locators.listing])]);
  await reindexWith(crawling([agentDeclaring(locators.listing, "f".repeat(64), false)], false));
  assert.equal(diagnostics().some((item) => item.locator === locators.listing), false);
});

test("a failed crawl keeps the rejection history of a seller only the crawl discovers; a complete pass removes departed sellers", async () => {
  const { locators } = await vector("prune-job", 310);
  saveDomains([domain]);
  saveRegistrations([registration([locators.listing])]);
  recordListingRejection(rejectedAt("1"), crawlOnlySeller, "LISTING_SIGNATURE_INVALID");
  recordListingRejection(rejectedAt("2"), departedSeller, "LISTING_SIGNATURE_INVALID");
  const remaining = () => diagnostics().map((item) => item.locator).filter((locator) => [rejectedAt("1"), rejectedAt("2")].includes(locator)).sort();

  await reindexWith(crawling([], true));
  assert.deepEqual(remaining(), [rejectedAt("1"), rejectedAt("2")], "an incomplete discovery pass proves no removal");

  await reindexWith(crawling([], false));
  assert.deepEqual(remaining(), [], "a complete pass removes rows of sellers that are no longer registered or discovered");
});

test("a failed crawl keeps a crawl-derived rejection of a registered seller; a complete pass removes it", async () => {
  const { locators } = await vector("known-seller-job", 330);
  saveDomains([domain]);
  saveRegistrations([registration([locators.listing])]);
  recordListingRejection(rejectedAt("4"), dids[1], "LISTING_SIGNATURE_INVALID");
  const kept = () => diagnostics().some((item) => item.locator === rejectedAt("4"));

  await reindexWith(crawling([], true));
  assert.equal(kept(), true, "the registration does not name this anchor, so an incomplete crawl cannot show it is gone");

  await reindexWith(crawling([], false));
  assert.equal(kept(), false, "a complete pass that does not offer the anchor removes it");
});

test("an owner-signed registration keeps its public owner-mismatch notice after a crawl adds anchors", async () => {
  const { locators } = await vector("owner-signed-job", 340);
  const stored = registration([locators.listing]);
  const message = registrationMessage(stored, 1);
  const signature = Buffer.from(await ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seeds[1]))).toString("hex");
  saveRegistrations([{ ...stored, ownerSignature: { message, signedAt: 1, signature } }]);
  saveDomains([domain]);
  await reindexWith(crawling([agentDeclaring(rejectedAt("5"), "f".repeat(64), false)], false), `0x${"f".repeat(64)}`);
  const notice = diagnostics().find((item) => item.locator === locators.listing);
  assert.equal(notice?.code, "OWNER_CLAIM_BINDING");
  assert.equal(notice?.publicNotice, true, "the signature is checked on the registration as the owner signed it");
});

test("an owner-signed registration does not publish an owner-mismatch notice for an anchor only the crawl added", async () => {
  const { locators } = await vector("crawl-only-owner-job", 350);
  const stored = registration([]);
  const message = registrationMessage(stored, 1);
  const signature = Buffer.from(await ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seeds[1]))).toString("hex");
  saveRegistrations([{ ...stored, ownerSignature: { message, signedAt: 1, signature } }]);
  saveDomains([domain]);
  await reindexWith(crawling([agentDeclaring(locators.listing, "f".repeat(64), false)], false), `0x${"f".repeat(64)}`);
  const notice = diagnostics().find((item) => item.locator === locators.listing);
  assert.equal(notice?.code, "OWNER_CLAIM_BINDING");
  assert.equal(notice?.publicNotice, false, "the owner never signed this pointer");
});

test("an operator-pinned unsigned index cannot reject a registered anchor with a declared hash", async () => {
  const { locators } = await vector("pinned-unsigned-job", 360);
  saveDomains([domain]);
  saveRegistrations([registration([locators.listing])]);
  process.env.DACS_WITHDRAWAL_SOURCE_PINS = JSON.stringify({ [domain]: dids[1] });
  try {
    await reindexWith(crawling([agentDeclaring(locators.listing, "f".repeat(64), false)], false));
  } finally {
    delete process.env.DACS_WITHDRAWAL_SOURCE_PINS;
  }
  assert.equal(diagnostics().some((item) => item.locator === locators.listing), false);
  assert.equal(loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])?.listings.length, 1);
});

test("index-now keeps a declared-hash notice and crawl-derived history it cannot rediscover", async () => {
  const { locators } = await vector("immediate-job", 370);
  saveDomains([domain]);
  saveRegistrations([registration([locators.listing])]);
  await reindexWith(crawling([agentDeclaring(locators.listing, "f".repeat(64), true)], false));
  // Written by a crawl, so the registration as stored does not name this anchor.
  recordListingRejection(rejectedAt("6"), dids[1], "LISTING_SIGNATURE_INVALID");

  await withChainFetch(() => indexNow(new NextRequest("https://directory.example/api/dacs/index-now",
    { method: "POST", body: JSON.stringify({ claim: dids[1] }) })));

  const after = diagnostics().filter((item) => [locators.listing, rejectedAt("6")].includes(item.locator));
  assert.deepEqual(after.map((item) => item.locator).sort(), [locators.listing, rejectedAt("6")].sort());
  assert.equal(after.find((item) => item.locator === locators.listing)?.publicNotice, true);
  assert.equal(loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])?.listings.length, 0);
});

test("incomplete passes keep a declared-hash mismatch when the anchor fails verification in between", async () => {
  const { listing, locators } = await vector("interleaved-failure-job", 390);
  saveDomains([domain]);
  saveRegistrations([registration([locators.listing])]);
  const notice = () => diagnostics().find((item) => item.locator === locators.listing);
  const listingCount = () => loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])?.listings.length;

  await reindexWith(crawling([agentDeclaring(locators.listing, "f".repeat(64), true)], false));
  assert.equal(notice()?.code, "DECLARED_CONTENT_HASH_MISMATCH");

  maps.set(locators.listing, { ...listing, offering: { ...(listing.offering as object), title: "tampered" } });
  await reindexWith(crawling([], true));
  assert.equal(notice()?.code, "DECLARED_CONTENT_HASH_MISMATCH", "an unverifiable read does not discharge the declaration");

  maps.set(locators.listing, listing);
  await reindexWith(crawling([], true));
  assert.equal(notice()?.code, "DECLARED_CONTENT_HASH_MISMATCH");
  assert.equal(listingCount(), 0);
});

test("a corrected declared hash clears the rejection even when an unrelated domain fails to crawl", async () => {
  const { listing, locators } = await vector("corrected-hash-job", 380);
  saveDomains([domain, "dead.example"]);
  saveRegistrations([registration([locators.listing])]);
  const crawlingWithDeadDomain = (declaredHash: string) => async () => ({
    agents: [agentDeclaring(locators.listing, declaredHash, true)],
    errors: [{ domain: "https://dead.example", error: "offline" }],
  });
  const notice = () => diagnostics().find((item) => item.locator === locators.listing);
  const listingCount = () => loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])?.listings.length;

  await reindexWith(crawling([agentDeclaring(locators.listing, "f".repeat(64), true)], false));
  assert.equal(notice()?.code, "DECLARED_CONTENT_HASH_MISMATCH");
  assert.equal(listingCount(), 0);

  await reindexWith(crawlingWithDeadDomain(artifactHash(listing, "listing")));
  assert.equal(notice(), undefined, "the seller declared the matching hash in this pass");
  assert.equal(listingCount(), 1);
});

async function publicListingVector(jobId: string, offset: number) {
  const fixture = await vector(jobId, offset);
  const scope = signedScope(fixture.listing, "listing");
  scope.acceptedRails = [{ railId: "demos-native:DEM" }];
  scope.pipeline = [
    { kind: "negotiate-fixed-price" }, { kind: "commit-agreement" },
    { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-attested-payload" },
  ];
  const listing = { ...scope, signature: await sign(scope, "listing", 1) };
  maps.set(fixture.locators.listing, listing);
  return { listing, locators: fixture.locators };
}

for (const generatedAt of [100, 200]) {
  test(`a rejected signed index at ${generatedAt} cannot clear a newer declared-hash notice`, async () => {
    const { listing, locators } = await publicListingVector("ordered-hash-job", 400 + generatedAt);
    const source = `https://ordered-${generatedAt}.example`;
    const hash = artifactHash(listing, "listing");
    saveDomains([source]);
    saveRegistrations([registration([locators.listing])]);
    const crawl = async (timestamp: number, declaredHash: string) => {
      const raw = JSON.stringify({ indexVersion: "1", generatedAt: timestamp, seller: dids[1], listings: [{
        listingId: "svc", version: 1, contentHash: declaredHash,
        anchor: { kind: "storage-program", locator: locators.listing }, status: "active",
        summary: { title: "Service", category: "services.test", tags: [] },
      }] });
      const indexHash = sha256Hex(raw);
      const signature = Buffer.from(await ed25519Sign(Buffer.from(wellKnownWithdrawalMessage(source, indexHash)),
        privateKeyFromSeed(seeds[1]))).toString("base64url");
      const agent = await crawlDomain(source, { validateUrl: async (url) => ({ url: new URL(url), ip: "203.0.113.1" }), fetchJson: async (url) => {
        const document = url.endsWith("agent.json") ? JSON.stringify({ dacs: { dacsVersion: "1", listings: {
          indexUrl: `${source}/listings.json`, indexHash, publisherSignature: signature,
        } } }) : raw;
        return { raw: document, body: JSON.parse(document) };
      } });
      assert.ok(!("error" in agent));
      assert.equal(agent.withdrawalAuthenticated, true);
      return crawling([agent], false);
    };
    const publicCount = async () => {
      const response = await listings(new NextRequest("https://directory.example/api/dacs/listings"));
      assert.equal(response.status, 200);
      return (await response.json()).total;
    };
    const notice = () => diagnostics().find((item) => item.locator === locators.listing);
    await reindexWith(await crawl(200, "f".repeat(64)));
    const before = notice();
    assert.equal(before?.code, "DECLARED_CONTENT_HASH_MISMATCH");
    assert.equal(before?.publicNotice, true);
    assert.equal(await publicCount(), 0);
    for (let repeat = 0; repeat < 2; repeat++) {
      await reindexWith(await crawl(generatedAt, hash));
      assert.deepEqual(notice(), before, "a refused source cannot discharge or rewrite the rejection");
      assert.equal(await publicCount(), 0);
    }
    await reindexWith(await crawl(201, hash));
    assert.equal(notice(), undefined, "a newer accepted source can correct the declaration");
    assert.equal(await publicCount(), 1);
  });
}

for (const mode of ["index-now", "failed crawl"] as const) {
  test(`an unsigned mismatch cannot hold an owner-signed registration during ${mode}`, async () => {
    const { locators } = await publicListingVector("unsigned-hash-job", 700);
    saveDomains([domain]);
    saveRegistrations([]);
    await reindexWith(crawling([agentDeclaring(locators.listing, "f".repeat(64), false)], false));
    const before = diagnostics().find((item) => item.locator === locators.listing);
    assert.equal(before?.code, "DECLARED_CONTENT_HASH_MISMATCH");
    assert.equal(before?.publicNotice, false);
    const stored = registration([locators.listing]);
    const message = registrationMessage(stored, 1);
    const signature = Buffer.from(await ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seeds[1]))).toString("hex");
    saveRegistrations([{ ...stored, ownerSignature: { message, signedAt: 1, signature } }]);
    if (mode === "index-now") {
      await withChainFetch(async () => {
        const response = await indexNow(new NextRequest("https://directory.example/api/dacs/index-now",
          { method: "POST", body: JSON.stringify({ claim: dids[1] }) }));
        assert.equal(response.status, 200);
        assert.equal((await response.json()).listings, 1);
      });
    } else await reindexWith(crawling([], true));
    const seller = loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1]);
    assert.equal(seller?.ownerRegistered, true);
    assert.equal(seller?.listings.length, 1);
    const response = await listings(new NextRequest("https://directory.example/api/dacs/listings"));
    assert.equal((await response.json()).total, 1);
  });
}

for (const mode of ["registered", "crawl-only", "operator-pinned"] as const) {
  test(`a signed-to-unsigned ${mode} source retains its declared-hash rejection until authenticated correction`, async () => {
    const { listing, locators } = await publicListingVector(`authentication-loss-${mode}`, 810);
    const source = `https://authentication-loss-${mode}.example`;
    saveDomains([source]);
    saveRegistrations(mode === "crawl-only" ? [] : [registration([locators.listing])]);
    const crawl = async (authenticated: boolean, generatedAt: number, declaredHash: string) => {
      const raw = JSON.stringify({ indexVersion: "1", generatedAt, seller: dids[1], listings: [{
        listingId: "svc", version: 1, contentHash: declaredHash,
        anchor: { kind: "storage-program", locator: locators.listing }, status: "active",
        summary: { title: "Service", category: "services.test", tags: [] },
      }] });
      const indexHash = sha256Hex(raw);
      const signature = Buffer.from(await ed25519Sign(Buffer.from(wellKnownWithdrawalMessage(source, indexHash)),
        privateKeyFromSeed(seeds[1]))).toString("base64url");
      const agent = await crawlDomain(source, { validateUrl: async (url) => ({ url: new URL(url), ip: "203.0.113.1" }), fetchJson: async (url) => {
        const document = url.endsWith("agent.json") ? JSON.stringify({ dacs: { dacsVersion: "1", listings: {
          indexUrl: `${source}/listings.json`, indexHash, ...(authenticated ? { publisherSignature: signature } : {}),
        } } }) : raw;
        return { raw: document, body: JSON.parse(document) };
      } });
      assert.ok(!("error" in agent));
      assert.equal(agent.withdrawalAuthenticated, authenticated);
      return crawling([agent], false);
    };
    const publicCount = async () => (await (await listings(new NextRequest("https://directory.example/api/dacs/listings"))).json()).total;
    const notice = () => diagnostics().find((item) => item.locator === locators.listing);
    await reindexWith(await crawl(true, 100, "f".repeat(64)));
    const before = notice();
    assert.equal(before?.publicNotice, true);
    assert.equal(await publicCount(), 0);
    if (mode === "operator-pinned") process.env.DACS_WITHDRAWAL_SOURCE_PINS = JSON.stringify({ [source]: dids[1] });
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        await reindexWith(await crawl(false, 101, artifactHash(listing, "listing")));
        assert.deepEqual(notice(), before, "unsigned carriage cannot reconcile an authenticated rejection");
        assert.equal(await publicCount(), 0);
      }
      await reindexWith(await crawl(true, 102, artifactHash(listing, "listing")));
      assert.equal(notice(), undefined);
      assert.equal(await publicCount(), 1);
    } finally {
      delete process.env.DACS_WITHDRAWAL_SOURCE_PINS;
    }
  });
}

for (const mode of ["index-now", "failed crawl"] as const) {
  test(`a signed owner pointer removal clears its notice during ${mode} and retains crawl history`, async () => {
    const { locators } = await publicListingVector("removed-owner-pointer", 830);
    const signRegistration = (anchors: string[], signer = 1) => {
      const stored = registration(anchors);
      const message = registrationMessage(stored, 1);
      const signature = Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seeds[signer]))).toString("hex");
      return { ...stored, ownerSignature: { message, signedAt: 1, signature } };
    };
    saveDomains([domain]);
    saveRegistrations([signRegistration([locators.listing])]);
    await reindexWith(crawling([], false), `0x${"f".repeat(64)}`);
    const before = diagnostics().find((item) => item.locator === locators.listing);
    assert.equal(before?.code, "OWNER_CLAIM_BINDING");
    assert.equal(before?.publicNotice, true);
    recordListingRejection(rejectedAt("7"), dids[1], "LISTING_SIGNATURE_INVALID");
    recordListingRejection(rejectedAt("8"), dids[1], "DECLARED_CONTENT_HASH_MISMATCH", { listingId: "crawl-hash", listingVersion: 1 }, true);
    const crawlHistory = diagnostics().filter((item) => [rejectedAt("7"), rejectedAt("8")].includes(item.locator));
    const run = async () => {
      if (mode === "failed crawl") await reindexWith(crawling([], true));
      else await withChainFetch(async () => {
        const response = await indexNow(new NextRequest("https://directory.example/api/dacs/index-now",
          { method: "POST", body: JSON.stringify({ claim: dids[1] }) }));
        assert.equal(response.status, 200);
      });
    };
    for (const replacement of [registration([]), signRegistration([], 0)]) {
      saveRegistrations([replacement]);
      await run();
      assert.deepEqual(diagnostics().find((item) => item.locator === locators.listing), before,
        "an unverified replacement cannot prove the owner removed a pointer");
    }
    saveRegistrations([signRegistration([])]);
    for (let repeat = 0; repeat < 2; repeat++) {
      await run();
      assert.equal(loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1])?.ownerRegistered, true);
      assert.equal(diagnostics().some((item) => item.locator === locators.listing), false,
        "the authenticated owner removal clears the pointer notice on a partial pass");
      assert.deepEqual(diagnostics().filter((item) => [rejectedAt("7"), rejectedAt("8")].includes(item.locator)), crawlHistory);
    }
  });
}

for (const mirrorHash of ["matching", "different"] as const) {
  test(`an unsigned ${mirrorHash} mirror preserves a publisher rejection across restart and repeated crawls`, async () => {
    const { listing, locators } = await publicListingVector(`unsigned-mirror-${mirrorHash}`, 900);
    const source = domain;
    const mirror = `https://mirror-${mirrorHash}.example`;
    const actualHash = artifactHash(listing, "listing");
    saveDomains([source, mirror]);
    saveRegistrations([]);
    const crawlIndex = async (origin: string, hash: string, authenticated: boolean, generatedAt: number) => {
      const raw = JSON.stringify({ indexVersion: "1", generatedAt, seller: dids[1], listings: [{
        listingId: "svc", version: 1, contentHash: hash,
        anchor: { kind: "storage-program", locator: locators.listing }, status: "active",
        summary: { title: "Service", category: "services.test", tags: [] },
      }] });
      const indexHash = sha256Hex(raw);
      const publisherSignature = Buffer.from(ed25519Sign(Buffer.from(wellKnownWithdrawalMessage(origin, indexHash)),
        privateKeyFromSeed(seeds[1]))).toString("base64url");
      const agent = await crawlDomain(origin, {
        validateUrl: async (url) => ({ url: new URL(url), ip: "203.0.113.1" }),
        fetchJson: async (url) => {
          const document = url.endsWith("agent.json") ? JSON.stringify({ dacs: { dacsVersion: "1", listings: {
            indexUrl: `${origin}/listings.json`, indexHash, ...(authenticated ? { publisherSignature } : {}),
          } } }) : raw;
          return { raw: document, body: JSON.parse(document) };
        },
      });
      assert.ok(!("error" in agent));
      assert.equal(agent.withdrawalAuthenticated, authenticated);
      return agent;
    };
    await reindexWith(crawling([await crawlIndex(source, "f".repeat(64), true, 100)], false));
    const before = diagnostics().find((item) => item.locator === locators.listing);
    assert.equal(before?.publicNotice, true);
    const unsigned = await crawlIndex(mirror, mirrorHash === "matching" ? actualHash : "e".repeat(64), false, 101);
    const restarted = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { NextRequest } from "next/server";
      import { reindexAll } from "./src/catalog/reindexCore.ts";
      import { indexerDiagnostics } from "./src/catalog/store.ts";
      import { GET } from "./app/api/dacs/listings/route.ts";
      const { listing, anchor, owner, unsigned, source, before } = JSON.parse(readFileSync(0, "utf8"));
      const notice = () => indexerDiagnostics().listingRejectionDiagnostics.items.find(item => item.locator === anchor);
      assert.deepEqual(notice(), before, "the authenticated notice survives restart");
      globalThis.fetch = async (input, init) => init?.body ? Response.json({ result: 200, response: [] })
        : String(input).endsWith(anchor) ? Response.json({ success: true, owner, data: listing })
        : new Response(null, { status: 404 });
      for (let repeat = 0; repeat < 2; repeat++) {
        await reindexAll({ log: () => {}, resolveIdentities: async () => { throw new Error("offline"); },
          crawlWellKnown: async () => ({ agents: [unsigned], errors: [{ domain: source, error: "offline" }] }) });
        assert.deepEqual(notice(), before, "unsigned carriage cannot replace or clear the authenticated notice");
        assert.equal((await (await GET(new NextRequest("https://directory.example/api/dacs/listings"))).json()).total, 0);
      }
    `], { encoding: "utf8", timeout: 30_000, input: JSON.stringify({ listing, anchor: locators.listing, owner, unsigned, source, before }) });
    assert.equal(restarted.status, 0, restarted.stderr || String(restarted.error));
    const correction = await crawlIndex(source, actualHash, true, 102);
    await reindexWith(async () => ({ agents: [correction], errors: [{ domain: mirror, error: "offline" }] }));
    assert.equal(diagnostics().some((item) => item.locator === locators.listing), false);
    const response = await listings(new NextRequest("https://directory.example/api/dacs/listings"));
    assert.equal((await response.json()).total, 1, "an authenticated matching declaration releases the hold");
  });
}
