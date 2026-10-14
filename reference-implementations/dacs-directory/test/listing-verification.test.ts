import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalize, contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { verifyListing } from "../src/catalog/listingVerification.js";

const seed = Uint8Array.from(Buffer.from("11".repeat(32), "hex"));
const privateKey = privateKeyFromSeed(seed);
const publicKeyHex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
const claim = `did:demos:agent:${publicKeyHex}`;

function signMessage(message: string): string {
  return Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKey)).toString("base64url");
}

function signedCurrentListing(
  extra: Record<string, unknown> = {},
  signingClaim = claim,
): Record<string, unknown> {
  const identity: Record<string, unknown> = {
    presentedBy: signingClaim,
    claims: [{ ref: signingClaim, kind: "signing-key" }],
  };
  identity.presentation = {
    kind: "per-claim",
    signatures: [{
      ref: signingClaim,
      signature: signMessage(`dacs-bundle-presentation:v1:${contentHash(identity)}`),
    }],
  };

  const scope: Record<string, unknown> = {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "sig5-preserve-unknown",
    seller: {
      displayName: "SIG-5 Fixture Desk",
      identity,
    },
    offering: {
      title: "SIG-5 Fixture Desk",
      description: "Pins preserve-unknown behavior for Directory listing verification.",
      category: "conformance.signature",
      tags: ["sig5"],
      deliverable: { kind: "storage-program" },
    },
    buyerRequirement: { kind: "none" },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: "pay-x402" } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [{ railId: "pay-x402", kind: "x402" }],
    terms: { refundPolicy: "none" },
    validity: { notBefore: 1784016000000 },
    ...extra,
  };

  return {
    ...scope,
    signature: {
      algorithm: "ed25519",
      signer: signingClaim,
      value: signMessage(`dacs-listing:v1:${contentHash(scope)}`),
    },
  };
}

test("verifyListing canonicalizes mixed-case DID scheme spelling on read", async () => {
  const mixedCaseClaim = `DID:demos:agent:${publicKeyHex}`;
  const verified = await verifyListing(signedCurrentListing({}, mixedCaseClaim));

  assert.equal(verified?.signer, claim);
  assert.equal(verified?.sellerClaim, claim);
});

test("verifyListing rejects suffix-shaped aliases even when their signatures are valid", async () => {
  for (const rejected of [
    `domain:${publicKeyHex}`,
    `demos:0x${publicKeyHex}`,
    `did:demos:agent:${publicKeyHex.toUpperCase()}`,
  ]) {
    assert.equal(await verifyListing(signedCurrentListing({}, rejected)), null, rejected);
  }
});

test("verifyListing preserves inert unknown top-level fields in the signed scope", async () => {
  const listing = signedCurrentListing({
    futureOptionalMetadata: { fixture: "preserve", color: "blue" },
  });
  const verified = await verifyListing(listing);

  assert.ok(verified);
  assert.equal(verified.profile, "dacs-v0.1");
  assert.equal(verified.contentHash, contentHash(verified.scope));
  assert.deepEqual(verified.scope.futureOptionalMetadata, { fixture: "preserve", color: "blue" });
});

test("verifyListing rejects mutation or removal of an unknown signed field", async () => {
  const listing = signedCurrentListing({
    futureOptionalMetadata: { fixture: "preserve", color: "blue" },
  });
  const mutated = structuredClone(listing);
  (mutated.futureOptionalMetadata as Record<string, unknown>).color = "red";
  const removed = structuredClone(listing);
  delete removed.futureOptionalMetadata;

  assert.equal(await verifyListing(mutated), null);
  assert.equal(await verifyListing(removed), null);
});

test("verifyListing refuses unknown executable phase kinds even with a valid signature", async () => {
  const listing = signedCurrentListing({
    pipeline: [{ kind: "negotiate-autonomous-barter" }],
  });

  assert.equal(await verifyListing(listing), null);
});

