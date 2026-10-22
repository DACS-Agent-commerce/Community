import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import { indexRegistration } from "../src/catalog/indexer.js";

test("CCI badges prefer original HTTP proof links to commitments across RPC envelopes", async () => {
  const claim = `did:demos:agent:${"a".repeat(64)}`;
  const web2 = { discord: [
    { username: "both", proof: "https://discord.com/channels/1/2/3", proofHash: "ab".repeat(32) },
    { username: "hash-only", proofHash: "cd".repeat(32) },
    { username: "unsafe", proof: "javascript:alert(1)" },
    { username: "explicit", proofUrl: "https://example.com/proof", proof: "https://example.com/other" },
  ] };
  for (const raw of [{ web2 }, { result: 200, response: { web2 } }]) {
    const seller = await indexRegistration({ primaryClaim: claim, displayName: "CCI", listingAnchors: [] }, undefined, async () => raw);
    assert.deepEqual(seller.cci.map((badge) => [badge.handle, badge.proofUrl]), [
      ["both", "https://discord.com/channels/1/2/3"], ["explicit", "https://example.com/proof"], ["hash-only", undefined], ["unsafe", undefined],
    ]);
  }
});
