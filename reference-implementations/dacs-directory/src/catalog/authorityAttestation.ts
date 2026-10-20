import { assertValidUnicode, canonicalize, sha256Hex } from "./canonical.js";
type Obj = Record<string, unknown>;
const normalizedHash = (value: unknown) => typeof value === "string" ? value.replace(/^sha256[:-]/i, "").toLowerCase() : "";
/** Method-specific, trusted deployment adapter. It MUST check the required signer,
 * validator roster/epoch and cryptographic proof of the original format.
 * JSON storage is supported; byte formats need a separate reader.
 * A VerifyResult signature alone never authenticates an authority proof. */
export type VerifyAuthorityAttestation = (raw: Obj, ref: Obj, result: Obj) => Promise<boolean>;
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
