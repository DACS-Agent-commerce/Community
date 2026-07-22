import type { ProcurementEvent } from "./try-dacs-contract.js";

/**
 * Pure conversation model for the two-agent /try-chat proposal.
 *
 * The gateway emits a flat list of procurement events. This module turns each
 * event into a chat turn attributed to the agent that produced it — Butler
 * (the buyer, left) or the Auditor (the seller, right) — plus on-chain
 * "receipt" turns and the independent EvalBot referee. Every turn keeps the
 * gateway's exact `raw` label so the friendly text never becomes theatre: the
 * UI can always reveal the original evidence string.
 */

export type Speaker = "butler" | "seller" | "chain" | "referee";

/** DACS stage index 0..4 (Identify, Vet, Negotiate, Settle & deliver, Verify). */
export type StageIndex = 0 | 1 | 2 | 3 | 4;

export type ConversationTurn = {
  /** Stable key = source event index. */
  id: number;
  speaker: Speaker;
  stage: StageIndex;
  /** Plain-language line shown in the bubble. */
  text: string;
  /** The gateway's exact event label — the underlying evidence. */
  raw: string;
  /** "say" = spoken line · "anchor" = on-chain receipt · "pay" = DEM payment. */
  kind: "say" | "anchor" | "pay";
  txRef?: string;
  anchorRef?: string;
};

export const SPEAKERS: Record<Speaker, { name: string; role: string; side: "left" | "right" | "center"; avatar: string }> = {
  butler: { name: "Butler", role: "the buyer's agent", side: "left", avatar: "B" },
  seller: { name: "Auditor", role: "the seller's agent", side: "right", avatar: "A" },
  chain: { name: "Demos chain", role: "public ledger", side: "center", avatar: "D" },
  referee: { name: "EvalBot", role: "independent judge", side: "center", avatar: "E" },
};

// Stage names match demos.network: Identify · Vet · Negotiate · Settle · Verify.
export const STAGES: { name: string; primitive: string; blurb: string }[] = [
  { name: "Identify", primitive: "DACS-1", blurb: "A signed, on-chain listing." },
  { name: "Vet", primitive: "DACS-2", blurb: "Check the counterparty." },
  { name: "Negotiate", primitive: "DACS-3", blurb: "Both sides sign the terms." },
  { name: "Settle", primitive: "DACS-4", blurb: "Payment and delivery, with evidence." },
  { name: "Verify", primitive: "DACS-5", blurb: "One bundle anyone can re-check." },
];

/** Gateway phase → DACS stage. Failures/unknowns fall back to the caller's running stage. */
const PHASE_STAGE: Record<string, StageIndex> = {
  queued: 0, connecting: 0, discovering: 0,
  selecting: 1,
  agreeing: 2,
  settling: 3, delivering: 3, recovering: 3,
  verifying: 4, evaluating: 4, complete: 4,
};

const demAmount = (label: string): string => label.match(/([\d.]+)\s*DEM/i)?.[1] ?? "";

/**
 * Map one gateway event to a speaker + friendly line. Anchors (txRef/anchorRef
 * present) become "chain" receipt turns regardless of who triggered them, so
 * the ledger reads as a neutral third party. Unknown labels are attributed to
 * the Butler verbatim — honest fallback, never invented dialogue.
 */
