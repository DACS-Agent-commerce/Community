import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed } from "@kynesyslabs/dacs/crypto";
import { vector, sign, seeds, dids, locator, type Obj } from "./fixtures/current-evidence.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-listing-admission-upgrade-"));
process.env.DACS_DIRECTORY_DATA = directory;
test.after(() => rmSync(directory, { recursive: true, force: true }));

const fixture = await vector("admission-upgrade", 900);
const { signature: _, ...original } = fixture.listing;
const seller = dids[1];
// LP-2 allows any key in seller.identity.claims, including this second key.
const identity = { ...((original.seller as Obj).identity as Obj), claims: [{ ref: seller }, { ref: dids[0] }] };
delete (identity as Obj).presentation;
const presentation = { kind: "per-claim", signatures: [{ ref: seller,
  signature: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identity)}`), privateKeyFromSeed(seeds[1]))).toString("base64url") }] };
const goodScope = { ...original, listingId: "allowed-second-key", seller: { ...(original.seller as Obj), identity: { ...identity, presentation } },
  acceptedRails: [{ railId: "demos-native:DEM" }], pipeline: [
    { kind: "negotiate-fixed-price" }, { kind: "commit-agreement" },
    { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } }, { kind: "deliver-attested-payload" },
  ] };
const good = { ...goodScope, signature: await sign(goodScope, "listing", 0) };
const badScope = { ...original, listingId: "missing-method", offering: { ...(original.offering as Obj), deliverable: { kind: "attested-payload", payloadFormat: "application/json" } } };
const bad = { ...badScope, signature: await sign(badScope, "listing", 1) };
const reg = { primaryClaim: seller, displayName: "Upgrade seller", listingAnchors: [locator(901), locator(902)], deals: [] };
const summary = (raw: Obj, at: string) => ({
  listingId: raw.listingId, version: 1, contentHash: contentHash(raw),
  anchor: { kind: "storage-program", locator: at }, seller: { primaryClaim: seller, displayName: reg.displayName },
  offering: { title: raw.listingId, category: "services.test", tags: [] }, pricing: {}, status: "active", catalogObservedAt: 1,
});
const withdrawnScope = { ...original, listingId: "withdrawn" };
const withdrawn = { ...withdrawnScope, signature: await sign(withdrawnScope, "listing", 1) };
const tombstone = { ...summary(withdrawn, locator(903)), status: "revoked", revocation: {
  sellerPrimaryClaim: seller, listingId: "withdrawn", listingVersion: 1, listingContentHash: contentHash(withdrawn),
  logicalAddress: `dacs1-revoked:${encodeURIComponent(seller)}:withdrawn:v1`,
  markerAnchor: { kind: "storage-program", locator: locator(904) }, markerContentHash: "a".repeat(64),
} };
const seeded = new Database(join(directory, "directory.sqlite"));
seeded.exec("CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
const put = seeded.prepare("INSERT INTO kv_state VALUES (?, ?, 0)");
for (const [key, value] of Object.entries({
  "schema-version": 1, "sr2-anchor-schema-version": 2,
  "catalog": { catalogVersion: "1", generatedAt: 1, sellers: [{ ...reg, cci: [],
    listings: [summary(bad, locator(901)), summary(good, locator(902)), tombstone],
    reputation: {}, registeredAt: 1, lastIndexedAt: 1 }] },
  "registrations": [reg], "scan-state": { lastSeenTxId: 20, listings: { [locator(902)]: `0x${seller.slice(-64)}` }, deals: {} },
})) put.run(key, JSON.stringify(value));
seeded.close();

const store = await import("../src/catalog/store.js");
const { GET } = await import("../app/api/dacs/listings/route.js");
const restart = () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `const s=await import('./src/catalog/store.ts'); console.log(JSON.stringify(s.loadCatalog()))`],
  { encoding: "utf8", env: process.env, timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
};

test("old active admission decisions stay withheld through restart", async () => {
  const listed = async () => (await (await GET(new NextRequest("https://directory.example/api/dacs/listings"))).json()).listings;
  assert.deepEqual((await listed()).map((l: Obj) => l.listingId), ["withdrawn"]);
  assert.deepEqual(restart().sellers[0].listings.map((l: Obj) => l.listingId), ["withdrawn"]);
  assert.deepEqual(store.loadRegistrations(), [reg]);
  assert.equal(store.loadScanState().lastSeenTxId, 20);
  assert.equal(store.loadScanState().listings[locator(902)], `0x${seller.slice(-64)}`);
});
