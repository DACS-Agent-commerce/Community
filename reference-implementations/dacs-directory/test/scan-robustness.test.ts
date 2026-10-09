import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import type { BundleBinding, Registration, RegisteredDeal } from "../src/catalog/types.js";

// Regression vectors from the round-2 review probes: real SDK hashes and
// signatures, and one malformed artifact per scenario followed by valid work.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-malformed-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DACS_SCAN_FINALITY_DEPTH = "0";
const store = await import("../src/catalog/store.js");
const { scanChain, readStorage } = await import("../src/catalog/scan.js");
const { verifyListing } = await import("../src/catalog/listingVerification.js");
const { logicalBundleAddress, verifyBundleBinding } = await import("../src/catalog/bundleBinding.js");
const { artifactHash, buildCurrentEvidenceGraph } = await import("../src/catalog/evidenceGraph.js");
const { deriveIdentityTier } = await import("../src/catalog/identityVerification.js");
const { indexRegistration } = await import("../src/catalog/indexer.js");
const { readAnchorRecord } = await import("../src/catalog/chain.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");

type Obj = Record<string, unknown>;
type ArtifactKind = Parameters<typeof artifactHash>[1];
const seeds = [21, 22].map((byte) => Uint8Array.from(Buffer.alloc(32, byte)));
const dids = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const [buyer, seller] = dids;
const ownerOf = (did: string) => `0x${did.slice(-64)}`;
const outsider = `did:demos:agent:${"d".repeat(64)}`;
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const offline = async (): Promise<never> => { throw new Error("identity unavailable"); };

const PREFIXES: Record<string, string> = {
  listing: "dacs-listing:v1:", agreement: "dacs-agreement:v1:", evidence: "dacs-evidence:v1:",
  bundle: "dacs-bundle:v1:", "verify-result": "dacs-verifyresult:v1:",
};
const signature = async (hash: string, prefix: string, signer: number, encoding: "hex" | "base64url" = "hex") =>
  Buffer.from(await ed25519Sign(Buffer.from(prefix + hash), privateKeyFromSeed(seeds[signer]))).toString(encoding);
const signArtifact = async (raw: Obj, kind: ArtifactKind, signer: number, party = false) => {
  const value = await signature(artifactHash(raw, kind), PREFIXES[kind], signer);
  return party ? { party: dids[signer], algorithm: "ed25519", value } : { signer: dids[signer], algorithm: "ed25519", value };
};
const ref = (at: string, raw: Obj, kind: ArtifactKind, extra: Obj = {}) => ({
  anchor: { kind: "storage-program", locator: at }, contentHash: artifactHash(raw, kind), ...extra,
});

// SDK-profile listing, revocation marker and BundleBinding signed by the seller.
const listingScope = {
  listingId: "svc", listingVersion: 1, agentId: seller, serviceId: "svc", name: "Service", description: "Description",
  claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"],
  supportedDelivery: ["deliver-attested-payload"],
};
const listing = { ...listingScope, signature: { algorithm: "ed25519", signer: seller, value: await signature(contentHash(listingScope), PREFIXES.listing, 1) } };
const verifiedListing = await verifyListing(listing);
assert.ok(verifiedListing);
const markerScope = { listingId: "svc", listingVersion: 1, listingContentHash: verifiedListing.contentHash, revokedAt: 1 };
const marker = { ...markerScope, signature: { algorithm: "ed25519", signer: seller, value: await signature(contentHash(markerScope), "dacs-revocation:v1:", 1) } };
async function signedBinding(jobId: string, role: "buyer" | "seller", nativeAddress: string, bundleContentHash: string, signer: number) {
  const scope = {
    bindingVersion: "1" as const, jobId, role, logicalAddress: logicalBundleAddress(jobId, role),
    nativeAddress, bundleContentHash, signer: dids[signer],
  };
  const value = await signature(contentHash(scope), "dacs-bundle-binding:v1:", signer, "base64url");
  return { ...scope, signature: { algorithm: "ed25519", signer: dids[signer], value } } as BundleBinding;
}
const binding = await signedBinding("job", "buyer", locator(10), "c".repeat(64), 0);

