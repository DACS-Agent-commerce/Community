import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contentHash, stripSignature } from "../src/catalog/canonical.js";
import { verifyListing } from "../src/catalog/listingVerification.js";
import type { ResolvePrimaryClaimKey } from "../src/catalog/primaryClaimKey.js";

type Obj = Record<string, any>;
const name = "listing-preserve-unknown-v0.1.json";
const raw = readFileSync(new URL(`./fixtures/dacs-standard/${name}`, import.meta.url));
const vectors = JSON.parse(raw.toString()) as Obj;
const pin = readFileSync(new URL("../SPEC_PIN", import.meta.url), "utf8");
const resolveKey: ResolvePrimaryClaimKey = async (claim, algorithm) => vectors.publicKeys[claim] && algorithm === "ed25519"
  ? { canonicalClaim: claim, algorithm, publicKey: Uint8Array.from(Buffer.from(vectors.publicKeys[claim], "base64url")) } : null;

test("the preserve-unknown fixture bytes match SPEC_PIN", () => {
  const line = pin.split("\n").find(line => line.includes(name));
  assert.ok(line);
  assert.equal(createHash("sha256").update(raw).digest("hex"), line.trim().split(/\s+/).at(-1));
  assert.equal(vectors.vectors.length, 4);
});
for (const vector of vectors.vectors) test(`upstream SIG-5: ${vector.name}`, async () => {
  const listing = structuredClone(vectors.fixtures[vector.fixture].listing);
  const path = vector.transform.path?.split(".") ?? [];
  const key = path.pop();
  let target = listing;
  for (const part of path) target = target[part];
  if (vector.transform.kind === "set") target[key] = vector.transform.value;
  if (vector.transform.kind === "remove") delete target[key];
  assert.equal(contentHash(stripSignature(listing)), vector.want.computedArtifactHash);
  assert.equal(Boolean(await verifyListing(listing, resolveKey)), vector.expected === "pass");
});

test("independently signed nested phase extensions remain readable and signature-bound", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/listing-nested-phase-metadata.json", import.meta.url), "utf8")) as Obj;
  const listing = fixture.listing;
  assert.equal(contentHash(stripSignature(listing)), fixture.contentHash);
  assert.equal((await verifyListing(listing))?.contentHash, fixture.contentHash);
  const tampered = structuredClone(listing);
  tampered.pipeline[2].parameters.future.label = "modified";
  assert.notEqual(contentHash(stripSignature(tampered)), fixture.contentHash);
  assert.equal(await verifyListing(tampered), null, "nested extension changes invalidate the stored signature");
  const wrongSignature = structuredClone(listing);
  wrongSignature.signature.value = Buffer.alloc(64).toString("base64url");
  assert.equal(await verifyListing(wrongSignature), null, "signature verification is still required");
});
