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
import { revocationLogicalAddress } from "../src/catalog/listingVerification.js";
import { reindexAll } from "../src/catalog/reindexCore.js";
import { registrationMessage } from "../src/catalog/registrationSig.js";
import {
  indexerDiagnostics, loadCatalog, recordListingRejection, recordWellKnownWithdrawalCheck, savedListingDeclarations,
  saveDomains, saveRegistrations,
} from "../src/catalog/store.js";
import { crawlDomain, wellKnownWithdrawalMessage, type WellKnownAgent } from "../src/catalog/wellknown.js";
import { sha256Hex } from "../src/catalog/canonical.js";
import { dids, maps, seeds, sign, vector } from "./fixtures/current-evidence.js";
import { pinnedNodeAnswer } from "./fixtures/pinned-node.js";

const owner = `0x${dids[1].slice(-64)}`;
const foreignOwner = `0x${"f".repeat(64)}`;
const wrongHash = "f".repeat(64);
const departedSeller = `did:demos:agent:${"d1".repeat(32)}`;
const crawlOnlySeller = `did:demos:agent:${"c2".repeat(32)}`;
let domain = "https://seller.example";
// Source rows persist across tests, so every test uses its own origins.
test.beforeEach((context) => { domain = `https://${sha256Hex(context.name).slice(0, 16)}.example`; });
const origin = (tag: string) => `https://${tag}-${sha256Hex(domain).slice(0, 12)}.example`;
const rejectedAt = (digit: string) => `stor-${digit.repeat(40)}`;

const registration = (listingAnchors: string[], displayName = "seller") =>
  ({ primaryClaim: dids[1], displayName, listingAnchors, deals: [] });
const ownerSigned = (anchors: string[], { signer = 1, displayName = "seller" } = {}) => {
  const stored = registration(anchors, displayName);
  const message = registrationMessage(stored, 1);
  const signature = Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seeds[signer]))).toString("hex");
  return { ...stored, ownerSignature: { message, signedAt: 1, signature } };
};

