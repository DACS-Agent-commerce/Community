import { isVerificationMethod, validateRecipeResult, type RecipePolicy } from "./recipePolicy.js";
import { domainToASCII } from "node:url";
import type { ResolvedEvidence } from "./evidenceGraph.js";

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj | null => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;
const hash = (v: unknown) => typeof v === "string" ? v.replace(/^sha256[:-]/i, "").toLowerCase() : "";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const SCHEMES = new Set(["did", "key", "domain", "erc8004", "lei", "finra-crd", "sam-uei", "fedramp", "naics", "cmmc", "ofac-clear", "stor-cred",
  "cci-xm", "cci-web2", "cci-pqc", "cci-ud", "cci-nomis", "cci-humanpassport", "cci-ethos", "cci-tlsn"]);

function claimRequirementShape(value: unknown): boolean {
  const cr = rec(value);
  return Boolean(cr && nonempty(cr.scheme) && typeof cr.verificationRequired === "boolean");
}

/** Shape validation is independent of the caller's signature/authority authentication. */
function verifyResultShape(value: unknown): boolean {
  const vr = rec(value);
  const attestation = rec(vr?.attestation); const anchor = rec(attestation?.anchor);
  const signature = rec(vr?.signature);
  return Boolean(vr && vr.resultVersion === "1" && nonempty(vr.scheme) && nonempty(vr.identifier) &&
    Number.isSafeInteger(vr.recipeVersion) && Number(vr.recipeVersion) > 0 && isVerificationMethod(vr.method) &&
    typeof vr.decision === "string" && ["pass", "fail", "indeterminate", "error"].includes(vr.decision) &&
    typeof vr.reason === "string" && finite(vr.fetchedAt) && finite(vr.verifiedAt) &&
    (vr.validUntil === undefined || finite(vr.validUntil)) && (vr.data === undefined || rec(vr.data)) &&
    anchor && typeof anchor.kind === "string" && ["storage-program", "ipfs", "https"].includes(anchor.kind) && nonempty(anchor.locator) &&
    /^[0-9a-f]{64}$/.test(hash(attestation?.contentHash)) &&
    (attestation?.signer === undefined || nonempty(attestation.signer)) &&
    signature && nonempty(signature.signer) && nonempty(signature.algorithm) && nonempty(signature.value));
}

