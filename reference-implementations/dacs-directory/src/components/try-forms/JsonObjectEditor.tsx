"use client";

import { useEffect, useState } from "react";

/**
 * A code editor for a JSON *object* value (e.g. a package.json). Keeps its own
 * text buffer while typing; commits the parsed object upward only when the
 * text is a valid object, and surfaces a parse error otherwise. When the
 * upstream value changes identity (agent switch, Load example, Advanced JSON
 * edit), the buffer resyncs.
 */
export default function JsonObjectEditor({
  id,
  value,
  onChange,
  rows = 8,
  placeholder,
  optional = false,
}: {
  id: string;
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown> | undefined) => void;
  rows?: number;
  placeholder?: string;
  optional?: boolean;
}) {
  const canonical = value === undefined ? "" : JSON.stringify(value, null, 2);
  const [text, setText] = useState(canonical);
  const [parseError, setParseError] = useState("");
  // Resync the buffer when the upstream object changes to something the buffer
  // doesn't already represent (e.g. Load example / Advanced edit).
  useEffect(() => {
    setText((current) => {
      try {
        if (current.trim() === "" && value === undefined) return current;
        if (JSON.stringify(JSON.parse(current)) === JSON.stringify(value)) return current;
      } catch { /* buffer mid-edit; fall through to resync */ }
      setParseError("");
      return canonical;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonical]);

  function edit(nextText: string) {
    setText(nextText);
    if (optional && nextText.trim() === "") {
      setParseError("");
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(nextText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setParseError("Must be a JSON object, not a string, array, or null.");
        return;
      }
      setParseError("");
      onChange(parsed as Record<string, unknown>);
    } catch {
      setParseError("Not valid JSON yet — the last valid value is still what will be submitted.");
    }
  }

  return (
    <>
      <textarea
        id={id}
        className="form-control mono"
        value={text}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        aria-invalid={Boolean(parseError)}
        onChange={(event) => edit(event.target.value)}
      />
      {parseError && <span className="field-error" role="alert">{parseError}</span>}
    </>
  );
}