/** A valid Listing of dids[1] that the chain serves at its anchor. */
async function publicListingVector(jobId: string, offset: number) {
  const fixture = await vector(jobId, offset);
  const scope = signedScope(fixture.listing, "listing");
  scope.fixtureCase = jobId;
  scope.acceptedRails = [{ railId: "demos-native:DEM" }];
  scope.pipeline = [
    { kind: "negotiate-fixed-price" }, { kind: "commit-agreement" },
    { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-attested-payload" },
  ];
  const listing = { ...scope, signature: await sign(scope, "listing", 1) };
  maps.set(fixture.locators.listing, listing);
  return { listing, locators: fixture.locators, hash: artifactHash(listing, "listing") };
}

interface IndexOptions { generatedAt?: number; signer?: number; signed?: boolean; name?: string; revokedMarker?: string }

/** Crawl `source`'s hosted listings index declaring `entries` (anchor → hash), publisher-signed unless `signed` is false. */
async function hostedIndex(source: string, entries: Record<string, string>,
  { generatedAt = 100, signer = 1, signed = true, name, revokedMarker }: IndexOptions = {}): Promise<WellKnownAgent> {
  const seller = dids[signer];
  const raw = JSON.stringify({ indexVersion: "1", generatedAt, seller, listings: Object.entries(entries).map(([locator, contentHash]) => ({
    listingId: "svc", version: 1, contentHash, anchor: { kind: "storage-program", locator },
    summary: { title: "Service", category: "services.test", tags: [] },
    ...(revokedMarker ? { status: "revoked", revocation: {
      sellerPrimaryClaim: seller, listingId: "svc", listingVersion: 1, listingContentHash: contentHash,
      logicalAddress: revocationLogicalAddress(seller, "svc", 1),
      markerAnchor: { kind: "storage-program", locator: revokedMarker }, markerContentHash: "e".repeat(64),
    } } : { status: "active" }),
  })) });
  const indexHash = sha256Hex(raw);
  const publisherSignature = Buffer.from(ed25519Sign(Buffer.from(wellKnownWithdrawalMessage(source, indexHash)),
    privateKeyFromSeed(seeds[signer]))).toString("base64url");
  const agent = await crawlDomain(source, {
    validateUrl: async (url) => ({ url: new URL(url), ip: "203.0.113.1" }),
    fetchJson: async (url) => {
      const document = url.endsWith("agent.json") ? JSON.stringify({ ...(name ? { name } : {}), dacs: { dacsVersion: "1", listings: {
        indexUrl: `${source}/listings.json`, indexHash, ...(signed ? { publisherSignature } : {}),
      } } }) : raw;
      return { raw: document, body: JSON.parse(document) };
    },
  });
  assert.ok(!("error" in agent));
  assert.equal(agent.withdrawalAuthenticated, signed);
  return agent;
}

interface ChainOptions { anchorOwner?: string; unread?: string[]; crashAt?: string }

async function withChainFetch<T>(run: () => Promise<T>, { anchorOwner = owner, unread = [], crashAt }: ChainOptions = {}): Promise<T> {
  const originalFetch = globalThis.fetch;
  // No deployment is injected: reindexAll and index-now read the pinned chain from this node.
  globalThis.fetch = async (input, init) => {
    if (init?.body) return pinnedNodeAnswer(init.body) ?? Response.json({ result: 200, response: [] });
    const at = String(input).split("/").pop() ?? "";
    if (at === crashAt) {
      // A crash inside the read, which the reader's own error handling never sees.
      const response = new Response(null);
      Object.defineProperty(response, "status", { get() { throw new Error("crashed"); } });
      return response;
    }
    if (unread.includes(at)) return new Response(null, { status: 503 });
    const data = maps.get(at);
    return data ? Response.json({ success: true, owner: anchorOwner, programName: "dacs:test", data }) : new Response(null, { status: 404 });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const reindexWith = ({ agents = [], offline = [], ...chain }: { agents?: WellKnownAgent[]; offline?: string[] } & ChainOptions = {}) =>
  withChainFetch(() => reindexAll({ log: () => {}, resolveIdentities: async () => { throw new Error("offline"); },
    crawlWellKnown: async () => ({ agents, errors: offline.map((source) => ({ domain: source, error: "offline" })) }) }), chain);

const indexNowFor = (chain: ChainOptions = {}) => withChainFetch(async () => {
  const response = await indexNow(new NextRequest("https://directory.example/api/dacs/index-now",
    { method: "POST", body: JSON.stringify({ claim: dids[1] }) }));
  assert.equal(response.status, 200);
  return await response.json() as { listings: number };
}, chain);

/** Run `body` in a fresh process on the same data directory; the chain serves `input.listing` at `input.anchor`. */
const freshProcess = (body: string, input: Record<string, unknown>) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
  import assert from "node:assert/strict";
  import { readFileSync } from "node:fs";
  import { NextRequest } from "next/server";
  import { POST as indexNow } from "./app/api/dacs/index-now/route.ts";
  import { reindexAll } from "./src/catalog/reindexCore.ts";
  import { indexerDiagnostics } from "./src/catalog/store.ts";
  import { pinnedNodeAnswer } from "./test/fixtures/pinned-node.ts";
  const input = JSON.parse(readFileSync(0, "utf8"));
  const notice = () => indexerDiagnostics().listingRejectionDiagnostics.items.find((item) => item.locator === input.anchor);
  const indexNowFor = async () => (await indexNow(new NextRequest("https://directory.example/api/dacs/index-now",
    { method: "POST", body: JSON.stringify({ claim: input.seller }) }))).json();
  const serve = async (url, init) => init?.body ? pinnedNodeAnswer(init.body) ?? Response.json({ result: 200, response: [] })
    : String(url).endsWith(input.anchor) ? Response.json({ success: true, owner: input.owner, data: input.listing })
    : new Response(null, { status: 404 });
  globalThis.fetch = serve;
  const reindexWith = (agents, offline = []) => reindexAll({ log: () => {}, resolveIdentities: async () => ({}),
    crawlWellKnown: async () => ({ agents, errors: offline.map((domain) => ({ domain, error: "offline" })) }) });
  ${body}
`], { encoding: "utf8", timeout: 30_000, input: JSON.stringify({ owner, seller: dids[1], ...input }) });
const assertExitedCleanly = (run: ReturnType<typeof freshProcess>) => assert.equal(run.status, 0, run.stderr || String(run.error));

const diagnostics = () => indexerDiagnostics().listingRejectionDiagnostics.items;
const notice = (anchor: string) => diagnostics().find((item) => item.locator === anchor);
const sellerRecord = () => loadCatalog().sellers.find((seller) => seller.primaryClaim === dids[1]);
const publicListingCount = async () => (await (await listings(new NextRequest("https://directory.example/api/dacs/listings"))).json()).total;

for (const signed of [true, false]) {
  test(`an unsigned agent.json name ${signed ? "never renames an owner-signed seller" : "still names an unsigned seller"}`, async () => {
    const { locators } = await publicListingVector(`badge-${signed}`, 100);
    saveDomains([domain]);
    saveRegistrations([signed ? ownerSigned([locators.listing], { displayName: "agent alpha" }) : registration([locators.listing], "agent alpha")]);
    await reindexWith({ agents: [await hostedIndex(domain, {}, { signed: false, name: "Impostor Bank Ltd" })] });
    const seller = sellerRecord();
    assert.equal(seller?.ownerRegistered, signed);
    assert.equal(seller?.displayName, signed ? "agent alpha" : "Impostor Bank Ltd", "the badge stands only next to the signed name");
    assert.deepEqual(seller?.listings.map((listing) => listing.seller.displayName), [seller?.displayName]);
  });
}

for (const crash of ["thrown", "killed"] as const) {
  test(`a crash (${crash}) at the marker read after accepting a newer signed index keeps that index's declarations`, async () => {
    const { listing, locators } = await publicListingVector(`crash-${crash}`, 150);
    saveDomains([domain]);
    saveRegistrations([registration([locators.listing])]);
    await reindexWith({ agents: [await hostedIndex(domain, {})] });
    assert.equal(await publicListingCount(), 1);
    // The carried binding makes the pass read the anchor after source ordering accepts index 101.
    const newer = await hostedIndex(domain, { [locators.listing]: wrongHash }, { generatedAt: 101, revokedMarker: rejectedAt("e") });
    if (crash === "thrown") await assert.rejects(reindexWith({ agents: [newer], crashAt: locators.listing }), /crashed/);
    else {
      const run = freshProcess(`
        globalThis.fetch = async (url, init) => { if (String(url).endsWith(input.anchor)) process.kill(process.pid, "SIGKILL"); return serve(url, init); };
        await reindexWith([input.newer]);
      `, { listing, anchor: locators.listing, newer });
      assert.equal(run.signal, "SIGKILL", run.stderr);
    }
    assert.equal((await indexNowFor()).listings, 0);
    assert.equal(notice(locators.listing)?.code, "DECLARED_CONTENT_HASH_MISMATCH");
    assert.equal(notice(locators.listing)?.publicNotice, true);
  });
}

