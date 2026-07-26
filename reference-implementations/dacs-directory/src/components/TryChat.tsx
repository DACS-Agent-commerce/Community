"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  SAMPLE_PROCUREMENT_EVENTS,
  SPEAKERS,
  STAGES,
  eventsToConversation,
  type ConversationTurn,
} from "./try-chat-script.js";

const EXPLORER = "https://explorer.demos.sh";

function compact(value: unknown, head = 8, tail = 6): string {
  const text = String(value ?? "");
  return text.length > head + tail + 1 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text;
}

type Mode = "idle" | "replay" | "done";

export default function TryChat() {
  const [mode, setMode] = useState<Mode>("idle");
  const [visible, setVisible] = useState(0);          // turns revealed so far (replay pacing)
  const [showTech, setShowTech] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const turns = useMemo(() => eventsToConversation(SAMPLE_PROCUREMENT_EVENTS), []);
  const shown = mode === "replay" ? turns.slice(0, visible) : mode === "idle" ? [] : turns;
  const currentStage = shown.length ? shown[shown.length - 1]!.stage : 0;
  const complete = mode === "done";

  // Auto-scroll the transcript as turns appear.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [shown.length, mode]);

  // Replay pacing: reveal one turn at a time with a human-readable beat.
  useEffect(() => {
    if (mode !== "replay") return;
    if (visible >= turns.length) { setMode("done"); return; }
    const turn = turns[visible]!;
    const beat = turn.kind === "anchor" ? 900 : turn.kind === "pay" ? 1100 : 700;
    const timer = setTimeout(() => setVisible((n) => n + 1), beat);
    return () => clearTimeout(timer);
  }, [mode, visible, turns]);

  function startReplay() {
    setVisible(0);
    setMode("replay");
  }

  function showFullReplay() {
    setVisible(turns.length);
    setMode("done");
  }

  return (
    <div className="tc-page">
      <header className="tc-hero">
        <div className="tc-kicker"><i /> recorded deal · sec-audit via rfq</div>
        <h1>A recorded deal between two agents.</h1>
        <p>
          The <strong>Butler</strong> (left) buys a code audit from the <strong>Auditor</strong> (right).
          Each step anchors a receipt on the <strong>Demos chain</strong> — this is the evidence from one
          completed purchase.
        </p>
        <div className="tc-controls">
          <button className={`tc-btn ${mode === "replay" || mode === "done" ? "tc-btn-ghost" : "tc-btn-primary"}`} onClick={startReplay} disabled={mode === "replay"}>
            {mode === "done" ? "Watch again" : "Watch the recorded deal"}
          </button>
          {mode === "replay" && <button className="tc-btn tc-btn-ghost" onClick={showFullReplay}>Show the full deal now</button>}
          <Link className="tc-btn tc-btn-ghost" href="/try">
            Run a live deal <small>choose agent · DEM or x402</small>
          </Link>
          <label className="tc-tech-toggle">
            <input type="checkbox" checked={showTech} onChange={(e) => setShowTech(e.target.checked)} /> Show the technical details
          </label>
        </div>
      </header>

      <section className="tc-replay-note" aria-label="Recorded replay disclosure">
        <strong>Recorded RFQ replay · job d27cd332 · 20 July 2026</strong>
        <span>Replays one completed purchase — never starts a job or spends funds. Run one live at <Link href="/try">Try DACS</Link>.</span>
      </section>

      <div className="tc-stagebar" role="list" aria-label="The five steps of a DACS deal">
        {STAGES.map((stage, index) => {
          const state = complete || currentStage > index ? "done" : (shown.length && currentStage === index ? "active" : "todo");
          return (
            <div className={`tc-stage tc-stage-${state}`} role="listitem" key={stage.primitive}>
              <span className="tc-stage-num">{state === "done" ? "✓" : index + 1}</span>
              <div><strong>{stage.name}</strong><small>{stage.primitive}</small><p>{stage.blurb}</p></div>
            </div>
          );
        })}
      </div>

      <section className="tc-stage-legend">
        <span><b className="tc-dot tc-dot-butler" /> Butler — buyer's agent</span>
        <span><b className="tc-dot tc-dot-seller" /> Auditor — seller's agent</span>
        <span><b className="tc-dot tc-dot-chain" /> Demos chain — the public receipt</span>
        <span><b className="tc-dot tc-dot-referee" /> EvalBot — independent judge</span>
      </section>

      <div className="tc-transcript" ref={transcriptRef} aria-live="polite">
        {shown.length === 0 && (
          <div className="tc-empty">
            <p>Press <strong>Watch the recorded deal</strong> to see a genuine purchase play out, step by step.</p>
            <small>The replay uses a genuine on-chain purchase captured from the live network — every transaction link is real.</small>
          </div>
        )}
        {shown.map((turn, index) => (
          <ChatTurn key={turn.id} turn={turn} newStage={index === 0 || shown[index - 1]!.stage !== turn.stage} showTech={showTech} />
        ))}
        {mode === "replay" && !complete && (
          <div className="tc-typing"><span /><span /><span /></div>
        )}
      </div>

      {complete && (
        <div className="tc-outcome">
          <div className="tc-outcome-badge">✓ Recorded deal settled &amp; verified</div>
          <p>The Butler got its audit, the Auditor got paid, and the <strong>entire deal is now a chain of signed receipts</strong> anyone can re-check — the listing, the identity vet, the signed terms, the payment, and the delivery. That is DACS.</p>
          <div className="tc-outcome-actions">
            <button className="tc-btn tc-btn-ghost" onClick={startReplay}>Watch again</button>
            <Link className="tc-btn tc-btn-primary" href="/try">Run a live procurement →</Link>
          </div>
        </div>
      )}
    </div>
  );
}

function ChatTurn({ turn, newStage, showTech }: { turn: ConversationTurn; newStage: boolean; showTech: boolean }) {
  const meta = SPEAKERS[turn.speaker];
  const stage = STAGES[turn.stage]!;
  return (
    <>
      {newStage && (
        <div className="tc-stage-divider"><span>{stage.primitive}</span><b>{stage.name}</b><i>{stage.blurb}</i></div>
      )}
      <div className={`tc-turn tc-turn-${meta.side} tc-turn-${turn.speaker}`}>
        {meta.side !== "center" && <span className="tc-avatar" aria-hidden>{meta.avatar}</span>}
        <div className="tc-bubble">
          {meta.side !== "center" && <span className="tc-who">{meta.name} <small>· {meta.role}</small></span>}
          <p>{turn.text}</p>
          {(turn.txRef || turn.anchorRef) && (
            <div className="tc-receipt">
              <span className="tc-receipt-tag">{turn.kind === "pay" ? "payment" : "receipt"}</span>
              {turn.txRef
                ? <a href={`${EXPLORER}/transactions/${turn.txRef}`} target="_blank" rel="noreferrer">verify tx {compact(turn.txRef)} ↗</a>
                : <code>{compact(turn.anchorRef, 12, 6)}</code>}
            </div>
          )}
          {showTech && <div className="tc-raw"><span>gateway event</span><code>{turn.raw}</code></div>}
        </div>
      </div>
    </>
  );
}
