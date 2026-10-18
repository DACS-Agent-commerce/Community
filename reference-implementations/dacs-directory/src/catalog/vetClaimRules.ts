import type { RecipePolicy } from "./recipePolicy.js";
import { domainToASCII } from "node:url";
import type { ResolvedEvidence } from "./evidenceGraph.js";

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj | null => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;
const hash = (v: unknown) => typeof v === "string" ? v.replace(/^sha256[:-]/i, "").toLowerCase() : "";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const SCHEMES = new Set(["did", "key", "domain", "erc8004", "lei", "finra-crd", "sam-uei", "fedramp", "naics", "cmmc", "ofac-clear", "stor-cred",
  "cci-xm", "cci-web2", "cci-pqc", "cci-ud", "cci-nomis", "cci-humanpassport", "cci-ethos", "cci-tlsn"]);

/** CF-1/CF-3: parameters are qualifiers, never part of the claim identity. */
function claimIdentity(value: unknown): { scheme: string; identifier: string } | null {
  const obj = rec(value);
  const parts = typeof value === "string" ? value.split("?", 1)[0].match(/^([^:]+):(.+)$/) : null;
  const scheme = (parts?.[1] ?? obj?.scheme);
  const identifier = (parts?.[2] ?? obj?.identifier);
  if (typeof scheme !== "string" || typeof identifier !== "string" || !identifier) return null;
  const name = scheme.toLowerCase();
  if (!SCHEMES.has(name)) return null;
  let id = identifier.normalize("NFC");
  if (["lei", "sam-uei"].includes(name)) id = id.toUpperCase();
  if (name === "finra-crd" && /^\d+$/.test(id)) id = BigInt(id).toString();
  if (name === "key") id = id.replace(/^0x/i, "").toLowerCase();
  if (name === "domain") id = domainToASCII(id.toLowerCase());
  if (name === "erc8004") {
    const match = id.match(/^(\d+):(0x[0-9a-fA-F]{40}):(\d+)$/);
    if (!match) return null;
    id = `${BigInt(match[1])}:${match[2].toLowerCase()}:${BigInt(match[3])}`;
  }
  return id ? { scheme: name, identifier: id } : null;
}

/** DACS-1 MA-1..3 and DACS-2 §7.12, evaluated at the signed vet time. */
export function matchesVetRequirement(identity: Obj, requirement: Obj, results: ResolvedEvidence[], at: unknown, finalisedAt: unknown, recipes?: readonly RecipePolicy[]): boolean {
  if (!finite(at) || !finite(finalisedAt) || at > finalisedAt) return false;
  const claims = Array.isArray(identity.claims) ? identity.claims.map(rec).filter((c): c is Obj => Boolean(c)) : [];
  const satisfies = (claim: Obj, cr: Obj): boolean => {
    const id = claimIdentity(claim.ref);
    const ref = rec(claim.verifiedBy); const anchor = rec(ref?.anchor);
    if (!id || typeof cr.scheme !== "string" || id.scheme !== cr.scheme.toLowerCase() || !ref || anchor?.kind !== "storage-program") return false;
    // Only the exact result named by the presented claim AND this composite counts.
    const result = results.find((r) => r.locator === anchor.locator && r.contentHash === hash(ref.contentHash));
    if (!result || result.raw.recipeVersion !== ref.recipeVersion ||
        (cr.recipeVersion !== undefined && result.raw.recipeVersion !== cr.recipeVersion)) return false;
    const vr = result.raw;
    if (recipes) {
      const members = recipes.filter((recipe) => recipe.scheme === id.scheme);
      if (!members.some((recipe) => recipe.recipeVersion === vr.recipeVersion) ||
          (cr.recipeVersion === undefined && vr.recipeVersion !== Math.max(...members.map((recipe) => recipe.recipeVersion)))) return false;
    }
    const verified = claimIdentity({ scheme: vr.scheme, identifier: vr.identifier });
    if (!verified || verified.scheme !== id.scheme || verified.identifier !== id.identifier || vr.decision !== "pass" ||
        !finite(vr.verifiedAt) || vr.verifiedAt > at) return false;
    let expiry = vr.validUntil;
    if (expiry === undefined) {
      // A missing pinned recipe cannot manufacture an authority freshness window.
      let policies: unknown;
      try { policies = recipes ?? JSON.parse(process.env.DACS_RECIPE_POLICIES ?? "[]"); } catch { return false; }
      const policy = Array.isArray(policies) ? policies.map(rec).find((p) => p?.scheme === id.scheme && p.recipeVersion === vr.recipeVersion) : null;
      if (!policy || !finite(policy.defaultMaxAgeSec) || policy.defaultMaxAgeSec < 0) return false;
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
  if (requirement.primaryClaimSelector !== undefined) {
    const primary = claimIdentity(identity.presentedBy);
    if (!primary || typeof requirement.primaryClaimSelector !== "string" || primary.scheme !== requirement.primaryClaimSelector.toLowerCase() || !claims.some((claim) => {
      const id = claimIdentity(claim.ref);
      return id?.scheme === primary.scheme && id.identifier === primary.identifier &&
        satisfies(claim, { scheme: primary.scheme, verificationRequired: true });
    })) return false;
  }
  return true;
}