for (const prior of ["no", "an owner"] as const) {
  test(`index-now applies saved signed declarations after an unread pass, also in a fresh process (${prior} notice before)`, async () => {
    const { listing, locators, hash } = await publicListingVector(`immediate-${prior}`, 200);
    const peer = origin("peer");
    saveDomains([peer, domain]);
    saveRegistrations([ownerSigned([locators.listing])]);
    if (prior === "an owner") await reindexWith({ anchorOwner: foreignOwner });
    const sources = [await hostedIndex(peer, { [locators.listing]: hash }), await hostedIndex(domain, { [locators.listing]: wrongHash })];
    await reindexWith({ agents: sources, unread: [locators.listing] });
    assert.equal(notice(locators.listing)?.code, prior === "an owner" ? "OWNER_CLAIM_BINDING" : undefined);
    assertExitedCleanly(freshProcess(`
      for (let repeat = 0; repeat < 2; repeat++) {
        assert.equal((await indexNowFor()).listings, 0);
        assert.equal(notice()?.code, "DECLARED_CONTENT_HASH_MISMATCH");
        assert.equal(notice()?.publicNotice, true);
      }
    `, { listing, anchor: locators.listing }));
    assert.equal((await indexNowFor()).listings, 0);
    assert.equal(await publicListingCount(), 0);
    await reindexWith({ agents: [sources[0], await hostedIndex(domain, { [locators.listing]: hash }, { generatedAt: 101 })] });
    assert.equal(await publicListingCount(), 1, "a signed correction releases the hold");
  });
}

