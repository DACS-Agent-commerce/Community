import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";

import { canonicalDemosAgentClaim } from "./claimRef.js";

export interface ResolvedPrimaryClaimKey {
  canonicalClaim: string;
  algorithm: "ed25519";
  publicKey: Uint8Array;
}

/**
 * Deployment-supplied key resolution boundary for registered ClaimReference
 * schemes. Unknown, unavailable, stale, or unsupported claims return null.
 */
export type ResolvePrimaryClaimKey = (
  claim: string,
  algorithm: string,
) => Promise<ResolvedPrimaryClaimKey | null>;

/** The only intrinsic resolver this Demos-focused directory enables today. */
export const resolveDemosPrimaryClaimKey: ResolvePrimaryClaimKey = async (claim, algorithm) => {
  if (algorithm !== "ed25519") return null;
  const canonicalClaim = canonicalDemosAgentClaim(claim);
  if (!canonicalClaim) return null;
  return {
    canonicalClaim,
    algorithm,
    publicKey: Uint8Array.from(Buffer.from(canonicalClaim.slice(-64), "hex")),
  };
};

/** Validate even an injected resolver's result before it reaches crypto. */
export async function resolvePrimaryClaimKey(
  claim: unknown,
  algorithm: unknown,
  resolver: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<ResolvedPrimaryClaimKey | null> {
  if (typeof claim !== "string" || typeof algorithm !== "string") return null;
  try {
    const resolved = await resolver(claim, algorithm);
    if (
      !resolved || resolved.algorithm !== "ed25519" || resolved.algorithm !== algorithm ||
      typeof resolved.canonicalClaim !== "string" || resolved.canonicalClaim.length === 0 ||
      !(resolved.publicKey instanceof Uint8Array) || resolved.publicKey.length !== 32
    ) return null;
    // Constructing the SDK key here catches malformed points/encodings before
    // a caller mistakes a resolver response for a verified identity.
    publicKeyFromRaw(resolved.publicKey);
    return resolved;
  } catch {
    return null;
  }
}

/** Verify and return the authenticated canonical identity, or null. */
export async function verifyPrimaryClaimSignature(
  message: Uint8Array,
  signature: Uint8Array,
  claim: unknown,
  algorithm: unknown,
  resolver: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<ResolvedPrimaryClaimKey | null> {
  const resolved = await resolvePrimaryClaimKey(claim, algorithm, resolver);
  if (!resolved) return null;
  return verifyResolvedPrimaryClaimSignature(message, signature, resolved)
    ? resolved
    : null;
}

export function verifyResolvedPrimaryClaimSignature(
  message: Uint8Array,
  signature: Uint8Array,
  resolved: ResolvedPrimaryClaimKey,
): boolean {
  try {
    return ed25519Verify(message, signature, publicKeyFromRaw(resolved.publicKey));
  } catch {
    return false;
  }
}

/** Compare both canonical identity and authenticated key material. */
export function sameResolvedPrimaryClaim(
  left: ResolvedPrimaryClaimKey,
  right: ResolvedPrimaryClaimKey,
): boolean {
  return left.algorithm === right.algorithm &&
    left.canonicalClaim === right.canonicalClaim &&
    left.publicKey.length === right.publicKey.length &&
    left.publicKey.every((byte, index) => byte === right.publicKey[index]);
}

/** Strict current-profile comparison: Demos scheme canonicalisation, no aliases. */
export function canonicalSigningIdentity(claim: string): string {
  return canonicalDemosAgentClaim(claim) ?? claim;
}
