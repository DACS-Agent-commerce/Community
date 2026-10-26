import assert from "node:assert/strict";
import test from "node:test";
import { artifactHash, buildCurrentEvidenceGraph, signedScope } from "../src/catalog/evidenceGraph.js";
import { installAgreement, maps, sign, vector } from "./fixtures/current-evidence.js";

for (const agreementAnchorTime of [90, 110, undefined]) {
  test(`expired history needs commitment proof with Agreement anchor ${agreementAnchorTime ?? "private"}`, async () => {
    const fixture = await vector();
    const listingScope = signedScope(fixture.listing, "listing");
    listingScope.validity = { notBefore: 1, notAfter: 100 };
    fixture.listing = { ...listingScope, signature: await sign(listingScope, "listing", 1) };
    const listingRef = { listingId: "svc", version: 1, contentHash: artifactHash(fixture.listing, "listing") };
    fixture.buyerBundle = { ...fixture.buyerBundle, listingRef };
    fixture.sellerBundle = { ...fixture.sellerBundle, listingRef };
    await installAgreement(fixture, { ...signedScope(fixture.agreement, "agreement"), listingRef });
    if (agreementAnchorTime === undefined) maps.delete(fixture.locators.agreement);

    // The read adapter may supply a privately retained Agreement. Its bytes
    // and party signatures authenticate the Agreement, not commitment finality.
    // The old anchor-time callback models cached public anchor metadata; it
    // cannot establish a finalized commitment receipt.
    const deps = {
      read: async (at: string) => at === fixture.locators.agreement ? fixture.agreement : maps.get(at) ?? null,
      resolveListing: async () => ({ locator: fixture.locators.listing, raw: fixture.listing, expiredAt: 100 }),
      anchorTime: () => agreementAnchorTime,
    };
    const graph = await buildCurrentEvidenceGraph(fixture.locators.buyer, deps);
    assert.equal(graph.signaturesVerified, true);
    assert.equal(graph.refsVerified, false, "an Agreement anchor cannot establish the commitment's finalized receipt time");
    assert.equal(graph.ok, false);
  });
}
