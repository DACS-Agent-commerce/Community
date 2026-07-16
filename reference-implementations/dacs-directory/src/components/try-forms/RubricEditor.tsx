"use client";

import { addRow, blankCriterion, removeRow, EVAL_CHECKS, type FieldErrors } from "../try-dacs-forms.js";

type Criterion = Record<string, unknown>;
const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Repeatable EvalBot rubric criteria: id, weight, description, mechanical check. */
export default function RubricEditor({
  idPrefix,
  criteria,
  onChange,
  errors,
  gatewayErrors,
}: {
  idPrefix: string;
  criteria: Criterion[];
  onChange: (next: Criterion[]) => void;
  errors: FieldErrors;
  gatewayErrors: FieldErrors;
}) {
  const update = (index: number, patch: Record<string, unknown>) =>
    onChange(criteria.map((criterion, i) => i === index ? { ...criterion, ...patch } : criterion));
  const updateTest = (index: number, patch: Record<string, unknown>) =>
    update(index, { test: { ...rec(criteria[index]?.test), ...patch } });

  const fieldError = (key: string) => errors[key] || undefined;
  const gatewayError = (key: string) => gatewayErrors[key] || undefined;

  return (
    <div className="repeat-list" role="group" aria-label="Rubric criteria">
      {criteria.map((criterion, index) => {
        const base = `rubric.criteria.${index}`;
        const test = rec(criterion.test);
        return (
          <div className="repeat-row" key={index}>
            <div className="repeat-row-head">
              <strong>Criterion {index + 1}</strong>
              <button type="button" className="ghost-btn" onClick={() => onChange(removeRow(criteria, index, 1))} disabled={criteria.length <= 1} aria-label={`Remove criterion ${index + 1}`}>
                Remove
              </button>
            </div>
            <div className="field-grid">
              <div className="form-field try-field">
                <label htmlFor={`${idPrefix}-id-${index}`}>Identifier<span className="required-mark" title="Required">*</span></label>
                <input id={`${idPrefix}-id-${index}`} className="form-control mono" value={String(criterion.id ?? "")}
                  placeholder="intro" aria-invalid={Boolean(fieldError(`${base}.id`))}
                  onChange={(event) => update(index, { id: event.target.value })} />
                {fieldError(`${base}.id`) && <span className="field-error" role="alert">{fieldError(`${base}.id`)}</span>}
                {gatewayError(`${base}.id`) && <span className="field-error gateway" role="alert">Gateway: {gatewayError(`${base}.id`)}</span>}
              </div>
              <div className="form-field try-field">
                <label htmlFor={`${idPrefix}-weight-${index}`}>Weight<span className="required-mark" title="Required">*</span></label>
                <input id={`${idPrefix}-weight-${index}`} className="form-control" type="number" min={1} step={1}
                  value={typeof criterion.weight === "number" ? criterion.weight : ""}
                  aria-invalid={Boolean(fieldError(`${base}.weight`))}
                  onChange={(event) => update(index, { weight: event.target.value === "" ? undefined : Number(event.target.value) })} />
                {fieldError(`${base}.weight`) && <span className="field-error" role="alert">{fieldError(`${base}.weight`)}</span>}
              </div>
            </div>
            <div className="form-field try-field">
              <label htmlFor={`${idPrefix}-description-${index}`}>Description<span className="required-mark" title="Required">*</span></label>
              <input id={`${idPrefix}-description-${index}`} className="form-control" value={String(criterion.description ?? "")}
                placeholder="Has an introduction" aria-invalid={Boolean(fieldError(`${base}.description`))}
                onChange={(event) => update(index, { description: event.target.value })} />
              {fieldError(`${base}.description`) && <span className="field-error" role="alert">{fieldError(`${base}.description`)}</span>}
            </div>
            <div className="field-grid">
              <div className="form-field try-field">
                <label htmlFor={`${idPrefix}-check-${index}`}>Mechanical check</label>
                <select id={`${idPrefix}-check-${index}`} className="form-control" value={String(test.check ?? EVAL_CHECKS[0])}
                  onChange={(event) => updateTest(index, { check: event.target.value })}>
                  {EVAL_CHECKS.map((check) => <option key={check} value={check}>{check}</option>)}
                </select>
                <span className="field-hint">How EvalBot mechanically verifies this criterion.</span>
              </div>
              <div className="form-field try-field">
                <label htmlFor={`${idPrefix}-needle-${index}`}>Check text{String(test.check ?? "content-includes") !== "min-length" && <span className="required-mark" title="Required">*</span>}</label>
                <input id={`${idPrefix}-needle-${index}`} className="form-control mono" value={String(test.needle ?? "")}
                  placeholder="Introduction" aria-invalid={Boolean(fieldError(`${base}.test.needle`))}
                  onChange={(event) => updateTest(index, { needle: event.target.value })} />
                {fieldError(`${base}.test.needle`) && <span className="field-error" role="alert">{fieldError(`${base}.test.needle`)}</span>}
              </div>
            </div>
          </div>
        );
      })}
      <button type="button" className="ghost-btn add-row" onClick={() => onChange(addRow(criteria, blankCriterion()))}>
        + Add criterion
      </button>
    </div>
  );
}
