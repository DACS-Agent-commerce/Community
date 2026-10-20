import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { contentHash, sha256Hex } from "../src/catalog/canonical.js";
import { crawlDomain, wellKnownWithdrawalMessage } from "../src/catalog/wellknown.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-publisher-signature-"));
process.env.DACS_DIRECTORY_DATA = directory;
const store = await import("../src/catalog/store.js");
const { ingestWellKnownRevocations } = await import("../src/catalog/reindexCore.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));

// Expected wire bytes are independent of the production message builder.
test("withdrawal signature preimage has exact domain, separator and lowercase hash bytes", () => {
  const hex = "AB".repeat(32);
  const expected = `dacs-directory withdrawal-index:v1\ndomain:https://seller.example\nindex:sha256-${"ab".repeat(32)}`;
  for (const domain of ["seller.example", "https://SELLER.example:443/"]) {
    assert.equal(wellKnownWithdrawalMessage(domain, hex), expected);
    assert.equal(wellKnownWithdrawalMessage(domain, `sha256-${hex}`), expected);
  }
});

const seed = new Uint8Array(32).fill(83);
const otherSeed = new Uint8Array(32).fill(84);
const seller = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const fixture = JSON.parse(readFileSync(new URL("./fixtures/reviewbot-listing-anchor.json", import.meta.url), "utf8"));
const hash = contentHash(fixture.data);
const index = { indexVersion: "1", generatedAt: 1, seller, listings: [{
  listingId: fixture.data.serviceId, version: 1, contentHash: hash,
  anchor: { kind: "storage-program", locator: fixture.storageAddress }, status: "revoked",
  summary: { title: "Service", category: "services.other", tags: [] },
}] };
const raw = JSON.stringify(index);
const signatureBytes = (signingSeed = seed, message = `dacs-directory withdrawal-index:v1\ndomain:https://seller.example\nindex:sha256-${sha256Hex(raw)}`) =>
  Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(signingSeed)));
const signed = signatureBytes();
const canonical = signed.toString("base64url");
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const nonCanonical = canonical.slice(0, -1) + alphabet[alphabet.indexOf(canonical.at(-1)!) | 1];

for (const [name, domain, document, signature] of [
  ["replay on another domain", "attacker.example", raw, canonical],
  ["replay on another index", "seller.example", JSON.stringify({ ...index, generatedAt: 2 }), canonical],
  ["another signing key", "seller.example", raw, signatureBytes(otherSeed).toString("base64url")],
  ["signature of an empty message", "seller.example", raw, signatureBytes(seed, "").toString("base64url")],
  ["padded base64url", "seller.example", raw, `${canonical}==`],
  ["standard base64", "seller.example", raw, signed.toString("base64")],
  ["unpadded standard base64", "seller.example", raw, signed.toString("base64").replace(/=+$/, "")],
  ["nonzero base64url padding bits", "seller.example", raw, nonCanonical],
] as const) test(`publisher refuses ${name} without granting withdrawal authority`, async () => {
  // Ensure these encoding cases really differ from canonical bytes.
  if (!name.startsWith("replay")) assert.notEqual(signature, canonical);
  const agent = await crawlDomain(domain, {
    validateUrl: async () => ({} as never),
    fetchJson: async (url) => {
      const body = url.endsWith("agent.json") ? JSON.stringify({ dacs: { dacsVersion: "1", listings: {
        indexUrl: `https://${domain}/listings.json`, indexHash: `sha256-${sha256Hex(document)}`, publisherSignature: signature,
      } } }) : document;
      return { body: JSON.parse(body), raw: body };
    },
  });
  assert.ok(!("error" in agent));
  assert.equal(agent.withdrawalAuthenticated, false);
  await ingestWellKnownRevocations(agent);
  assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), false);
});

test("independently signed exact bytes authorize an incomplete check", async () => {
  const agent = await crawlDomain("seller.example", {
    validateUrl: async () => ({} as never),
    fetchJson: async (url) => {
      const body = url.endsWith("agent.json") ? JSON.stringify({ dacs: { dacsVersion: "1", listings: {
        indexUrl: "https://seller.example/listings.json", indexHash: `sha256-${sha256Hex(raw)}`, publisherSignature: canonical,
      } } }) : raw;
      return { body: JSON.parse(body), raw: body };
    },
  });
  assert.ok(!("error" in agent));
  assert.equal(agent.withdrawalAuthenticated, true);
  await ingestWellKnownRevocations(agent);
  assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), true);
});