/** Convert DNS labels without URL delimiters or the URL parser's IPv4 rewriting. */
function domainIdentity(value: string): string | null {
  if (/[\p{C}\p{Z}\/\\#@:?\[\]%]/u.test(value)) return null;
  const labels = value.toLowerCase().replace(/[\u3002\uff0e\uff61]/g, ".").split(".");
  const converted: string[] = [];
  for (const label of labels) {
    if (!label) return null;
    // The sentinel makes even numeric labels DNS names rather than IPv4 hosts.
    const suffix = ".invalid";
    const ascii = domainToASCII(label + suffix);
    if (!ascii.endsWith(suffix)) return null;
    const result = ascii.slice(0, -suffix.length);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(result)) return null;
    converted.push(result);
  }
  const domain = converted.join(".");
  return domain.length <= 253 ? domain : null;
}

/** CF-1/CF-3: parameters are qualifiers, never part of the claim identity. */
function claimIdentity(value: unknown): { scheme: string; identifier: string } | null {
  const obj = rec(value);
  const parts = typeof value === "string" ? value.split("?", 1)[0].match(/^([^:]+):(.+)$/s) : null;
  const scheme = (parts?.[1] ?? obj?.scheme);
  const identifier = (parts?.[2] ?? obj?.identifier);
  if (typeof scheme !== "string" || typeof identifier !== "string" || !identifier) return null;
  const name = scheme.toLowerCase();
  if (!SCHEMES.has(name)) return null;
  let id = identifier.normalize("NFC");
  if (["lei", "sam-uei"].includes(name)) id = id.toUpperCase();
  if (name === "finra-crd" && /^\d+$/.test(id)) id = BigInt(id).toString();
  if (name === "key") id = id.replace(/^0x/i, "").toLowerCase();
  if (name === "domain") {
    const domain = domainIdentity(id);
    if (!domain) return null;
    id = domain;
  }
  if (name === "erc8004") {
    const match = id.match(/^(\d+):(0x[0-9a-fA-F]{40}):(\d+)$/);
    if (!match) return null;
    id = `${BigInt(match[1])}:${match[2].toLowerCase()}:${BigInt(match[3])}`;
  }
  return id ? { scheme: name, identifier: id } : null;
}

/** Trusted deployment adapter: authenticate holder/key linkage AND presentation
 * control for this exact primary and session, including replay/freshness checks.
 * A registry existence result, or a flag in the identity, is not control proof. */
export type VerifyPrimaryClaimControl = (context: {
  identity: Obj; primary: { scheme: string; identifier: string }; claim: Obj;
  result: ResolvedEvidence; at: number; finalisedAt: number;
}) => Promise<boolean>;

/** DACS-1 MA-1..3 and DACS-2 §7.12, evaluated at the signed vet time.
 * Callers authenticate result signatures first and supply the session-pinned recipe roster.
 * Any presented primary also requires a trusted, method-specific control verifier. */
export async function matchesVetRequirement(identity: Obj, requirement: Obj, results: ResolvedEvidence[], at: unknown, finalisedAt: unknown, recipes?: readonly RecipePolicy[], verifyPrimaryControl?: VerifyPrimaryClaimControl): Promise<boolean> {
  if (!finite(at) || !finite(finalisedAt) || at > finalisedAt) return false;
  // Validate all alternatives before matching: a successful oneOf member must
  // not hide a malformed member, and only an explicit false may relax decision.
  if (requirement.requirementVersion !== "1" ||
      !Array.isArray(requirement.required) || !requirement.required.every(claimRequirementShape) ||
      (requirement.oneOf !== undefined && (!Array.isArray(requirement.oneOf) ||
        !requirement.oneOf.every((group) => Array.isArray(group) && group.every(claimRequirementShape))))) return false;
  if (!recipes || new Set(recipes.map((recipe) => `${recipe.scheme}:${recipe.recipeVersion}`)).size !== recipes.length) return false;
  const policies = new Map<ResolvedEvidence, RecipePolicy>();
  for (const result of results) {
    if (result.kind !== "verify-result" || !verifyResultShape(result.raw)) return false;
    const policy = await validateRecipeResult(result.raw, async (scheme, version) =>
      recipes.find((recipe) => recipe.scheme === scheme && recipe.recipeVersion === version) ?? null);
    if (!policy) return false;
    policies.set(result, policy);
  }
  const claims = Array.isArray(identity.claims) ? identity.claims.map(rec).filter((c): c is Obj => Boolean(c)) : [];
  const referencedResult = (claim: Obj) => {
    const ref = rec(claim.verifiedBy); const anchor = rec(ref?.anchor);
    return anchor?.kind === "storage-program" ? results.find((r) => r.locator === anchor.locator && r.contentHash === hash(ref?.contentHash)) : undefined;
  };
  const satisfies = (claim: Obj, cr: Obj, selectRecipe = true): boolean => {
    const id = claimIdentity(claim.ref);
    const ref = rec(claim.verifiedBy); const anchor = rec(ref?.anchor);
    if (!id || typeof cr.scheme !== "string" || id.scheme !== cr.scheme.toLowerCase() || !ref || anchor?.kind !== "storage-program") return false;
    // Only the exact result named by the presented claim AND this composite counts.
    const result = referencedResult(claim);
    if (!result || result.raw.recipeVersion !== ref.recipeVersion ||
        (cr.recipeVersion !== undefined && result.raw.recipeVersion !== cr.recipeVersion)) return false;
    const vr = result.raw;
    {
      const members = recipes.filter((recipe) => recipe.scheme === id.scheme);
      if (!members.some((recipe) => recipe.recipeVersion === vr.recipeVersion) ||
          (selectRecipe && cr.recipeVersion === undefined && vr.recipeVersion !== Math.max(...members.map((recipe) => recipe.recipeVersion)))) return false;
    }
    const verified = claimIdentity({ scheme: vr.scheme, identifier: vr.identifier });
    if (!verified || verified.scheme !== id.scheme || verified.identifier !== id.identifier || (cr.verificationRequired === true && vr.decision !== "pass") ||
        !finite(vr.verifiedAt) || vr.verifiedAt > at) return false;
    let expiry = vr.validUntil;
    if (expiry === undefined) {
      const policy = policies.get(result);
      if (!policy) return false;
      expiry = vr.verifiedAt + policy.defaultMaxAgeSec * 1000;
    }
    if (!finite(expiry) || expiry < vr.verifiedAt ||
        (claim.expiresAt !== undefined && !finite(claim.expiresAt)) ||
        at > Math.min(expiry, finite(claim.expiresAt) ? claim.expiresAt : Infinity)) return false;
    if (cr.maxAge !== undefined && (!finite(cr.maxAge) || cr.maxAge < 0 || at - vr.verifiedAt > cr.maxAge * 1000)) return false;
    // No scheme-specific parameter interpreter is enabled in this profile. Unknown
    // requirement parameters MUST be unmatched (DACS-1 §6.3.3), never trusted from metadata.
    if (cr.parameters !== undefined && (!rec(cr.parameters) || Object.keys(cr.parameters as Obj).length > 0)) return false;
    return true;
  };
  const find = (cr: unknown) => Boolean(rec(cr) && claims.some((claim) => satisfies(claim, cr as Obj)));
  if (!Array.isArray(requirement.required) || !requirement.required.every(find)) return false;
  if (requirement.oneOf !== undefined && (!Array.isArray(requirement.oneOf) ||
      !requirement.oneOf.every((group) => Array.isArray(group) && group.some(find)))) return false;
  if (requirement.primaryClaimSelector !== undefined || identity.presentedBy !== undefined) {
    const primary = claimIdentity(identity.presentedBy);
    if (!primary || (requirement.primaryClaimSelector !== undefined &&
        (typeof requirement.primaryClaimSelector !== "string" || primary.scheme !== requirement.primaryClaimSelector.toLowerCase()))) return false;
    const claim = claims.find((claim) => {
      const id = claimIdentity(claim.ref);
      return id?.scheme === primary.scheme && id.identifier === primary.identifier &&
        satisfies(claim, { scheme: primary.scheme, verificationRequired: true }, false);
    });
    const result = claim && referencedResult(claim);
    if (!claim || !result || !verifyPrimaryControl) return false;
    try {
      if (await verifyPrimaryControl({ identity, primary, claim, result, at, finalisedAt }) !== true) return false;
    } catch { return false; }
  }
  return true;
}
