import type { ComponentSignature, IdentityBundle } from "@kynesyslabs/dacs/artifacts";
import {
  resolveDemosPrimaryClaimKey,
  verifyPrimaryClaimSignature,
  type ResolvePrimaryClaimKey,
} from "./primaryClaimKey.js";
// CORE §B.7 SIG-6: canonical unpadded base64url carrying a 64-byte Ed25519 value.
import { canonicalSignatureBytes } from "./signatureValue.js";

/**
 * Independent `verifyListingSignature` for the SDK's ordered Listing reader:
 * decode the wire value as an SDK buyer does and verify it against the
 * signer's resolved key. It never compares an artifact with itself.
 */
export function sdkListingSignatureVerifier(
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
) {
  return async ({ signedBytes, signature }: {
    signedBytes: Uint8Array;
    signature: Readonly<ComponentSignature>;
  }): Promise<boolean> => {
    const bytes = canonicalSignatureBytes(signature.value);
    return Boolean(bytes && await verifyPrimaryClaimSignature(
      signedBytes, bytes, signature.signer, signature.algorithm, resolveKey,
    ));
  };
}

/** Independent per-claim `verifyIdentityPresentation` for the presenting claim. */
export function sdkIdentityPresentationVerifier(
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
) {
  return async ({ bundle, signedBytes }: {
    bundle: Readonly<IdentityBundle>;
    signedBytes: Uint8Array;
  }): Promise<boolean> => {
    const presentation = bundle.presentation;
    if (presentation.kind !== "per-claim") return false;
    const entry = presentation.signatures.find((item) => item.ref === bundle.presentedBy);
    const bytes = entry ? canonicalSignatureBytes(entry.signature) : null;
    return Boolean(bytes && await verifyPrimaryClaimSignature(
      signedBytes, bytes, bundle.presentedBy, "ed25519", resolveKey,
    ));
  };
}