test("a signed source saved before declarations were kept holds an existing hash notice but never creates one", async () => {
  const { locators, hash } = await publicListingVector("older-source", 250);
  const peer = origin("peer");
  saveDomains([domain, peer]);
  saveRegistrations([registration([locators.listing])]);
  recordWellKnownWithdrawalCheck(domain, dids[1], [], [], { generatedAt: 100, hash: "a".repeat(64) });
  await reindexWith();
  assert.equal(notice(locators.listing), undefined);
  assert.equal(await publicListingCount(), 1);
  recordListingRejection(locators.listing, dids[1], "DECLARED_CONTENT_HASH_MISMATCH", { listingId: "svc", listingVersion: 1 }, true);
  const before = notice(locators.listing);
  const matching = await hostedIndex(peer, { [locators.listing]: hash });
  await reindexWith({ agents: [matching], offline: [domain] });
  assert.deepEqual(notice(locators.listing), before, "a matching peer cannot settle a source whose declarations are unknown");
  assert.equal(await publicListingCount(), 0);
  await reindexWith({ agents: [matching, await hostedIndex(domain, { [locators.listing]: hash }, { generatedAt: 101 })] });
  assert.equal(notice(locators.listing), undefined);
  assert.equal(await publicListingCount(), 1);
});

for (const change of ["correction", "omission"] as const) {
  for (const pointer of ["registered", "crawl-only"] as const) {
    test(`a signed ${change} clears a ${pointer} pointer's hash notice while an unrelated domain is offline`, async () => {
      const { locators, hash } = await publicListingVector(`signed-${change}-${pointer}`, 300);
      const unrelated = origin("unrelated");
      saveDomains([domain, unrelated]);
      saveRegistrations(pointer === "registered" ? [registration([locators.listing])] : []);
      await reindexWith({ agents: [await hostedIndex(domain, { [locators.listing]: wrongHash })] });
      assert.equal(notice(locators.listing)?.publicNotice, true);
      const corrected = await hostedIndex(domain, change === "correction" ? { [locators.listing]: hash } : {}, { generatedAt: 101 });
      await reindexWith({ agents: [corrected], offline: [unrelated] });
      assert.equal(notice(locators.listing), undefined);
      assert.equal(await publicListingCount(), change === "omission" && pointer === "crawl-only" ? 0 : 1);
    });
  }
}

test("another seller's signed index on the same domain keeps the first seller's declaration and notice", async () => {
  const { locators } = await publicListingVector("domain-seller-change", 350);
  saveDomains([domain]);
  saveRegistrations([ownerSigned([])]);
  await reindexWith({ agents: [await hostedIndex(domain, { [locators.listing]: wrongHash })] });
  const before = notice(locators.listing);
  assert.equal(before?.publicNotice, true);
  await reindexWith({ agents: [await hostedIndex(domain, {}, { generatedAt: 101, signer: 0 })] });
  assert.deepEqual(notice(locators.listing), before, "the other seller neither corrected nor withdrew this declaration");
});

