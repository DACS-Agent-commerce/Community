"use client";

import { useEffect, useState } from "react";
import type { AgentCard } from "../try-dacs-contract.js";
import {
  ACCOUNT_KINDS,
  COMPLIANCE_KINDS,
  DD_KINDS,
  ORACLE_PRODUCTS,
  addRow,
  agentSafetyNote,
  complianceKindChange,
  hasBuiltinForm,
  oracleProductChange,
  parseAgentFieldSchema,
  removeRow,
  type AgentFieldSchema,
  type FieldErrors,
  type SourceFile,
} from "../try-dacs-forms.js";
import FieldRow from "./FieldRow.js";
import JsonObjectEditor from "./JsonObjectEditor.js";
import RubricEditor from "./RubricEditor.js";
import SourceFilesEditor from "./SourceFilesEditor.js";

const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const files = (value: unknown): SourceFile[] =>
  arr(value).map((file) => ({ path: String(rec(file).path ?? ""), content: String(rec(file).content ?? "") }));

export type AgentInputFormProps = {
  agent: AgentCard;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  errors: FieldErrors;
  gatewayErrors: FieldErrors;
};

/**
 * The human-friendly input form for a published agent. Prefers a catalog-
 * published field schema when the gateway provides one; falls back to the
 * built-in per-agent layout; unknown agents fall back to the Advanced JSON
 * editor alone. All controls edit the same gateway input object that
 * `runAgent()` submits unchanged.
 */
export default function AgentInputForm(props: AgentInputFormProps) {
  const { agent, value } = props;
  const schema = parseAgentFieldSchema(agent);
  const paymentRail = value.paymentRail === "pay-x402" ? "pay-x402" : "pay-dem";
  const note = agentSafetyNote(agent.name, paymentRail);
  // Precedence: the nine bespoke forms know their agents best; the gateway's
  // published input schema renders any NEW agent; JSON is the last resort.
  const builtin = hasBuiltinForm(agent.name);
  return (
    <div className="agent-form">
      {note && <p className="agent-form-note">{note}</p>}
      {builtin
        ? <BuiltinForm {...props} />
        : schema
          ? <SchemaForm {...props} schema={schema} />
          : <p className="field-hint">This agent has not published a form schema yet — use the advanced JSON input below.</p>}
      <AdvancedJson {...props} always={!schema && !builtin} />
    </div>
  );
}

