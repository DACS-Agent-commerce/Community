// Focused recovery tests isolate SDK admission and deployment policy. They use
// production SQLite, chain reads and builder code, plus real Node Ed25519.
// These fixtures do not test Standard conformance or replace SDK integration tests.
import { createHash, createPublicKey, verify } from "node:crypto";

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
export const contentHash = (value) => sha256Hex(canonicalize(value));
export const stripSignature = ({ signature: _signature, ...scope }) => scope;
export const listingAddress = (seller, id, version) => `dacs1:${encodeURIComponent(seller)}:${id}:v${version}`;
export const logicalToStorageProgramName = (logical) => `listing-${Buffer.from(logical).toString("base64url")}`;
export const publicKeyFromRaw = (bytes) => createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]), format: "der", type: "spki",
});
export const ed25519Verify = (message, signature, key) => verify(null, message, key, signature);
export const isListing = (listing) => listing.dacsVersion === "1" && listing.signature?.algorithm === "ed25519";
export const resolveListingRails = ({ inCodeDefinitions }) => ({
  disposition: inCodeDefinitions.every((definition) => definition.signatureValid) ? "verified" : "indeterminate",
});
export const resolveListingPayloadVerificationCapability = async () => ({ disposition: "not-applicable" });
/** What the fixture node's deployment check reports; a test may set a refusal or an Error to throw. */
export const nodeDeployment = { current: { ok: true, chainIdentity: "fixture-chain" } };
export const pinnedNodeDeployment = async () => {
  if (nodeDeployment.current instanceof Error) throw nodeDeployment.current;
  return nodeDeployment.current;
};
export const registrationMessage = (registration, at) => JSON.stringify({ registration, at });
export async function verifyStoredListing(listing) {
  const { signature, ...scope } = listing;
  const sellerClaim = scope.seller?.identity?.presentedBy;
  if (!signature || signature.signer !== sellerClaim || !isListing(listing)) return null;
  try {
    const key = publicKeyFromRaw(Buffer.from(sellerClaim.split(":").at(-1), "hex"));
    if (!ed25519Verify(Buffer.from(`dacs-listing:v1:${contentHash(scope)}`), Buffer.from(signature.value, "base64url"), key)) return null;
    return { profile: "dacs-v0.1", scope, sellerClaim, contentHash: contentHash(scope) };
  } catch { return null; }
}
// Unrelated store migrations operate on an empty catalog in this harness.
export const bindsListingTuple = () => { throw new Error("unexpected revocation work"); };
export const normalizeSubmittedDomain = () => { throw new Error("unexpected domain work"); };
export const revocationBindingKey = () => { throw new Error("unexpected revocation work"); };
