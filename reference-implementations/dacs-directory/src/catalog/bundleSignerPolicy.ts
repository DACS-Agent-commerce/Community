import { canonicalDemosAgentClaim } from "./claimRef.js";
import { canonicalSigningIdentity } from "./primaryClaimKey.js";

const ROLES = new Set(["buyer", "seller", "orchestrator"] as const);
const OUTCOMES = new Set([
  "completed", "failed-perm", "failed-counterparty", "failed-substrate", "aborted-by-self", "aborted-by-other",
]);

type BundleRole = "buyer" | "seller" | "orchestrator";

interface BundleLike {
  outcome?: unknown;
  anchoredByRole?: unknown;
  parties?: unknown;
}

/**
 * DACS-5 §10.4.1 full signature standing: every declared buyer, seller and distinct orchestrator
 * has a verified signature. A copy signed by its anchor alone has lesser standing, which BB-6
 * precedence and the §10.5.1 reconciliation rank below full.
 */
export function fullSignatureStanding(parties: unknown, verifiedSigners: Iterable<string>): boolean {
  const required = (Array.isArray(parties) ? parties : [])
    .filter((party): party is Record<string, unknown> => Boolean(party && typeof party === "object" && !Array.isArray(party)) &&
      ROLES.has((party as Record<string, unknown>).role as BundleRole))
    .map((party) => typeof party.primaryClaim === "string" ? canonicalDemosAgentClaim(party.primaryClaim) : null)
    .filter((claim): claim is string => claim !== null);
  const signed = new Set([...verifiedSigners].map(canonicalDemosAgentClaim).filter((claim): claim is string => claim !== null));
  return required.length >= 2 && required.every((claim) => signed.has(claim));
}

/** Explicit compatibility identity used only by the legacy SDK reader. */
export function demosSigningIdentity(claim: string): string {
  const key = claim.match(/^(?:did:demos:agent:|0x)?([0-9a-f]{64})$/i)?.[1];
  return key ? key.toLowerCase() : claim;
}

/** One session in this catalog: a jobId is unique only per producer, so (buyer, seller, jobId). */
export function dealSessionKey(deal: { owners: { buyer: string; seller: string }; jobId: string }): string {
  return `${demosSigningIdentity(deal.owners.buyer)}\n${demosSigningIdentity(deal.owners.seller)}\n${deal.jobId}`;
}

/**
 * Enforce the signer coverage shared by current, legacy, and browser checks.
 * Abort copies may be single-signed by their anchoring role, or fully signed.
 */
export function bundleSignerPolicy(
  bundle: BundleLike,
  validSigners: Iterable<string>,
  allPresentedSignaturesValid: boolean,
  options: { legacyDemosAliases?: boolean } = {},
): boolean {
  if (!allPresentedSignaturesValid || !Array.isArray(bundle.parties)) return false;
  if (typeof bundle.outcome !== "string" || !OUTCOMES.has(bundle.outcome)) return false;

  const byRole = new Map<BundleRole, string>();
  for (const value of bundle.parties) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const party = value as Record<string, unknown>;
    const role = party.role;
    const claim = party.primaryClaim;
    if (typeof role !== "string" || !ROLES.has(role as BundleRole) || typeof claim !== "string") return false;
    if (byRole.has(role as BundleRole)) return false;
    byRole.set(role as BundleRole, claim);
  }
  if (!byRole.has("buyer") || !byRole.has("seller")) return false;
  const identity = options.legacyDemosAliases ? demosSigningIdentity : canonicalSigningIdentity;
  if (identity(byRole.get("buyer")!) === identity(byRole.get("seller")!)) return false;

  const anchoredByRole = bundle.anchoredByRole;
  if (typeof anchoredByRole !== "string" || !ROLES.has(anchoredByRole as BundleRole)) return false;
  const anchorClaim = byRole.get(anchoredByRole as BundleRole);
  if (!anchorClaim) return false;

  const partyClaims = new Set([...byRole.values()].map(identity));
  const valid = new Set([...validSigners].map(identity));
  if (valid.size === 0 || [...valid].some((claim) => !partyClaims.has(claim))) return false;

  const allRequired = valid.size === partyClaims.size && [...partyClaims].every((claim) => valid.has(claim));
  const abort = bundle.outcome === "aborted-by-self" || bundle.outcome === "aborted-by-other";
  return abort ? (valid.size === 1 && valid.has(identity(anchorClaim))) || allRequired : allRequired;
}
