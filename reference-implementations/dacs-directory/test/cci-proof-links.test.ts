import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import { indexRegistration } from "../src/catalog/indexer.js";
import { cciProofLinks } from "../src/catalog/cciProofLinks.js";

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

test("CCI signatures are commitments rather than display proof URLs", () => {
  const claim = `did:demos:agent:${"a".repeat(64)}`;
  for (const signature of ["https://example.com/signature", "http://example.com/signature", "commitment", "javascript:alert(1)"]) {
    const links = cciProofLinks(claim, { web2: { discord: [{ username: "signature-only", signature }] } });
    assert.equal(links.size, 0, signature);
  }
});

test("proof URL projection accepts HTTP and strips unsafe or non-string proof fields", () => {
  const claim = `did:demos:agent:${"a".repeat(64)}`;
  const links = cciProofLinks(claim, { web2: { discord: [
    { username: "plain-http", proof: "http://example.com/proof" },
    { username: "array-proof", proof: ["https://example.com/array"] },
    { username: "array-explicit", proofUrl: ["https://example.com/array"] },
    { username: "unsafe-explicit", proofUrl: "javascript:alert(1)" },
  ] } });
  assert.deepEqual([...links.values()], ["http://example.com/proof"]);
});
