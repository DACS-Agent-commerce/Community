import assert from "node:assert/strict";
import test from "node:test";
import old from "./fixtures/live-invalid-verification-methods.json";
import { parseListingUpgradeManifest } from "../src/catalog/listingUpgradeManifest.js";

const manifest = () => old.map((listing, index) => ({ sourceListingId: listing.listingId,
  replacementListingId: `${listing.listingId}-replacement`, replacementVersion: 1,
  replacementLocator: `stor-${String(index + 1).repeat(40)}`, supportedPayloadMethods: ["self-signed"],
}));

test("manifest validation independently rejects wrong containers, entry fields and duplicate destinations", () => {
  for (const invalid of [null, {}, "manifest", manifest().slice(1), [...manifest(), manifest()[0]]]) {
    assert.throws(() => parseListingUpgradeManifest(invalid), /exactly/);
  }
  const changes: Array<[string, (entry: Record<string, unknown>) => void]> = [
    ["unknown field", entry => { entry.extra = true; }],
    ["non-string ID", entry => { entry.replacementListingId = 7; }],
    ["ID prefix junk", entry => { entry.replacementListingId = `/bad${entry.replacementListingId}`; }],
    ["ID suffix junk", entry => { entry.replacementListingId = `${entry.replacementListingId}/bad`; }],
    ["long ID", entry => { entry.replacementListingId = "a".repeat(129); }],
    ["non-string locator", entry => { entry.replacementLocator = [entry.replacementLocator]; }],
    ["locator prefix junk", entry => { entry.replacementLocator = `x${entry.replacementLocator}`; }],
    ["locator suffix junk", entry => { entry.replacementLocator = `${entry.replacementLocator}x`; }],
    ["mixed method types", entry => { entry.supportedPayloadMethods = ["self-signed", 7]; }],
    ["method container", entry => { entry.supportedPayloadMethods = "self-signed"; }],
  ];
  for (const [name, change] of changes) {
    const entries = manifest();
    change(entries[0]);
    assert.throws(() => parseListingUpgradeManifest(entries), /invalid entry/, name);
  }
  for (const key of ["replacementListingId", "replacementLocator"] as const) {
    const entries = manifest();
    entries[1][key] = entries[0][key];
    assert.throws(() => parseListingUpgradeManifest(entries), /distinct/, key);
  }
  const valid = manifest();
  valid[0].replacementListingId = "A.b_c~d-".repeat(16);
  assert.deepEqual(parseListingUpgradeManifest(valid), valid);
});
