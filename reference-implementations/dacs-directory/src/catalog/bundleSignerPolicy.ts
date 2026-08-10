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

/** Explicit compatibility identity used only by the legacy SDK reader. */
export function demosSigningIdentity(claim: string): string {
  const key = claim.match(/^(?:did:demos:agent:|0x)?([0-9a-f]{64})$/i)?.[1];
  return key ? key.toLowerCase() : claim;
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
