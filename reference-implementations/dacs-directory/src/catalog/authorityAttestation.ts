import { assertValidUnicode, canonicalize, sha256Hex } from "./canonical.js";
type Obj = Record<string, unknown>;
const normalizedHash = (value: unknown) => typeof value === "string" ? value.replace(/^sha256[:-]/i, "").toLowerCase() : "";
/** Method-specific, trusted deployment adapter. It MUST check the required signer,
 * validator roster/epoch and cryptographic proof of the original format.
 * JSON storage is supported; byte formats need a separate reader.
 * A VerifyResult signature alone never authenticates an authority proof. */
export type VerifyAuthorityAttestation = (raw: Obj, ref: Obj, result: Obj) => Promise<boolean>;
/** An adapter that has not answered by then has not authenticated the proof, so a stalled
 * authority service cannot hold an indexing pass, and its data lock, open. */
export const AUTHORITY_VERIFY_TIMEOUT_MS = 30_000;
/** DACS-2 §7.5.2: the proof read here is canonical JSON, so its integrity is
 * sha256(JCS of the whole object, signature fields included) == ref.contentHash.
 * It is checked before, and whatever, the adapter answers. */
export async function authenticateAuthorityAttestation(raw: Obj, ref: Obj, result: Obj,
  verify?: VerifyAuthorityAttestation, timeoutMs = AUTHORITY_VERIFY_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assertValidUnicode(raw); assertValidUnicode(ref); assertValidUnicode(result);
    if (sha256Hex(canonicalize(raw)) !== normalizedHash(ref.contentHash)) return false;
    if (!verify || typeof result.method !== "string") return false;
    const deadline = new Promise<false>((resolve) => { timer = setTimeout(resolve, timeoutMs, false); });
    return Boolean(await Promise.race([verify(raw, ref, result), deadline]));
  } catch { return false; } finally { clearTimeout(timer); }
}
