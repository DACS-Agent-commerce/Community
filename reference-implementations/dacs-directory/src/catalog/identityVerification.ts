import { contentHash } from "@kynesyslabs/dacs/canonical";
import { readAnchor } from "./chain.js";
import { artifactHash, isCurrentRef, verifyComponentSignature } from "./evidenceGraph.js";
import type { IdentityTier } from "./types.js";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj | null => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
const normalizeHash = (value: unknown) => typeof value === "string" ? value.replace(/^sha256[:-]/i, "").toLowerCase() : "";
const INSTITUTIONAL = new Set(["lei", "finra-crd", "sam-uei", "fedramp", "cmmc", "naics"]);

export interface RecipePolicy {
  scheme: string;
  recipeVersion: number;
  methods: string[];
  defaultMaxAgeSec: number;
  availability: "live" | "operator_gated" | "closed_data" | "bilateral" | "mocked" | "disabled" | "failed";
  trustedResultSigners: string[];
}
export type ResolveRecipe = (scheme: string, version: number) => Promise<RecipePolicy | null>;

/** Deployment policy is explicit and version-pinned; absent policy fails closed. */
export const resolveConfiguredRecipe: ResolveRecipe = async (scheme, version) => {
  try {
    const policies = JSON.parse(process.env.DACS_RECIPE_POLICIES ?? "[]") as RecipePolicy[];
    return policies.find((policy) => policy.scheme === scheme && policy.recipeVersion === version) ?? null;
  } catch { return null; }
};

function claimParts(ref: unknown): { scheme: string; identifier: string } | null {
  if (typeof ref === "string") {
    const at = ref.indexOf(":");
    return at > 0 ? { scheme: ref.slice(0, at), identifier: ref.slice(at + 1) } : null;
  }
  const value = obj(ref);
  return value && typeof value.scheme === "string" && typeof value.identifier === "string"
    ? { scheme: value.scheme, identifier: value.identifier } : null;
}

async function verifiedClaim(claim: Obj, now: number, resolveRecipe: ResolveRecipe, read: typeof readAnchor): Promise<{ scheme: string } | null> {
  const parts = claimParts(claim.ref); const ref = obj(claim.verifiedBy);
  if (!parts || !ref || !isCurrentRef(ref) || !Number.isSafeInteger(ref.recipeVersion)) return null;
  const raw = await read(ref.anchor.locator); if (!raw) return null;
  if (artifactHash(raw, "verify-result") !== normalizeHash(ref.contentHash)) return null;
  if (raw.resultVersion !== "1" || raw.scheme !== parts.scheme || raw.identifier !== parts.identifier ||
      raw.decision !== "pass" || raw.recipeVersion !== ref.recipeVersion || typeof raw.verifiedAt !== "number") return null;
  const signature = obj(raw.signature); if (!signature || !verifyComponentSignature(raw, "verify-result", signature)) return null;
  const recipe = await resolveRecipe(parts.scheme, Number(ref.recipeVersion));
  if (!recipe || !recipe.methods.includes(String(raw.method)) || ["mocked", "disabled", "failed"].includes(recipe.availability) ||
      !recipe.trustedResultSigners.includes(String(signature.signer))) return null;
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

export async function deriveIdentityTier(
  identityBundle: Obj | undefined,
  resolveRecipe: ResolveRecipe = resolveConfiguredRecipe,
  now = Date.now(),
  read: typeof readAnchor = readAnchor,
): Promise<IdentityTier> {
  const claims = Array.isArray(identityBundle?.claims) ? identityBundle.claims.map(obj).filter(Boolean) as Obj[] : [];
  const verified = (await Promise.all(claims.map((claim) => verifiedClaim(claim, now, resolveRecipe, read)))).filter(Boolean) as Array<{ scheme: string }>;
  if (verified.some((claim) => INSTITUTIONAL.has(claim.scheme))) return "institutional";
  return verified.length ? "verified" : "self-declared";
}
