import type { ComponentSignature, IdentityBundle } from "@kynesyslabs/dacs/artifacts";
import {
  canonicalSigningIdentity,
  resolveDemosPrimaryClaimKey,
  verifyPrimaryClaimSignature,
  type ResolvePrimaryClaimKey,
} from "./primaryClaimKey.js";
// CORE §B.7 SIG-6: canonical unpadded base64url carrying a 64-byte Ed25519 value.
import { canonicalSignatureBytes, presentationSignatureBytes } from "./signatureValue.js";

/**
 * Run `verify` with a resolver whose exceptions are remembered, then rethrow
 * the first one. `verifyPrimaryClaimSignature` turns every resolver failure
 * into "not verified"; the SDK reader must see an outage as an error (an
 * indeterminate result), not as an invalid signature.
 */
async function verifyKeepingResolverOutage(
  resolveKey: ResolvePrimaryClaimKey,
  verify: (resolveKey: ResolvePrimaryClaimKey) => Promise<boolean>,
): Promise<boolean> {
  let outage: { error: unknown } | undefined;
  const verified = await verify(async (claim, algorithm) => {
    try {
      return await resolveKey(claim, algorithm);
    } catch (error) {
      outage ??= { error };
      throw error;
    }
  });
  if (outage) throw outage.error;
  return verified;
}

/**
 * Independent `verifyListingSignature` for the SDK's ordered Listing reader:
 * decode the wire value as an SDK buyer does and verify it against the
 * signer's resolved key. It never compares an artifact with itself. It
 * returns false for an invalid signature and throws when the resolver fails.
 */
export function sdkListingSignatureVerifier(
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
) {
  return async ({ signedBytes, signature }: {
    signedBytes: Uint8Array;
    signature: Readonly<ComponentSignature>;
  }): Promise<boolean> => {
    const bytes = canonicalSignatureBytes(signature.value);
    return bytes !== null && verifyKeepingResolverOutage(resolveKey, async (resolver) => Boolean(
      await verifyPrimaryClaimSignature(signedBytes, bytes, signature.signer, signature.algorithm, resolver),
    ));
  };
}

/**
 * Independent per-claim `verifyIdentityPresentation` for the presenting claim.
 * The signature entry is matched to `presentedBy` by CF-3 identity, so advisory
 * parameters on either reference do not matter. It returns false for an
 * invalid presentation and throws when the resolver fails.
 */
export function sdkIdentityPresentationVerifier(
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
) {
  return async ({ bundle, signedBytes }: {
    bundle: Readonly<IdentityBundle>;
    signedBytes: Uint8Array;
  }): Promise<boolean> => {
    const presentation = bundle.presentation;
    if (presentation.kind !== "per-claim") return false;
    const presenter = canonicalSigningIdentity(bundle.presentedBy);
    const entry = presentation.signatures.find((item) => canonicalSigningIdentity(item.ref) === presenter);
    const bytes = entry ? presentationSignatureBytes(entry.signature) : null;
    return bytes !== null && verifyKeepingResolverOutage(resolveKey, async (resolver) => Boolean(
      await verifyPrimaryClaimSignature(signedBytes, bytes, bundle.presentedBy, "ed25519", resolver),
    ));
  };
}
