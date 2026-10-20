import { authenticateAuthorityAttestation, installedAuthorityVerifier, type VerifyAuthorityAttestation } from "./authorityAttestation.js";
import { readAnchor } from "./chain.js";
import { artifactHash, isCurrentRef, verifyComponentSignature } from "./evidenceGraph.js";
import {
  resolveDemosPrimaryClaimKey,
  type ResolvePrimaryClaimKey,
} from "./primaryClaimKey.js";
import type { IdentityTier } from "./types.js";
import { resolveConfiguredRecipe, validateRecipeResult, type ResolveRecipe } from "./recipePolicy.js";
import { claimIdentity, verifyResultShape } from "./vetClaimRules.js";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj | null => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
const normalizeHash = (value: unknown) => typeof value === "string" ? value.replace(/^sha256[:-]/i, "").toLowerCase() : "";
const INSTITUTIONAL = new Set(["lei", "finra-crd", "sam-uei", "fedramp", "cmmc", "naics"]);

export { resolveConfiguredRecipe, type RecipePolicy, type ResolveRecipe } from "./recipePolicy.js";

async function verifiedClaim(
  claim: Obj,
  now: number,
  resolveRecipe: ResolveRecipe,
  read: typeof readAnchor,
  resolveKey: ResolvePrimaryClaimKey,
  verifyAttestation?: VerifyAuthorityAttestation,
): Promise<{ scheme: string } | null> {
  if (claim.issuedAt !== undefined && (typeof claim.issuedAt !== "number" || !Number.isFinite(claim.issuedAt))) return null;
  // DACS-1 §6.3.1 / CORE CF-1..3: both identities compare in canonical form; an unregistered scheme is unverified (BR-4).
  const id = claimIdentity(claim.ref); const ref = obj(claim.verifiedBy);
  if (!id || !ref || !isCurrentRef(ref) || !Number.isSafeInteger(ref.recipeVersion)) return null;
  const raw = await read(ref.anchor.locator); if (!raw) return null;
  if (artifactHash(raw, "verify-result") !== normalizeHash(ref.contentHash)) return null;
  const verified = claimIdentity({ scheme: raw.scheme, identifier: raw.identifier });
  if (!verifyResultShape(raw) || !verified || verified.scheme !== id.scheme || verified.identifier !== id.identifier ||
      raw.decision !== "pass" || raw.recipeVersion !== ref.recipeVersion || typeof raw.verifiedAt !== "number") return null;
  const signature = obj(raw.signature);
  if (!signature || !(await verifyComponentSignature(raw, "verify-result", signature, resolveKey))) return null;
  const recipe = await validateRecipeResult(raw, resolveRecipe, resolveKey);
  // A tier has no per-result availability disclosure, so only live recipes can elevate it (RAV-2).
  if (!recipe || recipe.availability !== "live") return null;
  if (!Number.isFinite(raw.verifiedAt) || raw.verifiedAt > now ||
      (raw.validUntil !== undefined && (typeof raw.validUntil !== "number" || !Number.isFinite(raw.validUntil))) ||
      (claim.expiresAt !== undefined && (typeof claim.expiresAt !== "number" || !Number.isFinite(claim.expiresAt)))) return null;
  const authorityExpiry = typeof raw.validUntil === "number" ? raw.validUntil : raw.verifiedAt + recipe.defaultMaxAgeSec * 1000;
  const wrapperExpiry = typeof claim.expiresAt === "number" ? claim.expiresAt : Infinity;
  if (authorityExpiry < raw.verifiedAt || now > Math.min(authorityExpiry, wrapperExpiry)) return null;
  // Authority proof authentication is independent of the VerifyResult signer.
  const attestation = obj(raw.attestation);
  if (!attestation || !isCurrentRef(attestation)) return null;
  const attested = await read(attestation.anchor.locator); if (!attested || !(await authenticateAuthorityAttestation(attested, attestation, raw, verifyAttestation))) return null;
  return { scheme: id.scheme };
}

/** Directory extension over IT-1..IT-3, which define the tier of one IdentityBundle: a seller has the
 * highest tier among the bundles its indexed listings carry, revoked or withheld listings included. */
export function sellerIdentityTier(tiers: readonly IdentityTier[]): IdentityTier {
  return tiers.includes("institutional") ? "institutional" : tiers.includes("verified") ? "verified" : "self-declared";
}

export async function deriveIdentityTier(
  identityBundle: Obj | undefined,
  resolveRecipe: ResolveRecipe = resolveConfiguredRecipe,
  now = Date.now(),
  read: typeof readAnchor = readAnchor,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
  /** Defaults to the installed deployment verifier; every indexing entry point relies on this default. */
  verifyAttestation: VerifyAuthorityAttestation | undefined = installedAuthorityVerifier(),
): Promise<IdentityTier> {
  const claims = Array.isArray(identityBundle?.claims) ? identityBundle.claims.map(obj).filter(Boolean) as Obj[] : [];
  // A claim whose chain artifacts cannot be canonicalized is unverified; the others still count.
  const verified = (await Promise.all(claims.map((claim) =>
    verifiedClaim(claim, now, resolveRecipe, read, resolveKey, verifyAttestation).catch(() => null)))).filter(Boolean) as Array<{ scheme: string }>;
  if (verified.some((claim) => INSTITUTIONAL.has(claim.scheme))) return "institutional";
  return verified.length ? "verified" : "self-declared";
}
