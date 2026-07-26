"use client";

import type { ReactNode } from "react";

/**
 * One labeled control with required marker, help text, and local + gateway
 * errors. `error` is advisory local validation; `gatewayError` is what the
 * gateway actually rejected (authoritative) and renders distinctly.
 */
export default function FieldRow({
  id,
  label,
  required,
  help,
  error,
  gatewayError,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  help?: string;
  error?: string;
  gatewayError?: string;
  children: ReactNode;
}) {
  const describedBy = [help ? `${id}-help` : null, error ? `${id}-error` : null, gatewayError ? `${id}-gateway` : null]
    .filter(Boolean).join(" ") || undefined;
  return (
    <div className="form-field try-field" data-described-by={describedBy}>
      <label htmlFor={id}>
        {label}
        {required && <span className="required-mark" title="Required">*</span>}
      </label>
      {children}
      {help && <span className="field-hint" id={`${id}-help`}>{help}</span>}
      {error && <span className="field-error" id={`${id}-error`} role="alert">{error}</span>}
      {gatewayError && <span className="field-error gateway" id={`${id}-gateway`} role="alert">Gateway: {gatewayError}</span>}
    </div>
  );
}
