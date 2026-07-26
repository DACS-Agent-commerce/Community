"use client";

/**
 * Editable key/value string pairs (e.g. oracle product params). Preserves
 * entry order; empty keys are kept while editing and dropped by the caller's
 * transform if left blank.
 */
export default function KeyValueEditor({
  idPrefix,
  label,
  pairs,
  onChange,
}: {
  idPrefix: string;
  label: string;
  pairs: Array<[string, string]>;
  onChange: (next: Array<[string, string]>) => void;
}) {
  const update = (index: number, position: 0 | 1, next: string) =>
    onChange(pairs.map((pair, i) => i === index ? (position === 0 ? [next, pair[1]] : [pair[0], next]) as [string, string] : pair));
  return (
    <div className="repeat-list kv-list" role="group" aria-label={label}>
      {pairs.map(([key, value], index) => (
        <div className="kv-row" key={index}>
          <input
            id={`${idPrefix}-key-${index}`}
            className="form-control mono"
            value={key}
            placeholder="key"
            aria-label={`${label} key ${index + 1}`}
            onChange={(event) => update(index, 0, event.target.value)}
          />
          <input
            id={`${idPrefix}-value-${index}`}
            className="form-control mono"
            value={value}
            placeholder="value"
            aria-label={`${label} value ${index + 1}`}
            onChange={(event) => update(index, 1, event.target.value)}
          />
          <button type="button" className="ghost-btn" onClick={() => onChange(pairs.filter((_, i) => i !== index))} aria-label={`Remove ${label} pair ${index + 1}`}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className="ghost-btn add-row" onClick={() => onChange([...pairs, ["", ""]])}>
        + Add parameter
      </button>
    </div>
  );
}
