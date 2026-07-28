/**
 * DACS-1 §6.3.1 Demos agent ClaimReference — `did:demos:agent:<64hex>`.
 *
 * Per the canonical profile (DACS-Standard #296): only the leading `did`
 * scheme token is case-insensitive on read (CF-2, canonicalised to lowercase
 * before comparison); the `demos:agent:` method and the key component are
 * case-sensitive, and an uppercase key is non-canonical — a reader must
 * reject it rather than lowercase it. `demos:0x…` is substrate-address
 * notation, not a registered ClaimReference, and never resolves here.
 */
const DEMOS_AGENT_DID = /^[dD][iI][dD]:(demos:agent:[0-9a-f]{64})$/;

/** Canonical `did:demos:agent:…` form of a claim reference, or null. */
export function canonicalDemosAgentClaim(value: string): string | null {
  const match = DEMOS_AGENT_DID.exec(value);
  return match ? `did:${match[1]}` : null;
}

/** True when the value already is the canonical spelling. */
export function isCanonicalDemosAgentClaim(value: unknown): value is string {
  return typeof value === "string" && canonicalDemosAgentClaim(value) === value;
}
