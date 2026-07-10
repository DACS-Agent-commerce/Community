"use client";
/** Truncated identifier with copy-to-clipboard — hashes and DIDs everywhere. */
import { useState } from "react";

export default function CopyText({ value, head = 18, tail = 6 }: { value: string; head?: number; tail?: number }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > head + tail + 3 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
  return (
    <span className="copytext mono" title={value}>
      {short}
      <button
        className="copy-btn"
        aria-label="Copy"
        onClick={async () => {
          await navigator.clipboard.writeText(value).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}
