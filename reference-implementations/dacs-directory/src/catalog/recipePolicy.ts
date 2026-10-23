import { resolveDemosPrimaryClaimKey, resolvePrimaryClaimKey, sameResolvedPrimaryClaim, type ResolvePrimaryClaimKey } from "./primaryClaimKey.js";

/** Closed VerificationMethod registry at the DACS-2 source revision in SPEC_PIN. */
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
    if (typeof raw.scheme !== "string" || !Number.isSafeInteger(raw.recipeVersion) || Number(raw.recipeVersion) < 1) return null;
    const recipe = await resolveRecipe(raw.scheme.toLowerCase(), Number(raw.recipeVersion));
    if (!recipe || recipe.scheme !== raw.scheme.toLowerCase() || recipe.recipeVersion !== raw.recipeVersion ||
        recipe.availability !== "live" ||
        !isVerificationMethod(raw.method) || !Array.isArray(recipe.methods) ||
        !recipe.methods.every(isVerificationMethod) || !recipe.methods.includes(raw.method) ||
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
export const resolveConfiguredRecipeSnapshot: ResolveRecipeSnapshot = async (version) => {
  try {
    const snapshots: RecipeSnapshot[] = JSON.parse(process.env.DACS_RECIPE_SNAPSHOTS ?? "[]");
    const matches = snapshots.filter((snapshot) => snapshot.registryVersion === version);
    if (matches.length !== 1 || !Array.isArray(matches[0].recipes)) return null;
    const recipes = matches[0].recipes;
    const keys = recipes.map((recipe) => `${recipe.scheme}:${recipe.recipeVersion}`);
    if (new Set(keys).size !== keys.length || recipes.some((recipe) => !recipe.scheme ||
        !Number.isSafeInteger(recipe.recipeVersion) || recipe.recipeVersion < 1)) return null;
    return matches[0];
  } catch { return null; }
};
