"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchJsonBeforeDeadline,
  parseProcurementJob,
  type ProcurementEvent,
} from "./try-dacs-contract.js";
import {
  SAMPLE_PROCUREMENT_EVENTS,
  SPEAKERS,
  STAGES,
  eventsToConversation,
  type ConversationTurn,
} from "./try-chat-script.js";

const BUTLER = (process.env.NEXT_PUBLIC_BUTLER_ORIGIN ?? "http://127.0.0.1:8402").replace(/\/$/, "");
const EXPLORER = "https://explorer.demos.sh";

const SAMPLE_INPUT = {
  goal: "procure a content-bound security audit of the posted source",
  budgetDem: 5,
  files: [{ path: "server.js", content: "const userInput = process.argv[2];\neval(userInput);\n" }],
};

function compact(value: unknown, head = 8, tail = 6): string {
  const text = String(value ?? "");
  return text.length > head + tail + 1 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text;
}

type Mode = "idle" | "replay" | "live" | "done" | "error";

export default function TryChat() {
  const [mode, setMode] = useState<Mode>("idle");
  const [events, setEvents] = useState<ProcurementEvent[]>(SAMPLE_PROCUREMENT_EVENTS);
  const [visible, setVisible] = useState(0);          // turns revealed so far (replay pacing)
  const [showTech, setShowTech] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const turns = useMemo(() => eventsToConversation(events), [events]);
  const shown = mode === "replay" ? turns.slice(0, visible) : mode === "idle" ? [] : turns;
  const currentStage = shown.length ? shown[shown.length - 1]!.stage : 0;
  const complete = (mode === "done") || (mode === "replay" && visible >= turns.length);

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

  useEffect(() => () => abortRef.current?.abort(), []);

  const startReplay = useCallback(() => {
    abortRef.current?.abort();
    setEvents(SAMPLE_PROCUREMENT_EVENTS);
    setError(""); setVisible(0); setMode("replay");
  }, []);

  const runLive = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(""); setEvents([]); setVisible(0); setMode("live");
    const deadline = Date.now() + 12 * 60_000;
    try {
      const { response, body } = await fetchJsonBeforeDeadline(`${BUTLER}/demo/procurement`, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(SAMPLE_INPUT), signal: controller.signal,
      }, deadline);
      if (!response.ok) throw new Error(typeof (body as { error?: { message?: string } })?.error?.message === "string" ? (body as { error: { message: string } }).error.message : "The gateway declined the run.");
      let job = parseProcurementJob(body);
      setEvents(job.events);
      while (job.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const poll = await fetchJsonBeforeDeadline(`${BUTLER}/demo/procurement/${encodeURIComponent(job.id)}`, { signal: controller.signal }, deadline);
        job = parseProcurementJob(poll.body);
        setEvents(job.events);
      }
      if (job.status === "failed") { setError(job.error ?? "The run stopped safely."); setMode("error"); return; }
      setMode("done");
    } catch (cause) {
      if ((cause as Error).name !== "AbortError") { setError((cause as Error).message); setMode("error"); }
    }
  }, []);

  return (
    <div className="tc-page">
      <header className="tc-hero">
        <div className="tc-kicker"><i /> A DACS DEAL, IN PLAIN SIGHT</div>
        <h1>Watch two AI agents <em>buy and sell</em>, safely.</h1>
        <p>
          On the left, the <strong>Butler</strong> — a buyer's agent. On the right, the <strong>Auditor</strong> — a
          seller's agent. They discover each other, agree terms, pay, and deliver — and every step leaves a receipt
          anyone can check on the <strong>Demos chain</strong>. No trust required.
        </p>
        <div className="tc-controls">
          <button className={`tc-btn ${mode === "replay" || mode === "done" ? "tc-btn-ghost" : "tc-btn-primary"}`} onClick={startReplay} disabled={mode === "replay" || mode === "live"}>
            {mode === "live" ? "Running live…" : "▶ Watch the deal"}
          </button>
          <button className="tc-btn tc-btn-ghost" onClick={runLive} disabled={mode === "live" || mode === "replay"}>
            Run it live <small>(real agents · spends test DEM)</small>
          </button>
          <label className="tc-tech-toggle">
            <input type="checkbox" checked={showTech} onChange={(e) => setShowTech(e.target.checked)} /> Show the technical details
          </label>
        </div>
      </header>

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
            <p>Press <strong>Watch the deal</strong> to see a real purchase play out, step by step.</p>
            <small>The replay uses a genuine on-chain purchase captured from the live network — every transaction link is real.</small>
          </div>
        )}
        {shown.map((turn, index) => (
          <ChatTurn key={turn.id} turn={turn} newStage={index === 0 || shown[index - 1]!.stage !== turn.stage} showTech={showTech} />
        ))}
        {(mode === "replay" || mode === "live") && !complete && (
          <div className="tc-typing"><span /><span /><span /></div>
        )}
      </div>

      {error && <div className="tc-error"><strong>Stopped safely</strong><p>{error}</p></div>}

      {complete && (
        <div className="tc-outcome">
          <div className="tc-outcome-badge">✓ Settled &amp; verified</div>
          <p>The Butler got its audit, the Auditor got paid, and the <strong>entire deal is now a chain of signed receipts</strong> anyone can re-check — the listing, the identity vet, the signed terms, the payment, and the delivery. That is DACS.</p>
          <div className="tc-outcome-actions">
            <button className="tc-btn tc-btn-ghost" onClick={startReplay}>Watch again</button>
            <a className="tc-btn tc-btn-ghost" href="/try">Open the full playground →</a>
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
              <span className="tc-receipt-tag">{turn.kind === "pay" ? "💰 PAYMENT" : "⛓ ON-CHAIN RECEIPT"}</span>
              {turn.txRef
                ? <a href={`${EXPLORER}/tx/${turn.txRef}`} target="_blank" rel="noreferrer">verify tx {compact(turn.txRef)} ↗</a>
                : <code>{compact(turn.anchorRef, 12, 6)}</code>}
            </div>
          )}
          {showTech && <div className="tc-raw"><span>gateway event</span><code>{turn.raw}</code></div>}
        </div>
      </div>
    </>
  );
}