for (const peerHash of ["matching", "conflicting"] as const) {
  test(`a signed omission ${peerHash === "matching" ? "clears" : "keeps"} a hash notice while a ${peerHash} peer is unread`, async () => {
    const { locators, hash } = await publicListingVector(`omission-${peerHash}-peer`, 400);
    const peer = origin("peer");
    saveDomains([domain, peer]);
    saveRegistrations([registration([locators.listing])]);
    await reindexWith({ agents: [await hostedIndex(domain, { [locators.listing]: wrongHash }),
      await hostedIndex(peer, { [locators.listing]: peerHash === "matching" ? hash : "e".repeat(64) })] });
    const before = notice(locators.listing);
    await reindexWith({ agents: [await hostedIndex(domain, {}, { generatedAt: 101 })], offline: [peer] });
    if (peerHash === "matching") assert.equal(notice(locators.listing), undefined, "the unread peer's saved declaration matches");
    else assert.deepEqual(notice(locators.listing), before, "the unread peer's saved declaration still differs");
    assert.equal(await publicListingCount(), 0, "the unread signed peer still holds the offer for its withdrawal check");
  });
}

test("an operator-pinned index is accepted after a signed one and carries its declarations forward", () => {
  saveDomains([domain]);
  const at = rejectedAt("9");
  assert.ok(recordWellKnownWithdrawalCheck(domain, dids[1], [], [], { generatedAt: 100, hash: "a".repeat(64) }, [], "publisher-signature", { [at]: wrongHash }));
  assert.ok(recordWellKnownWithdrawalCheck(domain, dids[1], [], [], { generatedAt: 101, hash: "b".repeat(64) }, [], "operator-pin", { [at]: "e".repeat(64) }));
  assert.deepEqual(savedListingDeclarations(dids[1]), { sources: [{ [at]: wrongHash }], unknown: false });
  assert.equal(recordWellKnownWithdrawalCheck(domain, dids[1], [], [], { generatedAt: 100, hash: "c".repeat(64) }, [], "publisher-signature", {}), false);
  assert.deepEqual(savedListingDeclarations(dids[1]).sources, [{ [at]: wrongHash }], "a refused index replaces nothing");
});

for (const mode of ["registered", "crawl-only", "operator-pinned"] as const) {
  test(`a signed-to-unsigned ${mode} source keeps its hash notice until a signed correction`, async () => {
    const { locators, hash } = await publicListingVector(`authentication-loss-${mode}`, 450);
    saveDomains([domain]);
    saveRegistrations(mode === "crawl-only" ? [] : [registration([locators.listing])]);
    await reindexWith({ agents: [await hostedIndex(domain, { [locators.listing]: wrongHash })] });
    const before = notice(locators.listing);
    assert.equal(before?.publicNotice, true);
    if (mode === "operator-pinned") process.env.DACS_WITHDRAWAL_SOURCE_PINS = JSON.stringify({ [domain]: dids[1] });
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        await reindexWith({ agents: [await hostedIndex(domain, { [locators.listing]: hash }, { generatedAt: 101 + repeat, signed: false })] });
        assert.deepEqual(notice(locators.listing), before, "unsigned carriage cannot reconcile a signed declaration");
        assert.equal(await publicListingCount(), 0);
      }
      await reindexWith({ agents: [await hostedIndex(domain, { [locators.listing]: hash }, { generatedAt: 103 })] });
      assert.equal(notice(locators.listing), undefined);
      assert.equal(await publicListingCount(), 1);
    } finally {
      delete process.env.DACS_WITHDRAWAL_SOURCE_PINS;
    }
  });
}

