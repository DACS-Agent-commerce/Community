"use client";

import { useRef, useState } from "react";

const STEPS = [
  { name: "Identify", primitive: "DACS-1", action: "The seller presents a signed IdentityBundle; linked or verified claims remain individually inspectable.", receipt: "Signed bundle presentation" },
  { name: "Vet", primitive: "DACS-2", action: "The buyer checks the identity and any required credentials before committing.", receipt: "Anchored verification record" },
  { name: "Negotiate", primitive: "DACS-3", action: "Both agents fix price, scope, timing, payment, and delivery terms.", receipt: "Buyer- and seller-signed agreement" },
  { name: "Settle", primitive: "DACS-4", action: "Value moves on the selected rail and the transaction reference is captured.", receipt: "Settlement evidence" },
  { name: "Verify", primitive: "DACS-5", action: "The parties bind listing, checks, agreement, payment, and delivery into one result.", receipt: "Attestation bundle" },
];

export default function DacsLifecycle() {
  const [selected, setSelected] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const step = STEPS[selected];
  const choose = (index: number) => {
    const next = (index + STEPS.length) % STEPS.length;
    setSelected(next);
    tabs.current[next]?.focus();
  };
  return (
    <div className="lifecycle-demo">
      <div className="lifecycle-tabs" role="tablist" aria-label="DACS deal lifecycle">
        {STEPS.map((item, index) => <button key={item.name} id={`lifecycle-tab-${index}`} aria-controls={`lifecycle-panel-${index}`} tabIndex={selected === index ? 0 : -1} ref={(node) => { tabs.current[index] = node; }} type="button" role="tab" aria-selected={selected === index} className={selected === index ? "active" : ""} onClick={() => setSelected(index)} onKeyDown={(event) => { if (event.key === "ArrowRight") choose(index + 1); else if (event.key === "ArrowLeft") choose(index - 1); else if (event.key === "Home") choose(0); else if (event.key === "End") choose(STEPS.length - 1); }}>{/* keyboard tab pattern */}<span>0{index + 1}</span>{item.name}</button>)}
      </div>
      <div id={`lifecycle-panel-${selected}`} aria-labelledby={`lifecycle-tab-${selected}`} className="lifecycle-stage" role="tabpanel">
        <div><span className="eyebrow">what happens</span><h3>{step.name}</h3><p>{step.action}</p></div>
        <span className="flow-arrow" aria-hidden>→</span>
        <div><span className="eyebrow">proof created</span><h3>{step.primitive}</h3><p>{step.receipt}</p></div>
      </div>
      <div className="lifecycle-receipt"><span className="sync-dot pulse" aria-hidden /><span className="mono">discover → identify → vet → negotiate → settle → verify</span></div>
    </div>
  );
}