/** Generic renderer for a future catalog-published field schema. */
function SchemaForm({ schema, value, onChange, errors, gatewayErrors }: AgentInputFormProps & { schema: AgentFieldSchema[] }) {
  return (
    <div className="field-stack">
      {schema.map((field) => {
        const id = `schema-${field.key}`;
        const current = value[field.key];
        return (
          <FieldRow key={field.key} id={id} label={field.label} required={field.required} help={field.help}
            error={errors[field.key]} gatewayError={gatewayErrors[field.key]}>
            {field.kind === "checkbox" ? (
              <input id={id} type="checkbox" checked={current === true}
                onChange={(event) => onChange({ ...value, [field.key]: event.target.checked })} />
            ) : field.kind === "select" ? (
              <select id={id} className="form-control" value={String(current ?? field.options?.[0] ?? "")}
                onChange={(event) => onChange({ ...value, [field.key]: event.target.value })}>
                {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : field.kind === "textarea" ? (
              <textarea id={id} className="form-control" rows={5} value={String(current ?? "")}
                onChange={(event) => onChange({ ...value, [field.key]: event.target.value })} />
            ) : (
              <input id={id} className="form-control" type={field.kind === "number" ? "number" : "text"}
                min={field.min} max={field.max} value={current === undefined ? "" : String(current)}
                onChange={(event) => onChange({
                  ...value,
                  [field.key]: field.kind === "number"
                    ? (event.target.value === "" ? undefined : Number(event.target.value))
                    : event.target.value,
                })} />
            )}
          </FieldRow>
        );
      })}
    </div>
  );
}

function BuiltinForm(props: AgentInputFormProps) {
  switch (props.agent.name) {
    case "procurement-butler": return <ProcurementForm {...props} />;
    case "oracle-desk": return <OracleForm {...props} />;
    case "dd-researcher": return <DdForm {...props} />;
    case "dep-upgrade": return <DepUpgradeForm {...props} />;
    case "evalbot": return <EvalbotForm {...props} />;
    case "treasury-ops": return <TreasuryForm {...props} />;
    case "site-auditor": return <SiteAuditorForm {...props} />;
    case "sec-audit": return <SecAuditForm {...props} />;
    case "compliance": return <ComplianceForm {...props} />;
    default: return null;
  }
}

function ProcurementForm({ value, onChange, errors, gatewayErrors }: AgentInputFormProps) {
  const x402 = value.paymentRail === "pay-x402";
  const budgetKey = x402 ? "budgetUsdc" : "budgetDem";
  return (
    <div className="field-stack">
      <FieldRow id="proc-goal" label="Goal" required error={errors.goal} gatewayError={gatewayErrors.goal}
        help="What you are purchasing — shown to the counterparties during negotiation.">
        <input id="proc-goal" className="form-control" value={String(value.goal ?? "")}
          placeholder="procure a content-bound security audit of the posted source"
          aria-invalid={Boolean(errors.goal)}
          onChange={(event) => onChange({ ...value, goal: event.target.value })} />
      </FieldRow>
      <FieldRow id="proc-budget" label={x402 ? "USDC budget" : "DEM budget"} required error={errors[budgetKey]} gatewayError={gatewayErrors[budgetKey]}
        help={x402 ? "Hard cap on Base Sepolia USDC spend for this run." : "Hard cap on native Demos spend for this run."}>
        <input id="proc-budget" className="form-control" type="number" min={x402 ? 0.000001 : 1} max={10} step={x402 ? 0.01 : 1}
          value={typeof value[budgetKey] === "number" ? value[budgetKey] as number : ""}
          aria-invalid={Boolean(errors[budgetKey])}
          onChange={(event) => onChange({ ...value, [budgetKey]: event.target.value === "" ? undefined : Number(event.target.value) })} />
      </FieldRow>
      <FieldRow id="proc-files" label="Source files" required error={errors.files} gatewayError={gatewayErrors.files}
        help="The exact content the purchased audit is bound to.">
        <SourceFilesEditor idPrefix="proc-files" files={files(value.files)}
          onChange={(next) => onChange({ ...value, files: next })} errors={errors} gatewayErrors={gatewayErrors} />
      </FieldRow>
    </div>
  );
}

function OracleForm({ value, onChange, errors, gatewayErrors }: AgentInputFormProps) {
  const product = String(value.product ?? ORACLE_PRODUCTS[0]);
  const params = rec(value.params);
  const setParam = (key: string, val: string) => onChange({ ...value, params: { ...params, [key]: val } });
  // Each product's parameters get their own labeled field instead of a raw
  // key/value editor — the buyer shouldn't need to know the param key names.
  return (
    <div className="field-stack">
      <FieldRow id="oracle-product" label="Data product" required error={errors.product} gatewayError={gatewayErrors.product}
        help="The kind of attested value to buy.">
        <select id="oracle-product" className="form-control" value={product}
          onChange={(event) => onChange(oracleProductChange(value, event.target.value))}>
          <option value="crypto-price">Crypto price (a coin in USD)</option>
          <option value="fx-rate">Exchange rate (currency pair)</option>
          <option value="chain-height">Chain height (latest Demos block)</option>
        </select>
      </FieldRow>
      {product === "crypto-price" && (
        <FieldRow id="oracle-coin" label="Coin" required error={errors.params} gatewayError={gatewayErrors.params}
          help="CoinGecko coin id — e.g. bitcoin, ethereum, solana.">
          <input id="oracle-coin" className="form-control mono" value={String(params.id ?? "")}
            placeholder="bitcoin" aria-invalid={Boolean(errors.params)}
            onChange={(event) => setParam("id", event.target.value)} />
        </FieldRow>
      )}
      {product === "fx-rate" && (
        <div className="field-grid">
          <FieldRow id="oracle-base" label="From currency" required error={errors.params} gatewayError={gatewayErrors.params}
            help="ISO code, e.g. USD.">
            <input id="oracle-base" className="form-control mono" value={String(params.base ?? "")}
              placeholder="USD" aria-invalid={Boolean(errors.params)}
              onChange={(event) => setParam("base", event.target.value)} />
          </FieldRow>
          <FieldRow id="oracle-quote" label="To currency" required
            help="ISO code, e.g. EUR.">
            <input id="oracle-quote" className="form-control mono" value={String(params.quote ?? "")}
              placeholder="EUR" onChange={(event) => setParam("quote", event.target.value)} />
          </FieldRow>
        </div>
      )}
      {product === "chain-height" && (
        <p className="field-hint">No parameters needed — this returns the latest Demos block height.</p>
      )}
    </div>
  );
}

function DdForm({ value, onChange, errors, gatewayErrors }: AgentInputFormProps) {
  const kind = String(value.kind ?? DD_KINDS[0]);
  return (
    <div className="field-stack">
      <FieldRow id="dd-kind" label="Subject type" required error={errors.kind} gatewayError={gatewayErrors.kind}>
        <select id="dd-kind" className="form-control" value={kind}
          onChange={(event) => onChange({ ...value, kind: event.target.value })}>
          <option value="npm-package">npm package</option>
          <option value="crypto-token">crypto token</option>
        </select>
      </FieldRow>
      <FieldRow id="dd-subject" label={kind === "crypto-token" ? "CoinGecko ID" : "Package name"} required
        error={errors.subject} gatewayError={gatewayErrors.subject}
        help={kind === "crypto-token" ? "The CoinGecko identifier, e.g. bitcoin." : "The npm package to research, e.g. express."}>
        <input id="dd-subject" className="form-control mono" value={String(value.subject ?? "")}
          placeholder={kind === "crypto-token" ? "bitcoin" : "express"}
          aria-invalid={Boolean(errors.subject)}
          onChange={(event) => onChange({ ...value, subject: event.target.value })} />
      </FieldRow>
    </div>
  );
}

function DepUpgradeForm({ value, onChange, errors, gatewayErrors }: AgentInputFormProps) {
  return (
    <div className="field-stack">
      <FieldRow id="dep-package" label="package.json" required error={errors.packageJson} gatewayError={gatewayErrors.packageJson}
        help="Paste the package.json to plan upgrades for.">
        <JsonObjectEditor id="dep-package" value={rec(value.packageJson)} rows={10}
          placeholder='{ "name": "demo", "dependencies": { "lodash": "4.17.20" } }'
          onChange={(next) => onChange({ ...value, packageJson: next ?? {} })} />
      </FieldRow>
      <FieldRow id="dep-next-major" label="Include next major versions" error={errors.includeNextMajor} gatewayError={gatewayErrors.includeNextMajor}>
        <label className="checkbox-row" htmlFor="dep-next-major">
          <input id="dep-next-major" type="checkbox" checked={value.includeNextMajor === true}
            onChange={(event) => onChange({ ...value, includeNextMajor: event.target.checked })} />
          <span>Also plan upgrades across major-version boundaries</span>
        </label>
      </FieldRow>
    </div>
  );
}

function EvalbotForm({ value, onChange, errors, gatewayErrors }: AgentInputFormProps) {
  const deliverable = rec(value.deliverable);
  const rubric = rec(value.rubric);
  const criteria = arr(rubric.criteria).map(rec);
  return (
    <div className="field-stack">
      <FieldRow id="eval-label" label="Deliverable label" error={errors["deliverable.label"]} gatewayError={gatewayErrors["deliverable.label"]}
        help="Optional short name for the deliverable being scored.">
        <input id="eval-label" className="form-control" value={String(deliverable.label ?? "")}
          onChange={(event) => {
            const label = event.target.value;
            const next = { ...deliverable };
            if (label.trim() === "") delete next.label; else next.label = label;
            onChange({ ...value, deliverable: next });
          }} />
      </FieldRow>
      <FieldRow id="eval-content" label="Deliverable content" required error={errors["deliverable.content"]} gatewayError={gatewayErrors["deliverable.content"]}>
        <textarea id="eval-content" className="form-control" rows={6} value={String(deliverable.content ?? "")}
          placeholder={"# Introduction\nA concise, testable deliverable."}
          aria-invalid={Boolean(errors["deliverable.content"])}
          onChange={(event) => onChange({ ...value, deliverable: { ...deliverable, content: event.target.value } })} />
      </FieldRow>
      <FieldRow id="eval-threshold" label="Acceptance threshold" required error={errors["rubric.acceptThreshold"]} gatewayError={gatewayErrors["rubric.acceptThreshold"]}
        help="Weighted score (0–100) the deliverable must reach to be accepted.">
        <input id="eval-threshold" className="form-control" type="number" min={0} max={100} step={1}
          value={typeof rubric.acceptThreshold === "number" ? rubric.acceptThreshold : ""}
          aria-invalid={Boolean(errors["rubric.acceptThreshold"])}
          onChange={(event) => onChange({ ...value, rubric: { ...rubric, acceptThreshold: event.target.value === "" ? undefined : Number(event.target.value) } })} />
      </FieldRow>
      <FieldRow id="eval-criteria" label="Rubric criteria" required error={errors["rubric.criteria"]} gatewayError={gatewayErrors["rubric.criteria"]}>
        <RubricEditor idPrefix="eval-criteria" criteria={criteria}
          onChange={(next) => onChange({ ...value, rubric: { ...rubric, criteria: next } })}
          errors={errors} gatewayErrors={gatewayErrors} />
      </FieldRow>
    </div>
  );
}

function TreasuryForm({ value, onChange, errors, gatewayErrors }: AgentInputFormProps) {
  const policy = rec(value.policy);
  const accounts = arr(policy.accounts).map(rec);
  const balances = rec(value.balances);
  const setPolicy = (patch: Record<string, unknown>) => onChange({ ...value, policy: { ...policy, ...patch } });
  const renameBalance = (from: string, to: string) => {
    const next: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(balances)) next[key === from ? to : key] = val;
    if (!(to in next)) next[to] = balances[from] ?? 0;
    delete next[from === to ? " " : from];
    return next;
  };
  return (
    <div className="field-stack">
      <FieldRow id="treasury-accounts" label="Accounts & balances" required error={errors["policy.accounts"]} gatewayError={gatewayErrors["policy.accounts"]}
        help="Each account's policy floor and its current balance.">
        <div className="repeat-list" role="group" aria-label="Accounts">
          {accounts.map((account, index) => {
            const id = String(account.id ?? "");
            return (
              <div className="repeat-row" key={index}>
                <div className="repeat-row-head">
                  <strong>Account {index + 1}</strong>
                  <button type="button" className="ghost-btn" disabled={accounts.length <= 1} aria-label={`Remove account ${index + 1}`}
                    onClick={() => {
                      const nextAccounts = removeRow(accounts, index, 1);
                      const nextBalances = { ...balances };
                      if (id) delete nextBalances[id];
                      onChange({ ...value, policy: { ...policy, accounts: nextAccounts }, balances: nextBalances });
                    }}>
                    Remove
                  </button>
                </div>
                <div className="field-grid three">
                  <div className="form-field try-field">
                    <label htmlFor={`treasury-id-${index}`}>ID<span className="required-mark" title="Required">*</span></label>
                    <input id={`treasury-id-${index}`} className="form-control mono" value={id}
                      aria-invalid={Boolean(errors[`policy.accounts.${index}.id`])}
                      onChange={(event) => {
                        const nextId = event.target.value;
                        const nextAccounts = accounts.map((candidate, i) => i === index ? { ...candidate, id: nextId } : candidate);
                        onChange({ ...value, policy: { ...policy, accounts: nextAccounts }, balances: id ? renameBalance(id, nextId) : { ...balances, [nextId]: balances[nextId] ?? 0 } });
                      }} />
                    {errors[`policy.accounts.${index}.id`] && <span className="field-error" role="alert">{errors[`policy.accounts.${index}.id`]}</span>}
                  </div>
                  <div className="form-field try-field">
                    <label htmlFor={`treasury-kind-${index}`}>Kind</label>
                    <select id={`treasury-kind-${index}`} className="form-control" value={String(account.kind ?? ACCOUNT_KINDS[0])}
                      onChange={(event) => setPolicy({ accounts: accounts.map((candidate, i) => i === index ? { ...candidate, kind: event.target.value } : candidate) })}>
                      {ACCOUNT_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                    </select>
                  </div>
                  <div className="form-field try-field">
                    <label htmlFor={`treasury-min-${index}`}>Min balance<span className="required-mark" title="Required">*</span></label>
                    <input id={`treasury-min-${index}`} className="form-control" type="number" min={0}
                      value={typeof account.minBalance === "number" ? account.minBalance : ""}
                      aria-invalid={Boolean(errors[`policy.accounts.${index}.minBalance`])}
                      onChange={(event) => setPolicy({ accounts: accounts.map((candidate, i) => i === index ? { ...candidate, minBalance: event.target.value === "" ? undefined : Number(event.target.value) } : candidate) })} />
                    {errors[`policy.accounts.${index}.minBalance`] && <span className="field-error" role="alert">{errors[`policy.accounts.${index}.minBalance`]}</span>}
                  </div>
                </div>
                {id && (
                  <div className="form-field try-field">
                    <label htmlFor={`treasury-balance-${index}`}>Current balance for “{id}”<span className="required-mark" title="Required">*</span></label>
                    <input id={`treasury-balance-${index}`} className="form-control" type="number"
                      value={typeof balances[id] === "number" ? balances[id] as number : ""}
                      aria-invalid={Boolean(errors[`balances.${id}`])}
                      onChange={(event) => onChange({ ...value, balances: { ...balances, [id]: event.target.value === "" ? undefined : Number(event.target.value) } })} />
                    {errors[`balances.${id}`] && <span className="field-error" role="alert">{errors[`balances.${id}`]}</span>}
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" className="ghost-btn add-row"
            onClick={() => setPolicy({ accounts: addRow(accounts, { id: "", kind: "operating", minBalance: 0 }) })}>
            + Add account
          </button>
        </div>
      </FieldRow>
      <div className="field-grid">
        <FieldRow id="treasury-per-transfer" label="Max per transfer" required error={errors["policy.maxPerTransfer"]} gatewayError={gatewayErrors["policy.maxPerTransfer"]}>
          <input id="treasury-per-transfer" className="form-control" type="number" min={1}
            value={typeof policy.maxPerTransfer === "number" ? policy.maxPerTransfer : ""}
            aria-invalid={Boolean(errors["policy.maxPerTransfer"])}
            onChange={(event) => setPolicy({ maxPerTransfer: event.target.value === "" ? undefined : Number(event.target.value) })} />
        </FieldRow>
        <FieldRow id="treasury-per-run" label="Max per run" required error={errors["policy.maxPerRun"]} gatewayError={gatewayErrors["policy.maxPerRun"]}>
          <input id="treasury-per-run" className="form-control" type="number" min={1}
            value={typeof policy.maxPerRun === "number" ? policy.maxPerRun : ""}
            aria-invalid={Boolean(errors["policy.maxPerRun"])}
            onChange={(event) => setPolicy({ maxPerRun: event.target.value === "" ? undefined : Number(event.target.value) })} />
        </FieldRow>
      </div>
    </div>
  );
}

function SiteAuditorForm({ value, onChange, errors, gatewayErrors }: AgentInputFormProps) {
  return (
    <div className="field-stack">
      <FieldRow id="site-url" label="URL" required error={errors.url} gatewayError={gatewayErrors.url}
        help="The public page to audit.">
        <input id="site-url" className="form-control mono" type="url" value={String(value.url ?? "")}
          placeholder="https://example.com" aria-invalid={Boolean(errors.url)}
          onChange={(event) => onChange({ ...value, url: event.target.value })} />
      </FieldRow>
      <FieldRow id="site-samples" label="Samples" required error={errors.samples} gatewayError={gatewayErrors.samples}
        help="How many fetches to sample (1–5).">
        <input id="site-samples" className="form-control" type="number" min={1} max={5} step={1}
          value={typeof value.samples === "number" ? value.samples : ""}
          aria-invalid={Boolean(errors.samples)}
          onChange={(event) => onChange({ ...value, samples: event.target.value === "" ? undefined : Number(event.target.value) })} />
      </FieldRow>
    </div>
  );
}

function SecAuditForm({ value, onChange, errors, gatewayErrors }: AgentInputFormProps) {
  return (
    <div className="field-stack">
      <FieldRow id="sec-files" label="Posted files" required error={errors.files} gatewayError={gatewayErrors.files}
        help="The source content to scan.">
        <SourceFilesEditor idPrefix="sec-files" files={files(value.files)}
          onChange={(next) => onChange({ ...value, files: next })} errors={errors} gatewayErrors={gatewayErrors} />
      </FieldRow>
      <FieldRow id="sec-package" label="package.json (optional)" error={errors.packageJson} gatewayError={gatewayErrors.packageJson}
        help="Include to also scan declared dependencies. Leave empty to omit.">
        <JsonObjectEditor id="sec-package" optional rows={6}
          value={value.packageJson === undefined ? undefined : rec(value.packageJson)}
          onChange={(next) => {
            const nextValue = { ...value };
            if (next === undefined) delete nextValue.packageJson; else nextValue.packageJson = next;
            onChange(nextValue);
          }} />
      </FieldRow>
    </div>
  );
}

function ComplianceForm({ value, onChange, errors, gatewayErrors }: AgentInputFormProps) {
  const kind = String(value.kind ?? "entity");
  const aliases = arr(value.aliases).map(String);
  return (
    <div className="field-stack">
      <FieldRow id="comp-kind" label="Subject kind" required error={errors.kind} gatewayError={gatewayErrors.kind}>
        <select id="comp-kind" className="form-control" value={kind}
          onChange={(event) => onChange(complianceKindChange(value, event.target.value))}>
          {COMPLIANCE_KINDS.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
        </select>
      </FieldRow>
      {kind === "wallet" ? (
        <FieldRow id="comp-wallet" label="Wallet address" required error={errors.walletAddress} gatewayError={gatewayErrors.walletAddress}
          help="The on-chain address to screen.">
          <input id="comp-wallet" className="form-control mono" value={String(value.walletAddress ?? "")}
            aria-invalid={Boolean(errors.walletAddress)}
            onChange={(event) => onChange({ ...value, walletAddress: event.target.value })} />
        </FieldRow>
      ) : (
        <FieldRow id="comp-name" label={kind === "person" ? "Full name" : "Entity name"} required error={errors.name} gatewayError={gatewayErrors.name}>
          <input id="comp-name" className="form-control" value={String(value.name ?? "")}
            placeholder={kind === "person" ? "Alex Example" : "Example Holdings Ltd"}
            aria-invalid={Boolean(errors.name)}
            onChange={(event) => onChange({ ...value, name: event.target.value })} />
        </FieldRow>
      )}
      <FieldRow id="comp-country" label="Country (optional)" error={errors.country} gatewayError={gatewayErrors.country}
        help="ISO code, e.g. GB — narrows the screening; leave blank to search without one.">
        <input id="comp-country" className="form-control mono" value={String(value.country ?? "")} placeholder="GB"
          aria-invalid={Boolean(errors.country)}
          onChange={(event) => {
            const country = event.target.value;
            const next = { ...value };
            if (country.trim() === "") delete next.country; else next.country = country;
            onChange(next);
          }} />
      </FieldRow>
      <FieldRow id="comp-aliases" label="Aliases" error={errors.aliases} gatewayError={gatewayErrors.aliases}
        help="Optional alternate names, one per row.">
        <div className="repeat-list" role="group" aria-label="Aliases">
          {aliases.map((alias, index) => (
            <div className="kv-row alias-row" key={index}>
              <input id={`comp-alias-${index}`} className="form-control" value={alias} aria-label={`Alias ${index + 1}`}
                onChange={(event) => {
                  const next = aliases.map((candidate, i) => i === index ? event.target.value : candidate);
                  onChange({ ...value, aliases: next });
                }} />
              <button type="button" className="ghost-btn" aria-label={`Remove alias ${index + 1}`}
                onClick={() => {
                  const next = aliases.filter((_, i) => i !== index);
                  const nextValue = { ...value };
                  if (next.length === 0) delete nextValue.aliases; else nextValue.aliases = next;
                  onChange(nextValue);
                }}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className="ghost-btn add-row" onClick={() => onChange({ ...value, aliases: [...aliases, ""] })}>
            + Add alias
          </button>
        </div>
      </FieldRow>
    </div>
  );
}

/**
 * Advanced disclosure: the raw gateway input as editable JSON, always in sync
 * with the form (both edit the same object). When `always`, it renders open
 * as the only input surface (unknown agents without a published schema).
 */
function AdvancedJson({ value, onChange, always }: AgentInputFormProps & { always: boolean }) {
  const canonical = JSON.stringify(value, null, 2);
  const [text, setText] = useState(canonical);
  const [dirtyError, setDirtyError] = useState("");
  useEffect(() => {
    setText((current) => {
      try { if (JSON.stringify(JSON.parse(current)) === JSON.stringify(value)) return current; }
      catch { /* mid-edit */ }
      setDirtyError("");
      return canonical;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonical]);
  function edit(nextText: string) {
    setText(nextText);
    try {
      const parsed = JSON.parse(nextText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setDirtyError("The input must be a JSON object.");
        return;
      }
      setDirtyError("");
      onChange(parsed as Record<string, unknown>);
    } catch {
      setDirtyError("Not valid JSON yet — the form (and submission) still hold the last valid value.");
    }
  }
  return (
    <details className="advanced-json" open={always}>
      <summary>Advanced input (raw JSON)</summary>
      <p className="field-hint">This is the exact object submitted to the gateway. Edits here update the form above and vice versa.</p>
      <textarea className="form-control mono" value={text} rows={10} spellCheck={false}
        aria-label="Advanced raw JSON input" aria-invalid={Boolean(dirtyError)}
        onChange={(event) => edit(event.target.value)} />
      {dirtyError && <span className="field-error" role="alert">{dirtyError}</span>}
    </details>
  );
}
