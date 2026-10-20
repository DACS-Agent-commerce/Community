import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { VerifyAuthorityAttestation } from "./authorityAttestation.js";
import type { Catalog } from "./types.js";

/** Deployment configuration for identity-tier authority proofs. Every indexing process (the reindex CLI,
 * POST /api/dacs/reindex and POST /api/dacs/index-now) reads it, as each reads DACS_RECIPE_POLICIES. */
export const AUTHORITY_VERIFIER_ENV = "DACS_AUTHORITY_VERIFIER";

/** The configured verifier cannot be used. Indexing stops before it writes; this never means "no verifier". */
export class AuthorityVerifierUnavailable extends Error {
  override readonly name = "AuthorityVerifierUnavailable";
  readonly code = "AUTHORITY_VERIFIER_UNAVAILABLE";
}

export interface AuthorityVerifierConfig {
  /** File URL of the verifier module; null without one, when every seller tier is self-declared. */
  id: string | null;
  /** DACS_AUTHORITY_VERIFIER=none: the operator runs without a verifier on purpose. */
  optedOut: boolean;
  verify?: VerifyAuthorityAttestation;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** DACS_AUTHORITY_VERIFIER names an ES module (absolute path, path relative to the working directory, or
 * file: URL) exporting `verifyAuthorityAttestation`. Unset: no verifier. `none`: no verifier, deliberately.
 * A module that cannot be loaded, or exports no such function, throws AuthorityVerifierUnavailable. None ships. */
export async function loadAuthorityVerifier(env: Record<string, string | undefined> = process.env): Promise<AuthorityVerifierConfig> {
  const spec = env[AUTHORITY_VERIFIER_ENV]?.trim() ?? "";
  if (!spec) return { id: null, optedOut: false };
  if (spec === "none") return { id: null, optedOut: true };
  let id = spec;
  let loaded: Record<string, unknown>;
  try {
    id = spec.startsWith("file:") ? new URL(spec).href : pathToFileURL(resolve(spec)).href;
    // A deployment file read at run time, never bundled by the Next.js build.
    loaded = await import(/* webpackIgnore: true */ id);
  } catch (cause) {
    throw new AuthorityVerifierUnavailable(`${AUTHORITY_VERIFIER_ENV} ${id} could not be loaded: ${message(cause)}`, { cause });
  }
  const verify = loaded.verifyAuthorityAttestation;
  if (typeof verify !== "function") {
    throw new AuthorityVerifierUnavailable(`${AUTHORITY_VERIFIER_ENV} ${id} exports no verifyAuthorityAttestation function`);
  }
  return { id, optedOut: false, verify: verify as VerifyAuthorityAttestation };
}

/** A full reindex re-derives every tier, so it may change verifier. It refuses to drop the one the catalog's
 * tiers were derived with unless DACS_AUTHORITY_VERIFIER=none: a process started without the configuration
 * must not downgrade every seller. */
export function assertBatchTierVerifier(catalog: Catalog, config: AuthorityVerifierConfig): void {
  const recorded = catalog.identityTierVerifier ?? null;
  if (recorded !== null && config.id === null && !config.optedOut) {
    throw new AuthorityVerifierUnavailable(`the catalog's identity tiers were derived with ${recorded}, and ` +
      `${AUTHORITY_VERIFIER_ENV} is unset in this process; set it, or set it to "none" to drop the verifier`);
  }
}

/** An immediate index re-derives one seller, so it must use the verifier the rest of the catalog was
 * derived with. Returns why it cannot, or null. */
export function immediateTierVerifierMismatch(catalog: Catalog, config: AuthorityVerifierConfig): string | null {
  const recorded = catalog.identityTierVerifier ?? null;
  return recorded === config.id ? null : `the catalog's identity tiers were derived with ${recorded ?? "no authority verifier"}, ` +
    `and this process has ${config.id ?? "none"} (${AUTHORITY_VERIFIER_ENV}); run a full reindex with the same configuration first`;
}