// Raw JSON text is built without JSON.stringify so deep values never touch the test's own stack.
// `deepText` cannot be serialized at all; `canonDeepText` still serializes (so it survives the
// registration store) but has no canonical form because canonicalization recurses further.
const nested = (depth: number) => "[".repeat(depth) + "0" + "]".repeat(depth);
const deepText = nested(20_000);
const canonDeepText = nested(3_000);
/** Append `"futureField": <value>` as the last top-level member. */
const withMember = (value: unknown, member: string) => JSON.stringify(value).replace(/}$/, `,"futureField":${member}}`);
/** Append `"futureField": <value>` inside the trailing `signature` object, outside the signed scope. */
const withSignatureMember = (value: unknown, member: string) => JSON.stringify(value).replace(/}}$/, `,"futureField":${member}}}`);

// Stubbed node: `storage` maps locator → raw `data` JSON text (plus optional name/owner).
interface StoredProgram { data: string; name?: string; owner?: unknown }
let storage: Record<string, StoredProgram> = {};
let transactions: Obj[] = [];
let reads = new Map<string, number>();
let reread: ((at: string, count: number) => string | undefined) | undefined;
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path.startsWith("/storage-program/")) {
    const at = path.slice("/storage-program/".length);
    const entry = storage[at];
    if (!entry) return new Response(null, { status: 404 });
    const count = (reads.get(at) ?? 0) + 1;
    reads.set(at, count);
    const owner = JSON.stringify(entry.owner ?? ownerOf(seller));
    return new Response(
      `{"success":true,"owner":${owner},"programName":${JSON.stringify(entry.name ?? "opaque")},"data":${reread?.(at, count) ?? entry.data}}`,
      { headers: { "content-type": "application/json" } },
    );
  }
  const call = JSON.parse(String(init?.body)).params?.[0];
  return Response.json({ result: 200, response: call?.message === "getTransactions" && call.data?.start === "latest" ? transactions : [] });
};
function chain(programs: Record<string, StoredProgram>, referenced: string[] = []) {
  storage = programs;
  reads = new Map();
  reread = undefined;
  // One memo transaction per locator, newest first, as the node returns them.
  transactions = referenced.map((at, index) => {
    const id = referenced.length - index;
    return { id, status: "confirmed", type: "transfer", hash: id.toString(16).padStart(64, "0"), blockNumber: id, to: "0x1", content: JSON.stringify({ memo: at }) };
  });
}
const scan = () => scanChain(null, { maxTxs: 100, sinceTxId: 0 });
function resetIndex(registrations: Registration[], generatedAt: number) {
  store.saveRegistrations(registrations);
  store.saveCatalog({ catalogVersion: "1", generatedAt, sellers: [] });
  store.saveScanState({
    schemaVersion: 9, lastSeenTxId: 0, listings: {}, deals: {}, programs: {}, revocations: {},
    verifiedRevocations: {}, bundleBindings: {}, bundleBindingOverflow: [], anchorBackfillComplete: true,
  });
}
const artifactRow = (at: string) => {
  const db = new Database(join(dataDirectory, "directory.sqlite"), { readonly: true });
  try {
    return db.prepare("SELECT kind,content_hash,anchor_time,data_json,status FROM artifacts WHERE locator = ?").get(at) as
      { kind: string; content_hash: string | null; anchor_time: number | null; data_json: string | null; status: string } | undefined;
  } finally {
    db.close();
  }
};

test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

