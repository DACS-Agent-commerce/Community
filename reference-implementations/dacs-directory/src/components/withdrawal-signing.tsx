import React from "react";
import { verifyPrimaryClaimSignature } from "@/src/catalog/primaryClaimKey";
import { canonicalSignatureBytes, importLegacySignatureValue } from "@/src/catalog/signatureValue";

export interface WithdrawalSigning {
  algorithm: string;
  signer: string;
  message: string;
  signatureField: string;
  encoding: string;
}

const CARD_PATHS = ["/.well-known/agent.json", "/.well-known/agent-card.json"];

/**
 * Put a wallet's signature over `signing.message` into every generated card. The wallet returns
 * hex; the field holds unpadded Base64URL, the only spelling the crawler accepts. A signature that
 * does not verify for this seller and message is refused: the crawler would silently treat the
 * index as unsigned. listings.json is left byte-exact.
 */
export async function applyPublisherSignature(files: Record<string, string>, signing: WithdrawalSigning, walletSignature: string): Promise<Record<string, string>> {
  const value = importLegacySignatureValue(walletSignature.replace(/^(0x)+/i, "").toLowerCase(), "lowercase-hex");
  const bytes = value ? canonicalSignatureBytes(value) : null;
  if (!value || !bytes) throw new Error("The wallet returned a signature that is not a 64-byte Ed25519 signature.");
  if (!await verifyPrimaryClaimSignature(new TextEncoder().encode(signing.message), bytes, signing.signer, signing.algorithm)) {
    throw new Error("The wallet signature does not verify for this seller and message. Connect the seller's wallet and sign again.");
  }
  const signed = { ...files };
  for (const path of CARD_PATHS) {
    if (signed[path] === undefined) continue;
    const card = JSON.parse(signed[path]) as { dacs: { listings: { publisherSignature?: string } } };
    card.dacs.listings.publisherSignature = value;
    signed[path] = JSON.stringify(card, null, 2);
  }
  return signed;
}

export function WithdrawalSigningInstructions({ signing }: { signing: WithdrawalSigning }) {
  return <div className="note">
    <p>Complete publisher signing before hosting these files. Sign the exact UTF-8 message below with the {signing.algorithm} key for <span className="mono">{signing.signer}</span>.</p>
    <pre className="artifact">{signing.message}</pre>
    <p>Put the unpadded {signing.encoding} signature in <span className="mono">{signing.signatureField}</span> in <span className="mono">agent.json</span> and <span className="mono">agent-card.json</span>. Keep <span className="mono">listings.json</span> byte-exact. Every generation is a new index: sign it again before hosting. Once a signed index has been crawled, hosting an unsigned one withholds every listing in that signed index until a newer signed index is crawled.</p>
  </div>;
}
