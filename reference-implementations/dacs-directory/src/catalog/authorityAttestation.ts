import { assertValidUnicode, canonicalize, sha256Hex } from "./canonical.js";
type Obj = Record<string, unknown>;
const normalizedHash = (value: unknown) => typeof value === "string" ? value.replace(/^sha256[:-]/i, "").toLowerCase() : "";
/** Method-specific, trusted deployment adapter. It MUST check the required signer,
 * validator roster/epoch and cryptographic proof of the original format.
 * JSON storage is supported; byte formats need a separate reader.
 * A VerifyResult signature alone never authenticates an authority proof. */
export type VerifyAuthorityAttestation = (raw: Obj, ref: Obj, result: Obj) => Promise<boolean>;
const INSTALLED = Symbol.for("dacs-directory.authority-verifier");
type VerifierSlot = typeof globalThis & { [INSTALLED]?: VerifyAuthorityAttestation };
/** Install the deployment's identity-tier verifier once per process, before indexing (a Next.js
 * instrumentation register() hook for the routes; the indexing CLI before reindexAll). The reindex CLI,
 * POST /api/dacs/reindex and POST /api/dacs/index-now all derive tiers with this one instance, so immediate
 * and batch indexing agree. It is kept on globalThis so the startup hook and every route bundle see it.
 * None ships: without one, every seller tier is self-declared. */
export function installAuthorityVerifier(verify: VerifyAuthorityAttestation | undefined): void {
  if (verify !== undefined && typeof verify !== "function") throw new TypeError("authority verifier must be a function");
  (globalThis as VerifierSlot)[INSTALLED] = verify;
}
export const installedAuthorityVerifier = (): VerifyAuthorityAttestation | undefined => (globalThis as VerifierSlot)[INSTALLED];
/** DACS-2 §7.5.2: the proof read here is canonical JSON, so its integrity is
 * sha256(JCS of the whole object, signature fields included) == ref.contentHash.
 * It is checked before, and whatever, the adapter answers. */
export async function authenticateAuthorityAttestation(raw: Obj, ref: Obj, result: Obj,
  verify?: VerifyAuthorityAttestation): Promise<boolean> {
  try {
    assertValidUnicode(raw); assertValidUnicode(ref); assertValidUnicode(result);
    if (sha256Hex(canonicalize(raw)) !== normalizedHash(ref.contentHash)) return false;
    return Boolean(verify && typeof result.method === "string" && await verify(raw, ref, result));
  } catch { return false; }
}