export function describeEvent(event: ProcurementEvent, runningStage: StageIndex): { speaker: Speaker; stage: StageIndex; text: string; kind: ConversationTurn["kind"] } {
  const label = event.label;
  const isAnchor = Boolean(event.txRef || event.anchorRef);
  const stage = event.phase === "failed" ? runningStage : (PHASE_STAGE[event.phase] ?? runningStage);

  // — Identify —
  if (/^Full DACS purchase queued/.test(label)) return { speaker: "butler", stage, kind: "say", text: "I need a security audit on this file, and I want the deal itself to be provable. Finding a seller." };
  if (/Connecting the Butler buyer wallet/.test(label)) return { speaker: "butler", stage, kind: "say", text: "Connecting my wallet and opening a private channel." };
  if (/Resolving the indexed Auditor'?s signed DACS-1 listing/.test(label)) return { speaker: "butler", stage, kind: "say", text: "Pulling the auditor's signed listing from the chain index." };
  if (/failed current-standard verification/.test(label)) return { speaker: "butler", stage, kind: "say", text: "That listing failed verification. Using my configured auditor binding instead." };
  if (/Verified the Auditor listing/.test(label)) return { speaker: "chain", stage, kind: "anchor", text: "Signed listing verified. The seller's offer is on the record." };

  // — Vet —
  if (/Butler scoring the verified listing/.test(label)) return { speaker: "butler", stage, kind: "say", text: "Scoring the offer against budget, capability and quality." };
  if (/opened a signed RFQ channel/.test(label)) return { speaker: "butler", stage, kind: "say", text: "Auditor: I want a content-bound audit of one file. What are your terms?" };
  if (/Identity Vet record anchored/.test(label)) return { speaker: "chain", stage, kind: "anchor", text: "Identity vet anchored. The check itself is now on the record." };

  // — Negotiate —
  if (/opened|scoring/.test(label) === false && /RFQ|quote/.test(label)) return { speaker: "seller", stage, kind: "say", text: "Happy to. Let me price it against your files." };
  if (/Buyer\/seller agreement anchored/.test(label)) return { speaker: "chain", stage, kind: "anchor", text: "Agreed terms anchored." };
  if (/Commitment anchored before payment/.test(label)) return { speaker: "chain", stage, kind: "anchor", text: "Commitment anchored. Terms are locked before any payment." };
  if (/Buyer and Auditor agreed/.test(label)) { const amt = demAmount(label); return { speaker: "seller", stage, kind: "say", text: amt ? `Agreed: quick scan, standard tier, ${amt} DEM.` : "Terms agreed." }; }
  if (/Dual-signed agreement/.test(label)) return { speaker: "chain", stage, kind: "anchor", text: "Both signatures anchored. Neither side can rewrite the terms." };

  // — Settle & deliver —
  if (/^Paying .*DEM to the negotiated Auditor/.test(label)) { const amt = demAmount(label); return { speaker: "butler", stage, kind: "pay", text: amt ? `Sending ${amt} DEM on the agreed rail.` : "Sending payment." }; }
  if (/Payment broadcast on Demos/.test(label)) return { speaker: "chain", stage, kind: "pay", text: "Payment broadcast. Transaction hash below." };
  if (/Auditor verified payment and is scanning/.test(label)) return { speaker: "seller", stage, kind: "say", text: "Payment confirmed. Running the scan." };
  if (/Auditor signed and anchored the content-bound report/.test(label)) return { speaker: "chain", stage, kind: "anchor", text: "Signed report anchored, bound to the exact file contents." };

  // — Verify —
  if (/Buyer anchoring payment evidence/.test(label)) return { speaker: "butler", stage, kind: "say", text: "Anchoring my payment evidence. Requesting your bundle signature." };
  if (/Settlement evidence anchored/.test(label)) return { speaker: "chain", stage, kind: "anchor", text: "Buyer settlement evidence anchored." };
  if (/Buyer attestation bundle anchored/.test(label)) return { speaker: "chain", stage, kind: "anchor", text: "Full bundle anchored: listing, vet, terms, payment, delivery." };
  if (/EvalBot applying and signing the acceptance rubric/.test(label)) return { speaker: "referee", stage, kind: "say", text: "Checking the delivery against the agreed rubric. Verdict signed." };
  if (/Purchase settled, report delivered/.test(label)) return { speaker: "seller", stage, kind: "say", text: "Done. Paid and delivered. Anyone can re-verify this deal from the receipts." };

  // Failures + anything unrecognised: honest, attributed to whoever the phase implies.
  if (event.phase === "failed") return { speaker: "butler", stage, kind: "say", text: `Stopped safely: ${label}` };
  return { speaker: isAnchor ? "chain" : "butler", stage, kind: isAnchor ? "anchor" : "say", text: label };
}

/** Fold a gateway event stream into the ordered two-agent conversation. */
export function eventsToConversation(events: readonly ProcurementEvent[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let stage: StageIndex = 0;
  events.forEach((event, id) => {
    const known = event.phase === "failed" ? undefined : PHASE_STAGE[event.phase];
    if (known !== undefined && known > stage) stage = known;
    const d = describeEvent(event, stage);
    turns.push({ id, speaker: d.speaker, stage: d.stage, text: d.text, raw: event.label, kind: d.kind, txRef: event.txRef, anchorRef: event.anchorRef });
  });
  return turns;
}

/**
 * A REAL successful purchase, captured live from butler.agentcommerce.network
 * (job d27cd332, 2026-07-20). Used to animate the demo without spending DEM;
 * every tx hash below is a genuine on-chain record. Live runs use the same
 * event shape through the same eventsToConversation() path.
 */
export const SAMPLE_PROCUREMENT_EVENTS: ProcurementEvent[] = [
  { phase: "queued", label: "Full DACS purchase queued", at: "2026-07-20T07:51:46.521Z" },
  { phase: "connecting", label: "Connecting the Butler buyer wallet and live L2PS transport", at: "2026-07-20T07:51:46.523Z" },
  { phase: "discovering", label: "Resolving the indexed Auditor's signed DACS-1 listing from chain", at: "2026-07-20T07:51:46.750Z" },
  { phase: "discovering", label: "Verified the Auditor listing advertised by the indexer", at: "2026-07-20T07:51:47.101Z", anchorRef: "stor-d0afc4fa205fb58e53b7aa0403cf1c5b2fe63dcb" },
  { phase: "selecting", label: "Butler scoring the verified listing against budget, capability, quality and rail", at: "2026-07-20T07:51:47.515Z" },
  { phase: "selecting", label: "Butler opened a signed RFQ channel with dacs-auditor", at: "2026-07-20T07:51:47.923Z" },
  { phase: "selecting", label: "Identity Vet record anchored", at: "2026-07-20T07:52:04.330Z", txRef: "658eafe7a97358e42578637a7a9d4c3340a75666040989398e5ff0937f956274", anchorRef: "stor-dd84a65499fc8db99febddab951ac32bcf5505d9" },
  { phase: "selecting", label: "Buyer/seller agreement anchored", at: "2026-07-20T07:52:35.270Z", txRef: "07e9131d3d130da9aba6be8108034a331755a940f92ee56470fb43128e3fa720", anchorRef: "stor-39b76601730caaac37e6a22bb45b5e05a0616a31" },
  { phase: "selecting", label: "Commitment anchored before payment", at: "2026-07-20T07:52:46.243Z", txRef: "c4751eaacb21a390cf8e5c83df14e4a43f9ba34c0630a66445f9230207d8410b", anchorRef: "stor-18f86935eb3e02a37f12fa64022015457780f857" },
  { phase: "agreeing", label: "Buyer and Auditor agreed quick/standard at 2.35 DEM", at: "2026-07-20T07:52:48.333Z" },
  { phase: "agreeing", label: "Dual-signed agreement and commitment anchored before payment", at: "2026-07-20T07:52:48.333Z", anchorRef: "stor-18f86935eb3e02a37f12fa64022015457780f857" },
  { phase: "settling", label: "Paying 2.35 DEM to the negotiated Auditor", at: "2026-07-20T07:52:48.333Z" },
  { phase: "settling", label: "Payment broadcast on Demos", at: "2026-07-20T07:52:49.968Z", txRef: "53dd8a7b34f7d29377c27599e17a5742b2c7296dd048b1235c04359957e0ff24" },
  { phase: "delivering", label: "Auditor verified payment and is scanning the posted source", at: "2026-07-20T07:52:57.985Z" },
  { phase: "delivering", label: "Auditor signed and anchored the content-bound report", at: "2026-07-20T07:53:22.268Z", anchorRef: "stor-fca0580b7b5509b665027cf985cea0942e517056" },
  { phase: "verifying", label: "Buyer anchoring payment evidence and requesting the Auditor's bundle signature", at: "2026-07-20T07:53:22.269Z" },
  { phase: "verifying", label: "Settlement evidence anchored", at: "2026-07-20T07:53:43.083Z", txRef: "e8ed20357a654c4d98acbd3383f07d2306cf0bd63ff8f95533c4b79b780414aa", anchorRef: "stor-d5f0a0fc96e0bc89b6471fa345085748c3f31bf2" },
  { phase: "verifying", label: "Buyer attestation bundle anchored", at: "2026-07-20T07:54:15.328Z", txRef: "7201df09090a43f73c97057659b7daa44a3314c348eab4c22e1cabf21118224b", anchorRef: "stor-e73f88f1b09364b895390cd40ba7b40832582233" },
  { phase: "evaluating", label: "EvalBot applying and signing the acceptance rubric", at: "2026-07-20T07:54:15.665Z" },
  { phase: "complete", label: "Purchase settled, report delivered, and full DACS bundle verified", at: "2026-07-20T07:54:15.745Z" },
];
