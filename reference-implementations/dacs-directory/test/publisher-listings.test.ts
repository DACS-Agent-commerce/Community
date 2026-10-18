import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeScanState } from "../src/catalog/scanState.js";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-publisher-discovery-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const store = await import("../src/catalog/store.js");
const { publisherListingAnchors } = await import("../src/catalog/publisherListings.js");
const claim = `did:demos:agent:${"b".repeat(64)}`;
const anchor = `stor-${"a".repeat(40)}`;
const emptyState = { lastSeenTxId: 0, listings: {}, deals: {} };

test.afterEach(() => {
  store.saveScanState(emptyState);
  store.saveRegistrations([]);
});
test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

test("authenticated publisher discovery persists without a registration or published catalog row", () => {
  store.saveScanState({ ...emptyState, publisherListingDiscoveries: {
    "buyer.example": { publisherClaim: claim, listingAnchors: [anchor] },
  } });
  assert.deepEqual(store.loadRegistrations(), []);
  assert.deepEqual(store.loadCatalog().sellers, []);
  // A fresh resolver loads the stored hint rather than an in-memory batch map.
  assert.deepEqual(publisherListingAnchors()(claim), [anchor]);
  assert.deepEqual(publisherListingAnchors()(claim), [anchor]);
});

test("unsigned registration candidates do not spend a discovered publisher's read budget", () => {
  const bogus = Array.from({ length: 32 }, (_, n) => `stor-${n.toString(16).padStart(40, "0")}`);
  store.saveRegistrations([{ primaryClaim: claim, displayName: "candidate", listingAnchors: bogus }]);
  store.saveScanState({ ...emptyState, listings: { [anchor]: `0x${claim.slice(-64)}` } });
  assert.deepEqual(publisherListingAnchors()(claim), [anchor]);
});

test("persisted publisher discovery normalizes dictionaries and ignores malformed rows", () => {
  const raw = JSON.parse(JSON.stringify({ ...emptyState, publisherListingDiscoveries: {
    "buyer.example": { publisherClaim: claim, listingAnchors: [anchor] },
    "bad.example": { publisherClaim: claim, listingAnchors: [123] },
    "missing.example": { listingAnchors: [anchor] },
  } }));
  const normalized = normalizeScanState(raw);
  assert.equal(Object.getPrototypeOf(normalized.publisherListingDiscoveries), null);
  assert.deepEqual(Object.keys(normalized.publisherListingDiscoveries), ["buyer.example"]);
  assert.deepEqual(publisherListingAnchors([], normalized)(claim), [anchor]);
  assert.deepEqual(Object.keys(normalizeScanState(emptyState).publisherListingDiscoveries), []);
});