const later: Registration = { primaryClaim: outsider, displayName: "Later", listingAnchors: [] };
const reindex = () => reindexAll({ log: () => {}, resolveIdentities: offline });
function sql(query: string) {
  const db = new Database(join(dataDirectory, "directory.sqlite"));
  try { return db.prepare(query).all() as Record<string, unknown>[]; } finally { db.close(); }
}
const scanCounts = () => sql("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1")[0];
async function agreementFor(jobId: string) {
  const scope = { agreementVersion: "1", jobId, listingRef: { listingId: "svc", version: 1, contentHash: verifiedListing!.contentHash },
    parties: [{ role: "buyer", primaryClaim: buyer }, { role: "seller", primaryClaim: seller }],
    terms: { price: { amount: "1.25", currency: "DEM" }, rail: { railId: "pay-dem" } } };
  return { ...scope, signatures: [await signArtifact(scope, "agreement", 0, true), await signArtifact(scope, "agreement", 1, true)] };
}
for (const jobId of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
  test(`unsigned reserved job ${jobId} survives two reindexes`, async () => {
    resetIndex([later], 5);
    chain({ [locator(1)]: { name: `dacs5:bundle:${jobId}`, data: '{"any":1}', owner: ownerOf(buyer) },
      [locator(2)]: { name: `dacs3:agreement:${jobId}`, data: JSON.stringify({ seller }), owner: ownerOf(buyer) } }, [locator(1), locator(2)]);
    await reindex();
    assert.ok(Object.hasOwn(store.loadScanState().deals, jobId));
    assert.equal(store.loadScanState().deals[jobId].owners.seller, "");
    transactions = [];
    await reindex();
    assert.ok(store.loadCatalog().generatedAt > 5);
    assert.ok(Object.hasOwn(store.loadScanState().deals, jobId));
    assert.ok(store.loadCatalog().sellers.some((s) => s.displayName === "Later"));
  });
  test(`signed reserved binding ${jobId} survives two reindexes and SQLite reload`, async () => {
    const valid = await signedBinding(jobId, "buyer", locator(3), "c".repeat(64), 0);
    resetIndex([later], 5);
    chain({ [locator(3)]: { data: JSON.stringify(valid) } }, [locator(3)]);
    await reindex();
    transactions = [];
    await reindex();
    assert.equal(store.loadScanState().bundleBindings?.[jobId]?.length, 1);
    assert.equal(Object.getPrototypeOf(store.loadScanState().bundleBindings), null);
    assert.ok(store.loadCatalog().sellers.some((s) => s.displayName === "Later"));
  });
}
test("signature depth sweep bounds whole values and normalizes persisted envelopes", async () => {
  const scope = { ...binding, extension: { future: "signed" } } as Obj;
  delete scope.signature;
  const extended = { ...scope, signature: { algorithm: "ed25519", signer: buyer,
    value: await signature(contentHash(scope), "dacs-bundle-binding:v1:", 0, "base64url") } };
  for (const depth of [124, 125, 126, 127, 128, 129, 4096, 4098, 4100]) {
    resetIndex([later], 6);
    chain({ [locator(4)]: { data: withSignatureMember(extended, nested(depth)) } }, [locator(4)]);
    await reindex();
    assert.ok(store.loadCatalog().generatedAt > 6);
    const saved = store.loadScanState().bundleBindings?.job ?? [];
    assert.equal(saved.length, depth <= 126 ? 1 : 0, `depth ${depth}`);
    if (saved.length) {
      assert.equal(Object.keys(saved[0].signature).length, 3);
      assert.equal(JSON.stringify(saved[0]), JSON.stringify(extended));
      assert.deepEqual(await verifyBundleBinding(saved[0]), saved[0]);
      assert.equal(contentHash(saved[0]), contentHash(extended));
    } else assert.equal(artifactRow(locator(4))?.data_json, null);
  }
});
test("streamed oversized response is cancelled before parse and later work continues", async () => {
  resetIndex([later], 7);
  chain({}, [locator(5)]);
  const original = globalThis.fetch;
  let cancelled = 0, pulls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/storage-program/')) {
      let sent = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          pulls++;
          const bytes = new Uint8Array(16_384).fill(32);
          controller.enqueue(bytes); sent += bytes.length;
          if (sent > 1_048_576 + 16_384) controller.close();
        }, cancel() { cancelled++; },
      }));
    }
    return original(input, init);
  };
  try {
    for (const read of [() => readStorage(locator(5), 1), () => readAnchorRecord(locator(5))]) {
      const before = cancelled;
      await read();
      assert.ok(cancelled > before, "both scanner and indexer cancel oversized responses");
    }
    assert.ok(pulls <= 134);
    globalThis.fetch = original;
    await reindex();
    assert.ok(store.loadCatalog().sellers.some((s) => s.displayName === "Later"));
    assert.equal(artifactRow(locator(5))?.data_json, null);
  } finally { globalThis.fetch = original; }
});
test("serialized artifact and metadata ceilings also protect direct persistence", async () => {
  const huge = { values: Array(140_000).fill(0) };
  const hugeAt = locator(6);
  chain({ [hugeAt]: { data: JSON.stringify(huge), name: "dacs1:listing:huge" },
    [locator(7)]: { data: '{}', owner: "x".repeat(513) }, [locator(8)]: { data: '{}', name: "x".repeat(1025) },
    [locator(9)]: { data: JSON.stringify(marker) } }, [hugeAt, locator(7), locator(8), locator(9)]);
  const result = await scan();
  assert.ok(result.observations.find((o) => o.locator === hugeAt)?.data === undefined, "oversized payload is omitted");
  assert.equal(result.listings.size, 0);
  for (const at of [locator(7), locator(8)]) assert.ok(result.failures.some((f) => f.locator === at));
  assert.equal(result.observations.find((o) => o.locator === locator(9))?.contentHash, contentHash(marker));
  store.recordArtifact({ locator: hugeAt, kind: "bundle", profile: "dacs-v0.1", contentHash: contentHash(huge), observedAt: 1, data: huge });
  assert.ok(artifactRow(hugeAt)?.data_json === null, "oversized data is never persisted");
  assert.equal(artifactRow(hugeAt)?.content_hash, null);
});
for (const broken of [{ bundleBindings: {} }, { primaryClaim: 7 }, { deals: {} }, { listingAnchors: {} }]) {
  test(`malformed persisted registration ${Object.keys(broken)[0]} is isolated`, async () => {
    resetIndex([{ primaryClaim: buyer, displayName: "Broken", listingAnchors: [], ...broken } as never, later], 8);
    chain({}); await reindex();
    assert.deepEqual(store.loadCatalog().sellers.map((s) => s.displayName), ["Later"]);
    assert.equal(scanCounts().omitted_sellers, 1);
  });
}
test("rejected revocation outside replay overlap is retried and consensus time recovers", async () => {
  resetIndex([{ primaryClaim: seller, displayName: "Seller", listingAnchors: [locator(11)] }, later], 9);
  const bundle = { bundleVersion: "1", jobId: "restored", parties: [], anchoredByRole: "buyer" };
  chain({ [locator(10)]: { data: withMember(marker, "1e400") }, [locator(11)]: { data: JSON.stringify(listing) },
    [locator(12)]: { data: withMember(bundle, "1e400"), name: "dacs5:bundle:restored" } }, [locator(10), locator(11), locator(12)]);
  const writeHash = "c".repeat(64);
  transactions[2] = { id: 1, status: "confirmed", type: "storageProgram", hash: writeHash, blockNumber: 15, to: locator(12),
    content: { type: "storageProgram", to: locator(12), data: ["storageProgram", { operation: "WRITE_STORAGE", storageAddress: locator(12), data: bundle }] } };
  transactions.unshift({ id: 100 });
  const original = globalThis.fetch;
  let blocksRead = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.body && JSON.parse(String(init.body)).params?.[0]?.message === "getBlockByNumber") {
      blocksRead++;
      return Response.json({ result: 200, response: { number: 15, status: "confirmed", content: { timestamp: 9, ordered_transactions: [writeHash] } } });
    }
    return original(input, init);
  };
  try {
    await reindex();
    assert.equal(store.loadCatalog().sellers[0].listings[0].status, "active");
    assert.equal(store.artifactAnchorTime(locator(12)), undefined);
    assert.ok(store.loadRetryableArtifacts(Date.now() + 4_000_000).includes(locator(10)));
    storage[locator(10)].data = JSON.stringify(marker);
    storage[locator(12)].data = JSON.stringify(bundle);
    sql("UPDATE artifacts SET next_retry_at=0 WHERE error_code='ARTIFACT_REJECTED' RETURNING locator");
    await reindex();
    assert.equal(store.loadCatalog().sellers[0].listings[0].status, "revoked");
    assert.equal(artifactRow(locator(10))?.content_hash, contentHash(marker));
    assert.equal(artifactRow(locator(10))?.status, "observed");
    assert.equal(artifactRow(locator(12))?.content_hash, contentHash(bundle));
    assert.equal(store.artifactAnchorTime(locator(12)), 9_000, "backfill restores the exact content's confirmed block time");
    assert.ok(blocksRead > 0);
  } finally { globalThis.fetch = original; }
});

