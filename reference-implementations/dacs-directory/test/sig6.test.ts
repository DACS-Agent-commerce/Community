import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { buildCurrentEvidenceGraph, verifyComponentSignature } from "../src/catalog/evidenceGraph.js";
import { verifyListing, verifyListingRevocation } from "../src/catalog/listingVerification.js";
import {
  canonicalSignatureBytes,
  canonicalSignatureValue,
  importLegacySignatureValue,
  type LegacySignatureEncoding,
} from "../src/catalog/signatureValue.js";

// CORE §B.7 SIG-6 against the pinned DACS-Standard vectors (SPEC_PIN), then on each conforming verifier.
const fixture = (name: string) => new URL(`./fixtures/dacs-standard/${name}`, import.meta.url);
const pinned = readFileSync(new URL("../SPEC_PIN", import.meta.url), "utf8");
interface EncodingVector {
  name: string; mode: "conforming-verifier" | "legacy-import"; value: string; expected: "accept" | "reject";
  declaredEncoding?: LegacySignatureEncoding; want: { decodedLength?: number; canonicalValue?: string };
}
const encoding = JSON.parse(readFileSync(fixture("signature-value-encoding-v0.1.json"), "utf8")) as {
  canonicalValue: string; signatureBytesHex: string; vectors: EncodingVector[];
};

test("vendored DACS-Standard vectors are the byte-identical files SPEC_PIN records", () => {
  for (const name of ["signature-value-encoding-v0.1.json", "revocation-binding-v0.3.json"]) {
    const digest = createHash("sha256").update(readFileSync(fixture(name))).digest("hex");
    assert.match(pinned, new RegExp(`${name.replace(/[.]/g, "\\.")}\\s+${digest}`), name);
  }
});

test("SIG-6 signature-value-encoding vectors: conforming decode and declared legacy import", () => {
  assert.equal(encoding.vectors.length, 10);
  for (const vector of encoding.vectors) {
    if (vector.mode === "conforming-verifier") {
      // Wire checks first; the algorithm-specific length is checked separately.
      const bytes = canonicalSignatureBytes(vector.value, vector.want.decodedLength ?? 64);
      assert.equal(bytes !== null && bytes.length === 64, vector.expected === "accept", vector.name);
      if (vector.want.decodedLength === 63) {
        assert.ok(canonicalSignatureBytes(vector.value, 63), `${vector.name}: canonical on the wire`);
        assert.equal(canonicalSignatureBytes(vector.value), null, `${vector.name}: not an Ed25519 length`);
      }
    } else {
      const imported = importLegacySignatureValue(vector.value, vector.declaredEncoding);
      assert.equal(imported, vector.expected === "accept" ? vector.want.canonicalValue : null, vector.name);
    }
  }
  const bytes = Uint8Array.from(Buffer.from(encoding.signatureBytesHex, "hex"));
  assert.equal(canonicalSignatureValue(bytes), encoding.canonicalValue);
  assert.deepEqual(canonicalSignatureBytes(encoding.canonicalValue), bytes);
  // The wallet-hex import never guesses: uppercase is not the declared lowercase hex.
  assert.equal(importLegacySignatureValue(encoding.signatureBytesHex.toUpperCase(), "lowercase-hex"), null);
});

const seed = Uint8Array.from(Buffer.alloc(32, 61));
const did = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const signBytes = async (message: string) => Uint8Array.from(await ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(seed)));
/** The seven non-canonical spellings of the same bytes a lenient decoder accepts. */
function spellings(bytes: Uint8Array): Record<string, string> {
  const canonical = canonicalSignatureValue(bytes);
  const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(canonical.at(-1)!);
  const hex = Buffer.from(bytes).toString("hex");
  return {
    standardBase64: Buffer.from(bytes).toString("base64"),
    paddedBase64url: `${canonical}==`,
    embeddedWhitespace: `${canonical.slice(0, 20)} ${canonical.slice(20)}`,
    nonZeroResidualBits: canonical.slice(0, -1) + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[last | 1],
    lowercaseHex: hex,
    prefixedHex: `0x${hex}`,
    doublePrefixedHex: `0x0x${hex}`,
  };
}
const rejectedEverywhere = (verdicts: Record<string, unknown>, accepted: unknown) =>
  assert.deepEqual(verdicts, Object.fromEntries(Object.keys(verdicts).map((key) => [key, accepted])));