test("verifyListing requires exactly one adjacent supported commitment phase", async () => {
  const payeeBound = signedCurrentListing({
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: "pay-x402" } },
      { kind: "deliver-storage-program" },
    ],
  });
  assert.ok(await verifyListing(payeeBound));

  assert.equal(await verifyListing(signedCurrentListing({
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "pay-x402", parameters: { rail: "pay-x402" } },
      { kind: "deliver-storage-program" },
    ],
  })), null);
  assert.equal(await verifyListing(signedCurrentListing({
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: "pay-x402" } },
      { kind: "deliver-storage-program" },
    ],
  })), null);
  assert.equal(await verifyListing(signedCurrentListing({
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "pay-x402", parameters: { rail: "pay-x402" } },
      { kind: "commit-payee-bound-agreement" },
      { kind: "deliver-storage-program" },
    ],
  })), null);
});

test("verifyListing accepts normative metered pricing bound to an AP2 rail", async () => {
  const metered = {
    kind: "metered",
    unitPrice: { amount: "0.02", currency: "USD" },
    unit: "API call",
    minTotal: { amount: "1", currency: "USD" },
  };
  const pipeline = [
    { kind: "negotiate-fixed-price" },
    { kind: "commit-agreement" },
    { kind: "pay-ap2", parameters: { rail: "ap2:stripe-paymentintents" } },
    { kind: "deliver-storage-program" },
  ];
  const listing = signedCurrentListing({
    pricing: metered,
    pipeline,
    acceptedRails: [{ railId: "ap2:stripe-paymentintents" }],
  });

  assert.ok(await verifyListing(listing));
  assert.ok(await verifyListing(signedCurrentListing({
    pricing: metered,
    pipeline: [{ kind: "negotiate-rfq" }, ...pipeline.slice(1)],
    acceptedRails: [{ railId: "ap2:stripe-paymentintents" }],
  })));
  assert.equal(await verifyListing(signedCurrentListing({
    pricing: { ...metered, minTotal: { amount: "1", currency: "EUR" } },
    pipeline,
    acceptedRails: [{ railId: "ap2:stripe-paymentintents" }],
  })), null);
  assert.equal(await verifyListing(signedCurrentListing({
    pricing: { ...metered, unit: "" },
    pipeline,
    acceptedRails: [{ railId: "ap2:stripe-paymentintents" }],
  })), null);
  assert.equal(await verifyListing(signedCurrentListing({
    pricing: metered,
    pipeline: [{ kind: "negotiate-sealed-envelope" }, ...pipeline.slice(1)],
    acceptedRails: [{ railId: "ap2:stripe-paymentintents" }],
  })), null);
});

test("PS-3: each negotiation pattern accepts exactly the pricing kinds DACS-3 allows", async () => {
  const pricing: Record<string, Record<string, unknown>> = {
    fixed: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    negotiable: { kind: "negotiable", bandCenter: { amount: "1", currency: "USDC" }, minPct: 10, maxPct: 10 },
    auction: { kind: "auction", reservePrice: { amount: "1", currency: "USDC" }, selectionRule: "lowest-price" },
    metered: { kind: "metered", unitPrice: { amount: "1", currency: "USDC" }, unit: "call" },
  };
  const allowed: Record<string, string[]> = {
    "negotiate-fixed-price": ["fixed", "negotiable", "metered"],
    "negotiate-rfq": ["negotiable", "metered"],
    "negotiate-sealed-envelope": ["auction"],
    "negotiate-sealed-envelope-procurement": ["auction"],
  };
  const verdicts: Record<string, boolean> = {};
  const expected: Record<string, boolean> = {};
  for (const [negotiation, kinds] of Object.entries(allowed)) {
    for (const kind of Object.keys(pricing)) {
      const listing = signedCurrentListing({
        pricing: pricing[kind],
        pipeline: [{ kind: negotiation }, { kind: "commit-agreement" }, { kind: "pay-x402", parameters: { rail: "pay-x402" } }, { kind: "deliver-storage-program" }],
      });
      verdicts[`${negotiation} ${kind}`] = (await verifyListing(listing)) !== null;
      expected[`${negotiation} ${kind}`] = kinds.includes(kind);
    }
  }
  assert.deepEqual(verdicts, expected);
});

