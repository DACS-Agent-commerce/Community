/**
 * Owner-signature verification for registrations.
 *
 * The wallet signs a canonical message binding the registration content and a
 * timestamp; the server verifies it against the ed25519 key embedded in the
 * self-describing primaryClaim. Formats accepted: 0x-hex or base64url
 * signatures (wallet builds vary); message must be fresh (±10 min).
 */
// Pure subpaths ONLY — the package barrel re-exports createAgent, whose
// substrate import chain webpack traces into demosdk/rubic (bundler-hostile).
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import type { Registration } from "./types.js";

export function registrationMessage(
  reg: Pick<Registration, "primaryClaim" | "displayName" | "listingAnchors" | "deals">,
  signedAt: number,
): string {
  // Stable, human-inspectable signing payload (what the wallet shows).
  return [
    "dacs-directory registration",
    `claim:${reg.primaryClaim}`,
    `name:${reg.displayName}`,
    `anchors:${sha256Hex(JSON.stringify([...reg.listingAnchors].sort()))}`,
    `deals:${sha256Hex(canonicalize(reg.deals ?? []))}`,
    `at:${signedAt}`,
  ].join("\n");
}

function sigBytes(signature: string): Uint8Array | null {
  // Known wallet quirk: some builds double the prefix ("0x0x…").
  const hex = signature.replace(/^(0x)+/i, "");
  if (/^[0-9a-fA-F]{128}$/.test(hex)) return Uint8Array.from(Buffer.from(hex, "hex"));
  try {
    const b = Buffer.from(signature, "base64url");
    return b.length === 64 ? Uint8Array.from(b) : null;
  } catch {
    return null;
  }
}

export async function verifyOwnerSignature(
  reg: Registration,
  opts: { ignoreFreshness?: boolean } = {},
): Promise<boolean> {
  const os = reg.ownerSignature;
  if (!os) return false;
  // Freshness gates SUBMISSION (replay window); reindex re-verifies the
  // stored signature without it (the content binding + signature still hold).
  if (!opts.ignoreFreshness && Math.abs(Date.now() - os.signedAt) > 10 * 60_000) return false;
  if (os.message !== registrationMessage(reg, os.signedAt)) return false; // bound content
  const keyHex = reg.primaryClaim.match(/([0-9a-fA-F]{64})$/)?.[1];
  const sig = sigBytes(os.signature);
  if (!keyHex || !sig) return false;
  try {
    const key = publicKeyFromRaw(Uint8Array.from(Buffer.from(keyHex, "hex")));
    return await ed25519Verify(Buffer.from(os.message, "utf8"), sig, key);
  } catch {
    return false;
  }
}