test("SIG-6: a current listing signature and a revocation marker accept only the canonical value", async () => {
  const identityScope = { bundleVersion: "1", presentedBy: did, presentedAt: 1, claims: [{ ref: did }] };
  // A per-claim presentation signature is a bare string, not a SIG-6 envelope value.
  const presentation = Buffer.from(await signBytes(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`)).toString("hex");
  const scope = {
    dacsVersion: "1", listingVersion: 1, listingId: "sig6", requiredCapabilities: ["SR-2"],
    seller: { identity: { ...identityScope, presentation: { kind: "per-claim", signatures: [{ ref: did, signature: presentation }] } }, displayName: "Agent" },
    offering: { title: "Service", description: "Description", category: "services.test", tags: [], deliverable: { kind: "attested-payload", payloadFormat: "application/json" } },
    buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
    pipeline: [{ kind: "negotiate-fixed-price" }, { kind: "commit-agreement" }],
    pricing: { kind: "fixed", price: { amount: "1", currency: "DEM" } }, terms: {}, validity: { notBefore: 1 },
  };
  const listingBytes = await signBytes(`dacs-listing:v1:${contentHash(scope)}`);
  const listingWith = (value: string) => verifyListing({ ...scope, signature: { algorithm: "ed25519", signer: did, value } });
  const listing = await listingWith(canonicalSignatureValue(listingBytes));
  assert.equal(listing?.profile, "dacs-v0.1");
  const listingVerdicts: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(spellings(listingBytes))) listingVerdicts[name] = (await listingWith(value)) !== null;
  rejectedEverywhere(listingVerdicts, false);

  const markerScope = { listingId: "sig6", listingVersion: 1, listingContentHash: listing!.contentHash, revokedAt: 1 };
  const markerBytes = await signBytes(`dacs-revocation:v1:${contentHash(markerScope)}`);
  const markerWith = (value: string) => verifyListingRevocation({ ...markerScope, signature: { algorithm: "ed25519", signer: did, value } }, listing!, 1);
  assert.equal(await markerWith(canonicalSignatureValue(markerBytes)), true);
  const markerVerdicts: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(spellings(markerBytes))) markerVerdicts[name] = await markerWith(value);
  rejectedEverywhere(markerVerdicts, false);
});

test("SIG-6: evidence-graph component and bundle signatures accept only the canonical value", async () => {
  const evidence = { evidenceVersion: "1", jobId: "sig6", phase: "pay-dem", outcome: "success", observedAt: 1 };
  const evidenceBytes = await signBytes(`dacs-evidence:v1:${contentHash(evidence)}`);
  const componentWith = (value: string) => verifyComponentSignature(evidence, "evidence", { algorithm: "ed25519", signer: did, value });
  assert.equal(await componentWith(canonicalSignatureValue(evidenceBytes)), true);
  const componentVerdicts: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(spellings(evidenceBytes))) componentVerdicts[name] = await componentWith(value);
  rejectedEverywhere(componentVerdicts, false);

  // A single-signed abort needs no agreement, so the graph reaches its listing step only when the signature verifies.
  const other = `did:demos:agent:${"1".repeat(64)}`;
  const bundleScope = {
    bundleVersion: "1", jobId: "sig6", outcome: "aborted-by-self", listingRef: { listingId: "sig6", version: 1, contentHash: "0".repeat(64) },
    parties: [{ role: "buyer", primaryClaim: did, bundleHash: "a".repeat(64) }, { role: "seller", primaryClaim: other, bundleHash: "b".repeat(64) }],
    phaseSummary: [], vetRecords: [], settlementEvidence: [], recipeRegistryVersion: 1, railRegistryVersion: 1, finalisedAt: 1,
  };
  const bundleBytes = await signBytes(`dacs-bundle:v1:${contentHash(bundleScope)}`);
  const graphWith = async (value: string) => (await buildCurrentEvidenceGraph("stor-1", {
    read: async () => ({ ...bundleScope, anchoredByRole: "buyer", signatures: [{ party: did, algorithm: "ed25519", value }] }),
    resolveListing: async () => null,
  })).signaturesVerified;
  assert.equal(await graphWith(canonicalSignatureValue(bundleBytes)), true);
  const bundleVerdicts: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(spellings(bundleBytes))) bundleVerdicts[name] = await graphWith(value);
  rejectedEverywhere(bundleVerdicts, false);
});

test("SIG-6 does not reach the legacy-sdk-v0.1 reader: a draft SDK listing keeps its hex signature", async () => {
  const scope = {
    listingId: "legacy", listingVersion: 1, agentId: did, serviceId: "legacy", name: "Legacy", description: "Draft SDK listing",
    claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"], supportedDelivery: ["deliver-attested-payload"],
  };
  const hex = Buffer.from(await signBytes(`dacs-listing:v1:${contentHash(scope)}`)).toString("hex");
  assert.equal((await verifyListing({ ...scope, signature: { algorithm: "ed25519", signer: did, value: hex } }))?.profile, "legacy-sdk-v0.1");
  assert.equal((await verifyListing({ ...scope, signature: hex }))?.profile, "legacy-sdk-v0.1");
});