for (const state of ["failed", "rollback", "equal-time conflict", "unsigned"] as const) {
  test(`a matching signed peer cannot erase the declaration of a ${state} source`, async () => {
    const { locators, hash } = await publicListingVector(`unresolved-source-${state}`, 1000);
    const peer = origin("peer");
    saveDomains([domain, peer]);
    saveRegistrations([registration([locators.listing])]);
    await reindexWith({ agents: [await hostedIndex(domain, { [locators.listing]: wrongHash })] });
    const matching = await hostedIndex(peer, { [locators.listing]: hash });
    const replacement = await hostedIndex(domain, { [locators.listing]: hash },
      { generatedAt: state === "rollback" ? 99 : state === "unsigned" ? 101 : 100, signed: state !== "unsigned" });
    for (let repeat = 0; repeat < 2; repeat++) {
      await reindexWith(state === "failed" ? { agents: [matching], offline: [domain] } : { agents: [replacement, matching] });
      assert.equal(notice(locators.listing)?.code, "DECLARED_CONTENT_HASH_MISMATCH");
      assert.equal(notice(locators.listing)?.publicNotice, true);
      assert.equal(await publicListingCount(), 0);
    }
    await reindexWith({ agents: [await hostedIndex(domain, {}, { generatedAt: 102 }), matching] });
    assert.equal(notice(locators.listing), undefined, "a signed omission releases only this source's declaration");
    assert.equal(await publicListingCount(), 1);
  });
}

for (const pointer of ["registered", "crawl-only"] as const) {
  test(`signed conflicting domains reject a ${pointer} listing in either order until every source agrees`, async () => {
    const { locators, hash } = await publicListingVector(`conflicting-domains-${pointer}`, 1100);
    const mirror = origin("mirror");
    saveDomains([domain, mirror]);
    saveRegistrations(pointer === "registered" ? [registration([locators.listing])] : []);
    const wrong = await hostedIndex(domain, { [locators.listing]: wrongHash });
    const matching = await hostedIndex(mirror, { [locators.listing]: hash });
    for (const agents of [[wrong, matching], [matching, wrong]]) {
      await reindexWith({ agents });
      assert.equal(notice(locators.listing)?.code, "DECLARED_CONTENT_HASH_MISMATCH");
      assert.equal(notice(locators.listing)?.publicNotice, true);
      assert.equal(await publicListingCount(), 0);
    }
    await reindexWith({ agents: [await hostedIndex(domain, { [locators.listing]: hash }, { generatedAt: 101 }), matching] });
    assert.equal(notice(locators.listing), undefined);
    assert.equal(await publicListingCount(), 1);
  });
}

test("signed declarations count only for their seller, anchor and configured origin", async () => {
  const first = await publicListingVector("isolated-source-first", 1300);
  const second = await publicListingVector("isolated-source-second", 1400);
  maps.set(first.locators.listing, first.listing);
  const [peer, foreign, retired] = [origin("peer"), origin("foreign"), origin("retired")];
  saveDomains([domain, peer, foreign, retired]);
  saveRegistrations([registration([first.locators.listing, second.locators.listing])]);
  await reindexWith({ agents: [
    await hostedIndex(domain, { [first.locators.listing]: first.hash }),
    await hostedIndex(peer, { [second.locators.listing]: wrongHash }),
    await hostedIndex(foreign, { [first.locators.listing]: wrongHash }, { signer: 0 }),
    await hostedIndex(retired, { [first.locators.listing]: wrongHash }),
  ] });
  assert.deepEqual(sellerRecord()?.listings, [], "a configured origin's conflicting declaration counts");
  saveDomains([domain, peer, foreign]);
  assert.equal((await indexNowFor()).listings, 1, "a retired origin's declaration no longer counts");
  assert.deepEqual(sellerRecord()?.listings.map((item) => item.anchor.locator), [first.locators.listing]);
  assert.equal(notice(first.locators.listing)?.publicNotice, false, "only the other seller's own pointer is rejected, privately");
  assert.equal(notice(second.locators.listing)?.publicNotice, true);
});

