import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { contentHash } from "../src/catalog/canonical.js";
import { onPinnedChain } from "./fixtures/pinned-node.js";
import { PINNED_DEMOS_CHAIN_IDENTITY } from "../src/catalog/nodeDeployment.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-future-revocation-"));
process.env.DACS_DIRECTORY_DATA = directory;
const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const db = new Database(join(directory, "directory.sqlite"));
test.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
const week = 7 * 24 * 60 * 60 * 1000;
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;

test("future-dated Listing stays revoked after its already-seen owner marker ages under default incremental scans", async (t) => {
  let now = 1_870_000_000_000;
  t.mock.method(Date, "now", () => now);
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const claim = `did:demos:agent:${publicKey}`, owner = `0x${publicKey}`;
  const signature = (message: string) => sign(null, Buffer.from(message), keys.privateKey).toString("base64url");
  const identity = { bundleVersion: "1", presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
  const scope = { dacsVersion: "1", listingVersion: 1, listingId: "future-retention",
    seller: { displayName: "seller", identity: { ...identity, presentation: { kind: "per-claim",
      signatures: [{ ref: claim, signature: signature(`dacs-bundle-presentation:v1:${contentHash(identity)}`) }] } } },
    offering: { title: "retention", description: "retention", category: "test", tags: [],
      deliverable: { kind: "storage-program", accessModel: "public" } },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }, { kind: "deliver-storage-program" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } }, terms: {}, validity: { notBefore: (now + week + 86_400_000) } };
  const hash = contentHash(scope), anchor = locator(31), marker = locator(32);
  const listing = { ...scope, signature: { algorithm: "ed25519", signer: claim, value: signature(`dacs-listing:v1:${hash}`) } };
  const markerScope = { listingId: scope.listingId, listingVersion: 1, listingContentHash: hash, revokedAt: now };
  const revocation = { ...markerScope, signature: { algorithm: "ed25519", signer: claim,
    value: signature(`dacs-revocation:v1:${contentHash(markerScope)}`) } };
  // The owner marker was observed before the incremental cursor. Later scans
  // cannot rediscover it in their two-transaction overlap.
  store.admitRevocationCandidates(hash, [{ locator: marker, owner, contentHash: contentHash(revocation) }]);
  store.publishCatalogChain({ catalogVersion: "1", generatedAt: now, sellers: [] },
    { ...store.loadScanState(), lastSeenTxId: 100, lastChainTip: 110, listings: { [anchor]: owner },
      deals: {}, programs: {}, revocations: {}, verifiedRevocations: {} }, PINNED_DEMOS_CHAIN_IDENTITY);
  store.saveRegistrations([{ primaryClaim: claim, displayName: "seller", listingAnchors: [anchor] }]);
  let markerReads = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.body) {
      const call = JSON.parse(String(init.body)).params?.[0];
      assert.equal(call?.message, "getTransactions");
      const start = call.data?.start === "latest" ? 110 : Number(call.data?.start);
      return Response.json({ result: 200, response: Array.from({ length: 110 }, (_, i) => ({ id: 110 - i }))
        .filter((tx) => tx.id <= start).slice(0, 100) });
    }
    const at = new URL(String(input)).pathname.split("/").pop();
    if (at === anchor) return Response.json({ success: true, owner, data: listing });
    if (at === marker) { markerReads++; return Response.json({ success: true, owner, data: revocation }); }
    return new Response("unavailable", { status: 503 });
  });
  const run = () => reindexAll({ nodeDeployment: onPinnedChain, resolveIdentities: async () => [],
    crawlWellKnown: async () => ({ agents: [], errors: [] }), log: () => {} });
  const initial = await run();
  assert.ok(initial.cursor >= 100, "complete pass preserves incremental history");
  assert.deepEqual(store.loadStoredCatalog().sellers[0].listings, [], "future Listing is skipped");
  assert.equal(markerReads, 0, "future Listing has not consumed its owner marker");
  now += week;
  await run();
  const aged = db.prepare("SELECT state FROM revocation_candidates WHERE listing_hash=? AND locator=?").get(hash, marker);
  assert.equal(markerReads, 0, "the old marker is outside default incremental replay");
  now += 86_400_000;
  await run();
  const visible = store.loadStoredCatalog().sellers[0].listings;
  assert.deepEqual({ aged, statuses: visible.map((entry) => entry.status) },
    { aged: { state: "pending" }, statuses: ["revoked"] }, "pending evidence must survive aging and prevent activation");
  assert.equal(visible[0].revocation?.listingContentHash, hash);
  assert.equal(markerReads, 1, "the retained candidate is verified when notBefore arrives");
});
