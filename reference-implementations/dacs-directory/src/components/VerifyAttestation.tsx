"use client";
/** In-browser verification of the DACS-X delivery attestation (SIG-4). */
import { useState } from "react";
import "@/src/shims/buffer";
import { ed25519Verify, publicKeyFromRaw, dacsXSeparator } from "@kynesyslabs/dacs/crypto";
// Pure module — safe for client bundles (no substrate/demosdk in its chain).
import { verifySignedArtifact } from "@/vendor/dacs-sdk/dist/agent/signedArtifact.js";

const keyFromDid = (did: string): Uint8Array | null => {
  const hex = did.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
};

export default function VerifyAttestation({
  attestation,
  sellerDid,
}: {
  attestation: Record<string, unknown>;
  sellerDid: string;
}) {
  const [state, setState] = useState<"idle" | "ok" | "bad">("idle");
  const run = async () => {
    const key = keyFromDid(sellerDid);
    if (!key) return setState("bad");
    const ok = await verifySignedArtifact(
      attestation,
      dacsXSeparator("delivery-attestation") as never,
      key,
      async (b: Uint8Array, s: Uint8Array, p: Uint8Array) => ed25519Verify(b, s, publicKeyFromRaw(p)),
    ).catch(() => false);
    setState(ok ? "ok" : "bad");
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button className="copy-btn" onClick={run}>verify signature</button>
      {state === "ok" && <span className="badge ok">valid for displayed seller key ✓</span>}
      {state === "bad" && <span className="badge err">signature invalid ✗</span>}
    </span>
  );
}
