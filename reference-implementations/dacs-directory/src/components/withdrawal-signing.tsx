import React from "react";

export interface WithdrawalSigning {
  algorithm: string;
  signer: string;
  message: string;
  signatureField: string;
  encoding: string;
}

export function WithdrawalSigningInstructions({ signing }: { signing: WithdrawalSigning }) {
  return <div className="note">
    <p>Complete publisher signing before hosting these files. Sign the exact UTF-8 message below with the {signing.algorithm} key for <span className="mono">{signing.signer}</span>.</p>
    <pre className="artifact">{signing.message}</pre>
    <p>Put the unpadded {signing.encoding} signature in <span className="mono">{signing.signatureField}</span> in <span className="mono">agent.json</span> and <span className="mono">agent-card.json</span> when present. Keep <span className="mono">listings.json</span> byte-exact. Generate a new signature if the index or domain changes.</p>
  </div>;
}