test("an unauthenticated declared hash neither rejects a registered anchor nor creates a notice", async () => {
  const { locators } = await publicListingVector("unsigned-declared-hash-job", 1500);
  saveDomains([domain]);
  saveRegistrations([registration([locators.listing])]);
  await reindexWith({ agents: [await hostedIndex(domain, { [locators.listing]: wrongHash }, { signed: false })] });
  assert.equal(notice(locators.listing), undefined);
  process.env.DACS_WITHDRAWAL_SOURCE_PINS = JSON.stringify({ [domain]: dids[1] });
  try {
    await reindexWith({ agents: [await hostedIndex(domain, { [locators.listing]: wrongHash }, { signed: false, generatedAt: 101 })] });
  } finally {
    delete process.env.DACS_WITHDRAWAL_SOURCE_PINS;
  }
  assert.equal(notice(locators.listing), undefined, "an operator pin is not a publisher declaration");
  assert.equal(await publicListingCount(), 1);
});

for (const mode of ["index-now", "failed crawl"] as const) {
  test(`an unsigned crawl mismatch cannot hold an owner-signed registration during ${mode}`, async () => {
    const { locators } = await publicListingVector("unsigned-hash-job", 1600);
    saveDomains([domain]);
    saveRegistrations([]);
    await reindexWith({ agents: [await hostedIndex(domain, { [locators.listing]: wrongHash }, { signed: false })] });
    assert.equal(notice(locators.listing)?.code, "DECLARED_CONTENT_HASH_MISMATCH");
    assert.equal(notice(locators.listing)?.publicNotice, false);
    saveRegistrations([ownerSigned([locators.listing])]);
    if (mode === "index-now") assert.equal((await indexNowFor()).listings, 1);
    else await reindexWith({ offline: [domain] });
    assert.equal(sellerRecord()?.ownerRegistered, true);
    assert.equal(await publicListingCount(), 1);
  });
}

test("a failed crawl keeps rejections of sellers only the crawl discovers; a complete pass removes departed sellers", async () => {
  const { locators } = await publicListingVector("prune-job", 1700);
  saveDomains([domain]);
  saveRegistrations([registration([locators.listing])]);
  recordListingRejection(rejectedAt("1"), crawlOnlySeller, "LISTING_SIGNATURE_INVALID");
  recordListingRejection(rejectedAt("2"), departedSeller, "LISTING_SIGNATURE_INVALID");
  recordListingRejection(rejectedAt("4"), dids[1], "LISTING_SIGNATURE_INVALID");
  const remaining = () => diagnostics().map((item) => item.locator).filter((at) => ["1", "2", "4"].map(rejectedAt).includes(at)).sort();
  await reindexWith({ offline: [domain] });
  assert.deepEqual(remaining(), ["1", "2", "4"].map(rejectedAt), "an incomplete discovery pass proves no removal");
  await reindexWith();
  assert.deepEqual(remaining(), [], "a complete pass removes pointers no registration lists and sellers that left");
});

test("owner notices are public only for pointers the owner signed, whatever the crawl adds", async () => {
  const { locators } = await publicListingVector("owner-signed-job", 1800);
  saveRegistrations([ownerSigned([locators.listing])]);
  saveDomains([domain]);
  await reindexWith({ agents: [await hostedIndex(domain, { [rejectedAt("5")]: wrongHash }, { signed: false })], anchorOwner: foreignOwner });
  assert.equal(notice(locators.listing)?.code, "OWNER_CLAIM_BINDING");
  assert.equal(notice(locators.listing)?.publicNotice, true, "the signature is checked on the registration as the owner signed it");
  saveRegistrations([ownerSigned([])]);
  await reindexWith({ agents: [await hostedIndex(domain, { [locators.listing]: wrongHash }, { signed: false, generatedAt: 101 })], anchorOwner: foreignOwner });
  assert.equal(notice(locators.listing)?.code, "OWNER_CLAIM_BINDING");
  assert.equal(notice(locators.listing)?.publicNotice, false, "the owner never signed this crawl pointer");
});

