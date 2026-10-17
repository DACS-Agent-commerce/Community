import { resolveDemosPrimaryClaimKey, resolvePrimaryClaimKey, sameResolvedPrimaryClaim, type ResolvePrimaryClaimKey } from "./primaryClaimKey.js";

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

/** Callers must independently authenticate the result signature and hash-bound authority evidence. */
export async function validateRecipeResult(
  raw: Record<string, unknown>,
  resolveRecipe: ResolveRecipe = resolveConfiguredRecipe,
  resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey,
): Promise<RecipePolicy | null> {
  try {
    if (typeof raw.scheme !== "string" || !Number.isSafeInteger(raw.recipeVersion)) return null;
    const recipe = await resolveRecipe(raw.scheme.toLowerCase(), Number(raw.recipeVersion));
    if (!recipe || recipe.scheme !== raw.scheme.toLowerCase() || recipe.recipeVersion !== raw.recipeVersion ||
        !["live", "operator_gated", "closed_data", "bilateral"].includes(recipe.availability) ||
        !Array.isArray(recipe.methods) || !recipe.methods.includes(String(raw.method)) ||
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
