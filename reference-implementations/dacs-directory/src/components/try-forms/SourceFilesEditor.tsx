"use client";

import { addRow, removeRow, type FieldErrors, type SourceFile } from "../try-dacs-forms.js";

/** Repeatable {path, content} rows for posted source files. */
export default function SourceFilesEditor({
  idPrefix,
  files,
  onChange,
  errors,
  gatewayErrors,
}: {
  idPrefix: string;
  files: SourceFile[];
  onChange: (next: SourceFile[]) => void;
  errors: FieldErrors;
  gatewayErrors: FieldErrors;
}) {
  const update = (index: number, patch: Partial<SourceFile>) =>
    onChange(files.map((file, i) => i === index ? { ...file, ...patch } : file));
  return (
    <div className="repeat-list" role="group" aria-label="Source files">
      {files.map((file, index) => {
        const pathKey = `files.${index}.path`;
        const contentKey = `files.${index}.content`;
        return (
          <div className="repeat-row" key={index}>
            <div className="repeat-row-head">
              <strong>File {index + 1}</strong>
              <button type="button" className="ghost-btn" onClick={() => onChange(removeRow(files, index, 1))} disabled={files.length <= 1} aria-label={`Remove file ${index + 1}`}>
                Remove
              </button>
            </div>
            <div className="form-field try-field">
              <label htmlFor={`${idPrefix}-path-${index}`}>Path<span className="required-mark" title="Required">*</span></label>
              <input
                id={`${idPrefix}-path-${index}`}
                className="form-control mono"
                value={file.path}
                placeholder="server.js"
                aria-invalid={Boolean(errors[pathKey])}
                onChange={(event) => update(index, { path: event.target.value })}
              />
              {errors[pathKey] && <span className="field-error" role="alert">{errors[pathKey]}</span>}
              {gatewayErrors[pathKey] && <span className="field-error gateway" role="alert">Gateway: {gatewayErrors[pathKey]}</span>}
            </div>
            <div className="form-field try-field">
              <label htmlFor={`${idPrefix}-content-${index}`}>Code<span className="required-mark" title="Required">*</span></label>
              <textarea
                id={`${idPrefix}-content-${index}`}
                className="form-control mono"
                value={file.content}
                rows={6}
                spellCheck={false}
                placeholder={"const userInput = process.argv[2];\n…"}
                aria-invalid={Boolean(errors[contentKey])}
                onChange={(event) => update(index, { content: event.target.value })}
              />
              {errors[contentKey] && <span className="field-error" role="alert">{errors[contentKey]}</span>}
              {gatewayErrors[contentKey] && <span className="field-error gateway" role="alert">Gateway: {gatewayErrors[contentKey]}</span>}
            </div>
          </div>
        );
      })}
      <button type="button" className="ghost-btn add-row" onClick={() => onChange(addRow(files, { path: "", content: "" }))}>
        + Add another file
      </button>
    </div>
  );
}
