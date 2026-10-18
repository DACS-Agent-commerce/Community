import { canonicalize, sha256Hex } from "../../src/catalog/canonical.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { verifyPrimaryClaimSignature } from "../../src/catalog/primaryClaimKey.js";
import type { VerifyAuthorityAttestation } from "../../src/catalog/authorityAttestation.js";
const seed = new Uint8Array(32).fill(93);
export const authoritySigner = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
export const proofHash = (raw: Record<string, unknown>) => sha256Hex(canonicalize(raw));
export function authorityProof(body: Record<string, unknown>, epoch = 7) {
  const scope = { ...body, epoch, signer: authoritySigner };
  return { ...scope, signature: Buffer.from(ed25519Sign(Buffer.from(`test-authority:v1:${proofHash(scope)}`), privateKeyFromSeed(seed))).toString("base64url") };
}
export const verifyTestAuthority: VerifyAuthorityAttestation = async (raw, ref, result) => {
  if (!["consensus-backed-proxy", "verifiable-credential", "external", "pay-dem", "deliver-storage-program"].includes(String(result.method)) ||
      raw.epoch !== 7 || raw.signer !== authoritySigner || ref.signer !== authoritySigner ||
      proofHash(raw) !== ref.contentHash || typeof raw.signature !== "string") return false;
  const { signature, ...scope } = raw;
  return Boolean(await verifyPrimaryClaimSignature(Buffer.from(`test-authority:v1:${proofHash(scope)}`),
    Buffer.from(signature, "base64url"), authoritySigner, "ed25519"));
};

export const fixtureRecipeSnapshot = async (registryVersion: number) => registryVersion === 1
  ? { registryVersion, recipes: JSON.parse(process.env.DACS_RECIPE_POLICIES ?? "[]") } : null;
