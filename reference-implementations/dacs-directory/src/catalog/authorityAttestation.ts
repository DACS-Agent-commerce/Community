import { assertValidUnicode } from "./canonical.js";
type Obj = Record<string, unknown>;
/** Method-specific, trusted deployment adapter. It MUST check the original format's
 * hash scope (including its proof), required signer and validator roster/epoch, and
 * cryptographic proof. JSON storage is supported; byte formats need a separate reader.
 * A VerifyResult signature alone never authenticates an authority proof. */
export type VerifyAuthorityAttestation = (raw: Obj, ref: Obj, result: Obj) => Promise<boolean>;
export async function authenticateAuthorityAttestation(raw: Obj, ref: Obj, result: Obj,
  verify?: VerifyAuthorityAttestation): Promise<boolean> {
  try {
    assertValidUnicode(raw); assertValidUnicode(ref); assertValidUnicode(result);
    return Boolean(verify && typeof result.method === "string" && await verify(raw, ref, result));
  } catch { return false; }
}
