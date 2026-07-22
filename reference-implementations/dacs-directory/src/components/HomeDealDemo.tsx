"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  SAMPLE_PROCUREMENT_EVENTS,
  SPEAKERS,
  STAGES,
  eventsToConversation,
} from "./try-chat-script.js";

const EXPLORER = "https://explorer.demos.sh";

function compact(value: unknown, head = 8, tail = 6): string {
  const text = String(value ?? "");
  return text.length > head + tail + 1 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text;
}

/**
 * Compact, auto-playing loop of the REAL recorded purchase (the same captured
 * run as /try-chat, every tx link genuine). Starts when scrolled into view,
 * pauses on hover, and loops with a short hold on the settled outcome — a
 * homepage hero that shows agent commerce actually happening instead of
 * describing it.
 */
export default function HomeDealDemo() {
  const turns = useMemo(() => eventsToConversation(SAMPLE_PROCUREMENT_EVENTS), []);
  const [visible, setVisible] = useState(0);
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Begin only when the demo is actually on screen.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || started) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setStarted(true);
    }, { threshold: 0.25 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [started]);

  // Reveal one turn per beat; hold on the finished deal, then loop.
  useEffect(() => {
    if (!started || paused) return;
    const finished = visible >= turns.length;
    const beat = finished ? 6_000 : turns[visible]!.kind === "say" ? 850 : 1_150;
    const timer = setTimeout(() => setVisible(finished ? 0 : visible + 1), beat);
    return () => clearTimeout(timer);
  }, [started, paused, visible, turns]);

  // Keep the newest turn in view inside the demo's own scroll area.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [visible]);

  const shown = turns.slice(0, visible);
  const stage = shown.length ? shown[shown.length - 1]!.stage : 0;
  const settled = visible >= turns.length;

  return (
    <div className="hp-demo" ref={rootRef} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="hp-demo-head">
        <span className="hp-live"><i /> recorded deal · sec-audit via rfq</span>
        <div className="hp-demo-stages" aria-label="Deal progress">
          {STAGES.map((item, index) => (
            <span key={item.primitive} className={settled || stage > index ? "done" : stage === index && shown.length ? "active" : ""} title={`${item.primitive} ${item.name}`}>
              {settled || stage > index ? "✓" : index + 1}
            </span>
          ))}
        </div>
      </div>
      <div className="hp-demo-scroll" ref={scrollRef} aria-live="off">
        {shown.map((turn) => {
          const who = SPEAKERS[turn.speaker];
          return (
            <div key={turn.id} className={`tc-turn tc-turn-${who.side} tc-turn-${turn.speaker} hp-turn`}>
              {who.side !== "center" && <span className="tc-avatar" aria-hidden>{who.avatar}</span>}
              <div className="tc-bubble">
                {who.side !== "center" && <span className="tc-who">{who.name}</span>}
                <p>{turn.text}</p>
                {(turn.txRef || turn.anchorRef) && (
                  <div className="tc-receipt">
                    <span className="tc-receipt-tag">{turn.kind === "pay" ? "payment" : "receipt"}</span>
                    {turn.txRef
                      ? <a href={`${EXPLORER}/tx/${turn.txRef}`} target="_blank" rel="noreferrer">tx {compact(turn.txRef)} ↗</a>
                      : <code>{compact(turn.anchorRef, 10, 5)}</code>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {!settled && started && <div className="tc-typing hp-typing"><span /><span /><span /></div>}
        {settled && (
          <div className="hp-settled">settled · five receipts anchored on Demos</div>
        )}
      </div>
      <div className="hp-demo-foot">
        <span>a real purchase, replayed — every hash resolves on the explorer</span>
        <a href="/try-chat">watch with explanations →</a>
      </div>
    </div>
  );
}