test("index-now keeps a declared-hash notice and crawl-derived history it cannot rediscover", async () => {
  const { locators } = await publicListingVector("immediate-job", 1900);
  saveDomains([domain]);
  saveRegistrations([registration([locators.listing])]);
  await reindexWith({ agents: [await hostedIndex(domain, { [locators.listing]: wrongHash })] });
  recordListingRejection(rejectedAt("6"), dids[1], "LISTING_SIGNATURE_INVALID");
  assert.equal((await indexNowFor()).listings, 0);
  assert.equal(notice(locators.listing)?.publicNotice, true);
  assert.ok(notice(rejectedAt("6")), "a pointer only the crawl lists is not removed by a pass without a crawl");
});

test("unreadable and unverifiable reads keep a declared-hash notice", async () => {
  const { listing, locators } = await publicListingVector("interleaved-failure-job", 2000);
  saveDomains([domain]);
  saveRegistrations([registration([locators.listing])]);
  await reindexWith({ agents: [await hostedIndex(domain, { [locators.listing]: wrongHash })] });
  const before = notice(locators.listing);
  assert.equal(before?.code, "DECLARED_CONTENT_HASH_MISMATCH");
  await reindexWith({ offline: [domain], unread: [locators.listing] });
  assert.deepEqual(notice(locators.listing), before, "an unread anchor does not discharge the declaration");
  maps.set(locators.listing, { ...listing, signature: { ...listing.signature, value: "invalid" } });
  await reindexWith({ offline: [domain] });
  assert.deepEqual(notice(locators.listing), before, "invalid bytes do not discharge the declaration");
  maps.set(locators.listing, listing);
  assert.equal((await indexNowFor()).listings, 0);
});

for (const mode of ["index-now", "failed crawl"] as const) {
  test(`a signed owner pointer removal clears its notice during ${mode} and keeps crawl history`, async () => {
    const { locators } = await publicListingVector("removed-owner-pointer", 2100);
    saveDomains([domain]);
    saveRegistrations([ownerSigned([locators.listing])]);
    await reindexWith({ anchorOwner: foreignOwner });
    const before = notice(locators.listing);
    assert.equal(before?.publicNotice, true);
    recordWellKnownWithdrawalCheck(domain, dids[1], [], [], { generatedAt: 100, hash: "a".repeat(64) }, [], "publisher-signature",
      { [rejectedAt("8")]: wrongHash });
    recordListingRejection(rejectedAt("7"), dids[1], "LISTING_SIGNATURE_INVALID");
    recordListingRejection(rejectedAt("8"), dids[1], "DECLARED_CONTENT_HASH_MISMATCH", { listingId: "crawl-hash", listingVersion: 1 }, true);
    const crawlHistory = diagnostics().filter((item) => [rejectedAt("7"), rejectedAt("8")].includes(item.locator));
    const run = () => mode === "failed crawl" ? reindexWith({ offline: [domain] }) : indexNowFor();
    for (const replacement of [registration([]), ownerSigned([], { signer: 0 })]) {
      saveRegistrations([replacement]);
      await run();
      assert.deepEqual(notice(locators.listing), before, "an unverified replacement cannot prove the owner removed a pointer");
    }
    saveRegistrations([ownerSigned([])]);
    for (let repeat = 0; repeat < 2; repeat++) {
      await run();
      assert.equal(sellerRecord()?.ownerRegistered, true);
      assert.equal(notice(locators.listing), undefined, "the signed removal clears the owner notice on a partial pass");
      assert.deepEqual(diagnostics().filter((item) => [rejectedAt("7"), rejectedAt("8")].includes(item.locator)), crawlHistory);
    }
  });
}
