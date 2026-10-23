import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import test from "node:test";
import { indexRegistration } from "../src/catalog/indexer.js";
import { cciProofLinks } from "../src/catalog/cciProofLinks.js";
import { parseCciRecord } from "@kynesyslabs/dacs/identity";

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

test("conflicting display URLs affect only that accepted CCI claim", async () => {
  const claim = `did:demos:agent:${"a".repeat(64)}`;
  const conflicting = [
    { username: "duplicate", proofHash: "ab".repeat(32), proof: "https://example.com/one" },
    { username: "duplicate", proofHash: "ab".repeat(32), proof: "https://example.com/two" },
    { username: "duplicate", proofHash: "ab".repeat(32), proof: "https://example.com/one" },
  ];
  for (const rows of [conflicting, [conflicting[1], conflicting[0], conflicting[2]]]) {
    const payload = { web2: { discord: [
      ...rows,
      { username: "unique", proof: "https://example.com/unique" },
      { username: "same-url", proofHash: "cd".repeat(32), proof: "https://example.com/same" },
      { username: "same-url", proofHash: "cd".repeat(32), proof: "https://example.com/same" },
    ] }, xm: { evm: { "1": [{ address: `0x${"b".repeat(40)}` }] } } };
    for (const raw of [payload, { result: 200, response: { data: payload } }]) {
      const parsed = parseCciRecord(claim, raw);
      assert.equal(parsed.web2.length, 3, "the original commitments are consistent");
      assert.equal(parsed.wallets.length, 1);
      const links = cciProofLinks(claim, raw);
      assert.equal(links.has("cci-web2:discord:duplicate"), false);
      assert.equal(links.get("cci-web2:discord:unique"), "https://example.com/unique");
      assert.equal(links.get("cci-web2:discord:same-url"), "https://example.com/same");
      const seller = await indexRegistration({ primaryClaim: claim, displayName: "CCI", listingAnchors: [] }, undefined, async () => raw);
      assert.equal(seller.cci.length, 4, "a fresh seller retains every accepted badge, including the wallet");
      assert.equal(seller.cci.find((badge) => badge.handle === "duplicate")?.proofUrl, undefined);
      assert.equal(seller.cci.find((badge) => badge.handle === "unique")?.proofUrl, "https://example.com/unique");
    }
  }
});
