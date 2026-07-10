"use client";

import { useState } from "react";

const STEPS = [
  { name: "Identify", primitive: "CCI", action: "The seller presents one durable claim and its linked identity proofs.", receipt: "Signed identity bindings" },
  { name: "Vet", primitive: "DACS-2", action: "The buyer checks the identity and any required credentials before committing.", receipt: "Anchored verification record" },
  { name: "Negotiate", primitive: "DACS-3", action: "Both agents fix price, scope, timing, payment, and delivery terms.", receipt: "Buyer- and seller-signed agreement" },
  { name: "Settle", primitive: "DACS-4", action: "Value moves on the selected rail and the transaction reference is captured.", receipt: "Settlement evidence" },
  { name: "Verify", primitive: "DACS-5", action: "The parties bind listing, checks, agreement, payment, and delivery into one result.", receipt: "Attestation bundle" },
];

export default function DacsLifecycle() {
  const [selected, setSelected] = useState(0);
  const step = STEPS[selected];
  return (
    <div className="lifecycle-demo">
      <div className="lifecycle-tabs" role="tablist" aria-label="DACS deal lifecycle">
        {STEPS.map((item, index) => <button key={item.name} type="button" role="tab" aria-selected={selected === index} className={selected === index ? "active" : ""} onClick={() => setSelected(index)}><span>0{index + 1}</span>{item.name}</button>)}
      </div>
      <div className="lifecycle-stage" role="tabpanel">
        <div><span className="eyebrow">what happens</span><h3>{step.name}</h3><p>{step.action}</p></div>
        <span className="flow-arrow" aria-hidden>→</span>
        <div><span className="eyebrow">proof created</span><h3>{step.primitive}</h3><p>{step.receipt}</p></div>
      </div>
      <div className="lifecycle-receipt"><span className="sync-dot pulse" aria-hidden /><span className="mono">discover → identify → vet → negotiate → settle → verify</span></div>
    </div>
  );
}
