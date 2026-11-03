import { resolveDemosPrimaryClaimKey, resolvePrimaryClaimKey, sameResolvedPrimaryClaim, type ResolvePrimaryClaimKey } from "./primaryClaimKey.js";

/**
 * Closed VerificationMethod registry: the eight kinds of the DACS-2 source revision in SPEC_PIN, plus
 * `demos-gcr-domain`, which that revision lacks and the Standard revision the pinned SDK declares
 * (STANDARD_REV in scripts/setup-sdk.sh) defines.
 */
export const VERIFICATION_METHODS = ["verifiable-credential", "tlsnotary", "zktls", "consensus-backed-proxy",
  "oauth-attested", "evm-rpc", "domain-tls-control", "self-signed", "demos-gcr-domain"] as const;
export const isVerificationMethod = (value: unknown): value is typeof VERIFICATION_METHODS[number] =>
  typeof value === "string" && VERIFICATION_METHODS.some((method) => method === value);

export interface RecipePolicy {
  scheme: string;
  recipeVersion: number;
  methods: string[];
  defaultMaxAgeSec: number;
  availability: "live" | "operator_gated" | "closed_data" | "bilateral" | "mocked" | "disabled" | "failed";
  trustedResultSigners: string[];
}
export type ResolveRecipe = (scheme: string, version: number) => Promise<RecipePolicy | null>;

/** Tier 1 (authority-issued) schemes of the DACS-1 Claim tiers table; DACS-2 §7.3.9 forbids `self-signed` for their recipes. */
export const AUTHORITY_ISSUED_SCHEMES: readonly string[] = ["lei", "finra-crd", "sam-uei", "fedramp", "cmmc", "naics"];

/** A configured recipe or snapshot lists `self-signed` for an authority-issued scheme. */
export class SelfSignedAuthoritySchemeError extends Error {}

/** True when the recipe targets an authority-issued scheme and lists the `self-signed` method. */
function listsSelfSignedForAuthorityScheme(recipe: Partial<RecipePolicy>): boolean {
  return typeof recipe.scheme === "string" && AUTHORITY_ISSUED_SCHEMES.includes(recipe.scheme.toLowerCase()) &&
    Array.isArray(recipe.methods) &&
    recipe.methods.some((method) => typeof method === "string" && method.trim().toLowerCase() === "self-signed");
}

/** Throws SelfSignedAuthoritySchemeError, naming the scheme, for the first recipe that lists `self-signed` for an authority-issued scheme. */
function assertNoSelfSignedAuthorityScheme(recipes: readonly Partial<RecipePolicy>[]): void {
  const offender = recipes.find((recipe) => recipe && listsSelfSignedForAuthorityScheme(recipe));
  if (offender) throw new SelfSignedAuthoritySchemeError(
    `recipe for authority-issued scheme "${offender.scheme}" must not list the self-signed method (DACS-2 §7.3.9)`);
}

/**
 * Deployment policy is explicit and version-pinned; absent or unparsable policy fails closed (null).
 * Throws SelfSignedAuthoritySchemeError when the recipe selected by (scheme, version) lists `self-signed` for an
 * authority-issued scheme; other entries in the list do not affect the lookup.
 */
export const resolveConfiguredRecipe: ResolveRecipe = async (scheme, version) => {
  try {
    const policies = JSON.parse(process.env.DACS_RECIPE_POLICIES ?? "[]") as RecipePolicy[];
    assertNoSelfSignedAuthorityScheme(policies.filter((policy) => policy && policy.recipeVersion === version &&
      typeof policy.scheme === "string" && policy.scheme.toLowerCase() === scheme.toLowerCase()));
    return policies.find((policy) => policy.scheme === scheme && policy.recipeVersion === version) ?? null;
  } catch (error) {
    if (error instanceof SelfSignedAuthoritySchemeError) throw error;
    return null;
  }
};

/** Callers must independently authenticate the result signature and hash-bound authority evidence. */
export async function validateRecipeResult(
  raw: Record<string, unknown>,
  resolveRecipe: ResolveRecipe = resolveConfiguredRecipe,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<RecipePolicy | null> {
  try {
    if (typeof raw.scheme !== "string" || !Number.isSafeInteger(raw.recipeVersion) || Number(raw.recipeVersion) < 1) return null;
    const recipe = await resolveRecipe(raw.scheme.toLowerCase(), Number(raw.recipeVersion));
    if (!recipe || recipe.scheme !== raw.scheme.toLowerCase() || recipe.recipeVersion !== raw.recipeVersion ||
        recipe.availability !== "live" ||
        !isVerificationMethod(raw.method) || !Array.isArray(recipe.methods) ||
        !recipe.methods.every(isVerificationMethod) || !recipe.methods.includes(raw.method) ||
        listsSelfSignedForAuthorityScheme(recipe) ||
        !Array.isArray(recipe.trustedResultSigners) ||
        typeof recipe.defaultMaxAgeSec !== "number" || !Number.isFinite(recipe.defaultMaxAgeSec) || recipe.defaultMaxAgeSec < 0) return null;
    const signature = raw.signature as Record<string, unknown> | undefined;
    if (!signature) return null;
    const signer = await resolvePrimaryClaimKey(signature.signer, signature.algorithm, resolveKey);
    if (!signer) return null;
    for (const claim of recipe.trustedResultSigners) {
      const trusted = await resolvePrimaryClaimKey(claim, signature.algorithm, resolveKey);
      if (trusted && sameResolvedPrimaryClaim(trusted, signer)) return recipe;
    }
    return null;
  } catch { return null; }
}

/** Operator-authenticated historical registry snapshots; never infer a snapshot from
 * a list of individually live policies. The session pin selects this exact roster. */
export interface RecipeSnapshot { registryVersion: number; recipes: RecipePolicy[] }
export type ResolveRecipeSnapshot = (version: number) => Promise<RecipeSnapshot | null>;
/** Throws SelfSignedAuthoritySchemeError when the selected snapshot lists `self-signed` for an authority-issued scheme. */
export const resolveConfiguredRecipeSnapshot: ResolveRecipeSnapshot = async (version) => {
  try {
    const snapshots: RecipeSnapshot[] = JSON.parse(process.env.DACS_RECIPE_SNAPSHOTS ?? "[]");
    const matches = snapshots.filter((snapshot) => snapshot.registryVersion === version);
    if (matches.length !== 1 || !Array.isArray(matches[0].recipes)) return null;
    const recipes = matches[0].recipes;
    assertNoSelfSignedAuthorityScheme(recipes);
    const keys = recipes.map((recipe) => `${recipe.scheme}:${recipe.recipeVersion}`);
    if (new Set(keys).size !== keys.length || recipes.some((recipe) => !recipe.scheme ||
        !Number.isSafeInteger(recipe.recipeVersion) || recipe.recipeVersion < 1)) return null;
    return matches[0];
  } catch (error) {
    if (error instanceof SelfSignedAuthoritySchemeError) throw error;
    return null;
  }
};