test("auction pricing accepts only the DACS-4 selectionRule enum and content-hash-bound rule refs", async () => {
  const auction = (selectionRule: unknown) => signedCurrentListing({
    pricing: { kind: "auction", selectionRule },
    pipeline: [{ kind: "negotiate-sealed-envelope" }, { kind: "commit-agreement" }, { kind: "pay-x402", parameters: { rail: "pay-x402" } }, { kind: "deliver-storage-program" }],
  });
  for (const rule of ["lowest-price", "highest-price", "first-acceptable", `rule-ref:${"a".repeat(64)}:https://rules.example/r1`]) {
    assert.ok(await verifyListing(auction(rule)), rule);
  }
  for (const rule of ["best-vibes", "", "rule-ref:not-a-hash:https://rules.example/r1", `rule-ref:${"a".repeat(64)}:`, 7]) {
    assert.equal(await verifyListing(auction(rule)), null, String(rule));
  }
});

test("LR-2 caps the canonical form at 16,384 bytes, signature omitted, not the raw JSON", async () => {
  const unsigned = (listing: Record<string, unknown>) => {
    const scope = { ...listing };
    delete scope.signature;
    return Buffer.byteLength(canonicalize(scope), "utf8");
  };
  const sized = (bytes: number) => signedCurrentListing({
    padding: "x".repeat(bytes - unsigned(signedCurrentListing({ padding: "" }))),
  });
  const atCap = sized(16_384);
  assert.equal(unsigned(atCap), 16_384);
  assert.ok(Buffer.byteLength(JSON.stringify(atCap), "utf8") > 16_384, "the raw JSON with its signature is larger");
  assert.ok(await verifyListing(atCap));
  assert.equal(await verifyListing(sized(16_385)), null);
  // NFC composition shrinks the canonical form below the raw bytes; a composition exclusion grows it.
  const composing = signedCurrentListing({ padding: "é".repeat(5_000) });
  assert.ok(Buffer.byteLength(JSON.stringify(composing), "utf8") > 16_384);
  assert.ok(await verifyListing(composing));
  const expanding = signedCurrentListing({ padding: "क़".repeat(4_000) });
  assert.ok(Buffer.byteLength(JSON.stringify(expanding), "utf8") < 16_384);
  assert.equal(await verifyListing(expanding), null);
});

test("the indexer publishes a current listing only once validity.notBefore has passed (DACS-1 validation step 3)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dacs-directory-validity-"));
  process.env.DACS_DIRECTORY_DATA = directory;
  const { indexRegistration } = await import("../src/catalog/indexer.js");
  const anchors: Record<string, Record<string, unknown>> = {
    [`stor-${"a1".padStart(40, "0")}`]: signedCurrentListing({ listingId: "future", validity: { notBefore: Date.now() + 3_600_000 } }),
    [`stor-${"a2".padStart(40, "0")}`]: signedCurrentListing({ listingId: "current", validity: { notBefore: Date.now() - 1_000 } }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = anchors[String(input).split("/").pop() ?? ""];
    return data
      ? Response.json({ success: true, owner: `0x${publicKeyHex}`, programName: "opaque", data })
      : new Response(null, { status: 404 });
  };
  try {
    const record = await indexRegistration(
      { primaryClaim: claim, displayName: "Seller", listingAnchors: Object.keys(anchors) },
      undefined,
      async () => { throw new Error("identity unavailable"); },
    );
    assert.deepEqual(record.listings.map((listing) => listing.listingId), ["current"]);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});
