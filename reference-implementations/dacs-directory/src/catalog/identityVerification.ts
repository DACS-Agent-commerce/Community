import { contentHash } from "@kynesyslabs/dacs/canonical";
import { readAnchor } from "./chain.js";
import { artifactHash, isCurrentRef, verifyComponentSignature } from "./evidenceGraph.js";
import {
  resolveDemosPrimaryClaimKey,
  type ResolvePrimaryClaimKey,
} from "./primaryClaimKey.js";
import type { IdentityTier } from "./types.js";
import { resolveConfiguredRecipe, validateRecipeResult, type ResolveRecipe } from "./recipePolicy.js";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj | null => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
const normalizeHash = (value: unknown) => typeof value === "string" ? value.replace(/^sha256[:-]/i, "").toLowerCase() : "";
const INSTITUTIONAL = new Set(["lei", "finra-crd", "sam-uei", "fedramp", "cmmc", "naics"]);

export { resolveConfiguredRecipe, type RecipePolicy, type ResolveRecipe } from "./recipePolicy.js";

function claimParts(ref: unknown): { scheme: string; identifier: string } | null {
  if (typeof ref === "string") {
    const at = ref.indexOf(":");
    return at > 0 ? { scheme: ref.slice(0, at), identifier: ref.slice(at + 1) } : null;
  }
  const value = obj(ref);
  return value && typeof value.scheme === "string" && typeof value.identifier === "string"
    ? { scheme: value.scheme, identifier: value.identifier } : null;
}

async function verifiedClaim(
  claim: Obj,
  now: number,
  resolveRecipe: ResolveRecipe,
  read: typeof readAnchor,
  resolveKey: ResolvePrimaryClaimKey,
): Promise<{ scheme: string } | null> {
  const parts = claimParts(claim.ref); const ref = obj(claim.verifiedBy);
  if (!parts || !ref || !isCurrentRef(ref) || !Number.isSafeInteger(ref.recipeVersion)) return null;
  const raw = await read(ref.anchor.locator); if (!raw) return null;
  if (artifactHash(raw, "verify-result") !== normalizeHash(ref.contentHash)) return null;
  if (raw.resultVersion !== "1" || raw.scheme !== parts.scheme || raw.identifier !== parts.identifier ||
      raw.decision !== "pass" || raw.recipeVersion !== ref.recipeVersion || typeof raw.verifiedAt !== "number") return null;
  const signature = obj(raw.signature);
  if (!signature || !(await verifyComponentSignature(raw, "verify-result", signature, resolveKey))) return null;
  const recipe = await validateRecipeResult(raw, resolveRecipe, resolveKey);
  if (!recipe) return null;
  const authorityExpiry = typeof raw.validUntil === "number" ? raw.validUntil : raw.verifiedAt + recipe.defaultMaxAgeSec * 1000;
  const wrapperExpiry = typeof claim.expiresAt === "number" ? claim.expiresAt : Infinity;
  if (authorityExpiry < raw.verifiedAt || now > Math.min(authorityExpiry, wrapperExpiry)) return null;
  // The VerifyResult's own authority evidence is hash-bound as well. Validator
  // set aggregate-signature semantics remain a deployment trust-policy concern.
  const attestation = obj(raw.attestation);
  if (!attestation || !isCurrentRef(attestation)) return null;
  const attested = await read(attestation.anchor.locator); if (!attested || contentHash(attested) !== normalizeHash(attestation.contentHash)) return null;
  return { scheme: parts.scheme };
}

/** IT-1..IT-3 for a seller: the highest tier any of its current listings' IdentityBundles reaches. */
export function sellerIdentityTier(tiers: readonly IdentityTier[]): IdentityTier {
  return tiers.includes("institutional") ? "institutional" : tiers.includes("verified") ? "verified" : "self-declared";
}

export async function deriveIdentityTier(
  identityBundle: Obj | undefined,
  resolveRecipe: ResolveRecipe = resolveConfiguredRecipe,
  now = Date.now(),
  read: typeof readAnchor = readAnchor,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<IdentityTier> {
  const claims = Array.isArray(identityBundle?.claims) ? identityBundle.claims.map(obj).filter(Boolean) as Obj[] : [];
  // A claim whose chain artifacts cannot be canonicalized is unverified; the others still count.
  const verified = (await Promise.all(claims.map((claim) =>
    verifiedClaim(claim, now, resolveRecipe, read, resolveKey).catch(() => null)))).filter(Boolean) as Array<{ scheme: string }>;
  if (verified.some((claim) => INSTITUTIONAL.has(claim.scheme))) return "institutional";
  return verified.length ? "verified" : "self-declared";
}
