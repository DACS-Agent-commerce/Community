import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { parseWireJson, storageResponseJson } from "../src/catalog/artifactLimits.js";
import { readChainTip, storageWriteCandidate } from "../src/catalog/scan.js";
import { verifyListingRevocation, type VerifiedListing } from "../src/catalog/listingVerification.js";

// CORE §B.2 admits JSON `-0` and serializes it as `0`; a signed artifact carrying it must read as the `0` it signs.
const seed = Uint8Array.from(Buffer.alloc(32, 85));
const did = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const listingHash = "c".repeat(64);
const listing: VerifiedListing = {
  listing: { listingId: "svc" }, scope: { listingId: "svc" }, contentHash: listingHash, signer: did, sellerClaim: did, profile: "dacs-v0.1",
};
const tuple = { listingId: "svc", listingVersion: 2, listingContentHash: listingHash, revokedAt: 0 };

async function markerText(revokedAt: string): Promise<string> {
  const value = Buffer.from(await ed25519Sign(Buffer.from(`dacs-revocation:v1:${contentHash(tuple)}`, "utf8"), privateKeyFromSeed(seed))).toString("base64url");
  const signature = JSON.stringify({ algorithm: "ed25519", signer: did, value });
  return `{"listingContentHash":"${listingHash}","listingId":"svc","listingVersion":2,"revokedAt":${revokedAt},"signature":${signature}}`;
}

test("a withdrawal whose revokedAt is written -0 still verifies when read from storage", async () => {
  const read = async (text: string) => (await storageResponseJson(new Response(text))) as Record<string, unknown>;
  assert.equal(await verifyListingRevocation(await read(await markerText("0")), listing, 2), true, "control: the same marker written 0");
  const marker = await read(await markerText("-0"));
  assert.ok(Object.is(marker.revokedAt, 0), "the wire value is read as 0");
  assert.equal(await verifyListingRevocation(marker, listing, 2), true);
});

test("-0 is read as 0 at any depth and no other value changes", () => {
  assert.deepEqual(parseWireJson('{"a":[-0,{"b":-0}],"c":-1.5,"d":0,"e":"-0"}'), { a: [0, { b: 0 }], c: -1.5, d: 0, e: "-0" });
  const parsed = parseWireJson('{"a":[-0,{"b":-0}]}') as { a: [number, { b: number }] };
  assert.ok(Object.is(parsed.a[0], 0) && Object.is(parsed.a[1].b, 0));
  assert.ok(Object.is(parseWireJson("-0"), 0));
  const deep = `${"[".repeat(100_000)}-0${"]".repeat(100_000)}`;
  assert.doesNotThrow(() => parseWireJson(deep), "a deeply nested reply does not overflow the stack");
});

test("a storage write carrying -0 is attributed to the hash of the same data written 0", () => {
  const locator = `stor-${"a".repeat(40)}`;
  const candidate = (data: string) => storageWriteCandidate({
    status: "confirmed", type: "storageProgram", blockNumber: 7, hash: "b".repeat(64), to: locator,
    content: `{"type":"storageProgram","to":"${locator}","data":["storageProgram",{"operation":"WRITE_STORAGE","storageAddress":"${locator}","data":${data}}]}`,
  });
  const expected = candidate('{"score":0}');
  assert.ok(expected, "control: the same write with 0 is attributed");
  assert.deepEqual(candidate('{"score":-0}'), expected);
});

test("scanner nodeCall reads a negative-zero transaction tip as zero", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"result":200,"response":[{"id":-0}]}');
  try { assert.ok(Object.is(await readChainTip(), 0)); }
  finally { globalThis.fetch = original; }
});