test("rejected retries remain periodic after exhaustion with a bounded queue", () => {
  sql("DELETE FROM artifacts RETURNING locator");
  for (let i = 0; i < 120; i++) for (let pass = 0; pass < 8; pass++) {
    store.recordArtifact({ locator: locator(1000 + i), kind: "other", profile: "unknown", observedAt: Date.now() });
    store.recordArtifactFailure(locator(1000 + i), "other", "ARTIFACT_REJECTED", "rejected", 1);
  }
  const retry = sql("SELECT retry_count,status,next_retry_at FROM artifacts WHERE locator='" + locator(1000) + "'")[0];
  assert.equal(retry.retry_count, 8);
  assert.equal(retry.status, "retry");
  assert.ok(Number(retry.next_retry_at) > Date.now(), "periodic rejection retries have a future deadline");
  assert.ok(Number(retry.next_retry_at) <= Date.now() + 3_600_000, "backoff is capped at one hour");
  // Pre-fix ARTIFACT_REJECTED dead letters had no retry deadline.
  sql("UPDATE artifacts SET status='dead-letter', next_retry_at=NULL WHERE locator='" + locator(1000) + "' RETURNING locator");
  const queued = store.loadRetryableArtifacts(Date.now() + 4_000_000);
  assert.equal(queued.length, 100);
  assert.equal(new Set(queued).size, 100);
  assert.ok(queued.includes(locator(1000)), "old rejected dead letters are due for another read");
});
test("duplicate programs are indeterminate within a pass and across passes", async () => {
  const jobId = "choice", name = `dacs3:agreement:${jobId}`;
  const agree = await agreementFor(jobId);
  const bundle = { data: '{"any":1}', name: `dacs5:bundle:${jobId}`, owner: ownerOf(buyer) };
  const honest = { data: JSON.stringify(agree), name, owner: ownerOf(buyer) };
  const invalid = { data: JSON.stringify({ seller: outsider }), name, owner: ownerOf(buyer) };
  const key = store.programBindingKey(ownerOf(buyer), name);
  for (const order of [[locator(20), locator(21), locator(22)], [locator(20), locator(22), locator(21)]]) {
    chain({ [locator(20)]: bundle, [locator(21)]: honest, [locator(22)]: invalid }, order);
    const result = await scan();
    assert.equal(result.programs.get(key), null);
    assert.equal(result.deals.get(jobId)?.owners.seller, "");
  }
  resetIndex([later], 10);
  chain({ [locator(20)]: bundle, [locator(21)]: honest }, [locator(20), locator(21)]);
  await reindex();
  assert.equal(store.loadScanState().deals[jobId].owners.seller, seller);
  storage[locator(22)] = invalid;
  transactions = [{ id: 100, content: JSON.stringify({ memo: locator(22) }) }];
  await reindex();
  assert.equal(store.findProgramAddress(ownerOf(buyer), name), null);
  assert.equal(store.loadScanState().deals[jobId].owners.seller, "");
  await reindex();
  assert.equal(store.loadScanState().deals[jobId].owners.seller, "");
});
test("unrelated non-object storage stays unclassified while DACS-named data is rejected", async () => {
  chain({ [locator(30)]: { data: '"text"' }, [locator(31)]: { data: '[1,2]' }, [locator(32)]: { data: '[]', name: 'dacs5:bundle:bad' } }, [locator(30), locator(31), locator(32)]);
  const result = await scan();
  for (const at of [locator(30), locator(31)]) {
    const observation = result.observations.find((o) => o.locator === at);
    assert.equal(observation?.kind, "other"); assert.equal(observation?.data, undefined);
    assert.equal(result.failures.some((f) => f.locator === at), false);
  }
  assert.ok(result.failures.some((f) => f.locator === locator(32)));
});
test("omitted binding counts are persisted in scan diagnostics", async () => {
  const invalid = { ...binding, signature: { ...binding.signature, value: "bad" } };
  resetIndex([{ ...later, bundleBindings: [invalid] }], 11);
  chain({}); await reindex();
  assert.equal(scanCounts().omitted_bindings, 1);
  assert.equal(scanCounts().omitted_deals, 0);
});

test("a SQLite failure during seller indexing fails the pass and records its status", async () => {
  resetIndex([{ primaryClaim: buyer, displayName: "Mismatched seller", listingAnchors: [locator(90)] }, later], 12);
  chain({ [locator(90)]: { data: JSON.stringify(listing) } }, [locator(90)]);
  const db = new Database(join(dataDirectory, "directory.sqlite"));
  db.exec("CREATE TRIGGER fail_listing_rejection BEFORE INSERT ON listing_rejections BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END");
  try {
    await assert.rejects(reindex(), (error: unknown) => typeof (error as { code?: string }).code === "string" && (error as { code: string }).code.startsWith("SQLITE_"));
    assert.equal(store.loadCatalog().generatedAt, 12);
    assert.equal(scanCounts().status, "failed");
  } finally { db.exec("DROP TRIGGER fail_listing_rejection"); db.close(); }
});
