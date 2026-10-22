/**
 * One compatibility seam for the SDK's public verification exports.
 *
 * The current SDK exposes these names from its top-level barrel, but that
 * barrel also statically re-exports optional Node/multi-chain modules. Resolve
 * the public names through their pure implementations until the SDK ships a
 * browser-safe public verification subpath.
 */
export {
  verifyBundleCore,
  type BundleVerification,
} from "../vendor/dacs-sdk/dist/agent/verifyBundleCore.js";
import type { verifySignedArtifact as sdkVerifySignedArtifact } from "../vendor/dacs-sdk/dist/agent/signedArtifact.js";
import { signedBytes } from "@kynesyslabs/dacs/crypto";
import { stripSignature } from "./catalog/canonical.js";
import { legacyListingHash } from "./catalog/legacyListingHash.js";

/** Historical raw-hex artifacts use the same frozen hash profile as MVP Listings. */
export const verifySignedArtifact: typeof sdkVerifySignedArtifact = async (signed, separator, publicKey, verify) => {
  const signature = signed.signature;
  if (typeof signature !== "string") return false;
  // Preserve the historical SDK decoder, including its optional 0x prefix.
  const hex = signature.startsWith("0x") ? signature.slice(2) : signature;
  const bytes = Uint8Array.from((hex.match(/.{1,2}/g) ?? []).map((pair) => parseInt(pair, 16)));
  try {
    return await verify(signedBytes(separator, legacyListingHash(stripSignature(signed))), bytes, publicKey);
  } catch {
    return false;
  }
};
