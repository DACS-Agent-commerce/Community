/**
 * Pure form logic for the /try agent forms: per-agent descriptors, blank
 * defaults, local validation, gateway-error mapping, and submission summaries.
 *
 * The single source of truth for a run is the gateway input object itself —
 * controls edit paths inside it, the Advanced JSON view edits the same object,
 * and `runAgent()` submits it unchanged. Local validation is advisory for
 * immediate feedback; the gateway remains authoritative.
 */
import type { AgentCard } from "./try-dacs-contract.js";

/** A future catalog-published field description (agents[].fields). */
export type AgentFieldSchema = {
  key: string;
  label: string;
  kind: "text" | "number" | "checkbox" | "select" | "textarea";
  required?: boolean;
  help?: string;
  options?: string[];
  min?: number;
  max?: number;
};

export type FieldErrors = Record<string, string>;

export type SourceFile = { path: string; content: string };

export const ORACLE_PRODUCTS = ["crypto-price", "fx-rate", "chain-height"] as const;
export const ORACLE_DEFAULT_PARAMS: Record<string, Record<string, string>> = {
  "crypto-price": { id: "bitcoin" },
  "fx-rate": { base: "USD", quote: "EUR" },
  "chain-height": {},
};
export const DD_KINDS = ["npm-package", "crypto-token"] as const;
export const COMPLIANCE_KINDS = ["person", "entity", "wallet"] as const;
export const EVAL_CHECKS = ["content-includes", "content-regex", "min-length"] as const;
export const ACCOUNT_KINDS = ["operating", "reserve", "payroll"] as const;

export const KNOWN_FORM_AGENTS = [
  "procurement-butler", "oracle-desk", "dd-researcher", "dep-upgrade",
  "evalbot", "treasury-ops", "site-auditor", "sec-audit", "compliance",
] as const;

const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string => typeof value === "string" ? value : "";
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Parse a future catalog field schema if the gateway publishes one. Anything
 * malformed yields null so the caller falls back to the built-in descriptor
 * (or the Advanced JSON editor for unknown agents).
 */
export function parseAgentFieldSchema(agent: AgentCard & { fields?: unknown }): AgentFieldSchema[] | null {
  if (!Array.isArray(agent.fields) || agent.fields.length === 0) return null;
  const fields: AgentFieldSchema[] = [];
  for (const value of agent.fields) {
    const field = rec(value);
    const kind = field.kind;
    if (typeof field.key !== "string" || !field.key.trim()) return null;
    if (typeof field.label !== "string" || !field.label.trim()) return null;
    if (kind !== "text" && kind !== "number" && kind !== "checkbox" && kind !== "select" && kind !== "textarea") return null;
    if (kind === "select" && (!Array.isArray(field.options) || field.options.some((option) => typeof option !== "string"))) return null;
    fields.push({
      key: field.key,
      label: field.label,
      kind,
      required: field.required === true,
      help: typeof field.help === "string" ? field.help : undefined,
      options: Array.isArray(field.options) ? field.options as string[] : undefined,
      min: num(field.min),
      max: num(field.max),
    });
  }
  return fields;
}

/** True when the agent has a dedicated built-in form (vs schema/JSON fallback). */
export function hasBuiltinForm(name: string): boolean {
  return (KNOWN_FORM_AGENTS as readonly string[]).includes(name);
}

/** Blank starting input per agent — examples are opt-in via "Load example". */
export function initialAgentInput(name: string): Record<string, unknown> {
  switch (name) {
    case "procurement-butler":
      return { goal: "", budgetDem: 5, files: [{ path: "", content: "" }] };
    case "oracle-desk":
      return { product: "crypto-price", params: { ...ORACLE_DEFAULT_PARAMS["crypto-price"] } };
    case "dd-researcher":
      return { kind: "npm-package", subject: "" };
    case "dep-upgrade":
      return { packageJson: {}, includeNextMajor: false };
    case "evalbot":
      return {
        deliverable: { content: "" },
        rubric: { acceptThreshold: 80, criteria: [blankCriterion()] },
      };
    case "treasury-ops":
      return {
        policy: { accounts: [{ id: "ops", kind: "operating", minBalance: 0 }], allowlist: [], payroll: [], maxPerTransfer: 0, maxPerRun: 0 },
        balances: { ops: 0 },
      };
    case "site-auditor":
      return { url: "", samples: 1 };
    case "sec-audit":
      return { files: [{ path: "", content: "" }] };
    case "compliance":
      return { kind: "entity", name: "", country: "" };
    default:
      return {};
  }
}

export function blankCriterion(): Record<string, unknown> {
  return { id: "", kind: "mechanical", weight: 1, description: "", test: { check: "content-includes", needle: "" } };
}

/** Repeatable-row helpers (pure; unit-tested). */
export function addRow<T>(rows: T[], blank: T): T[] {
  return [...rows, blank];
}
export function removeRow<T>(rows: T[], index: number, minimum = 0): T[] {
  if (rows.length <= minimum) return rows;
  return rows.filter((_, i) => i !== index);
}

const URL_PATTERN = /^https?:\/\/[^\s]+\.[^\s]+/i;

/**
 * Advisory local validation: immediate feedback only. Keys are dotted paths
 * matching the controls; the gateway's own validation remains authoritative.
 */
export function validateAgentInput(name: string, input: Record<string, unknown>): FieldErrors {
  const errors: FieldErrors = {};
  const requireText = (key: string, value: unknown, why: string) => {
    if (!str(value).trim()) errors[key] = why;
  };
  const requireFiles = (key: string, value: unknown) => {
    const files = arr(value);
    if (files.length === 0) { errors[key] = "Add at least one file."; return; }
    files.forEach((file, index) => {
      const f = rec(file);
      if (!str(f.path).trim()) errors[`${key}.${index}.path`] = "Required so the report can reference this file.";
      if (!str(f.content).trim()) errors[`${key}.${index}.content`] = "Required — this is the content the agent analyses.";
    });
  };
  switch (name) {
    case "procurement-butler": {
      requireText("goal", input.goal, "Required — this states what you are purchasing.");
      const budget = num(input.budgetDem);
      if (budget === undefined || budget <= 0) errors.budgetDem = "Required — a positive DEM budget caps what the Butler may spend.";
      requireFiles("files", input.files);
      break;
    }
    case "oracle-desk": {
      if (!(ORACLE_PRODUCTS as readonly string[]).includes(str(input.product))) {
        errors.product = `Pick one of: ${ORACLE_PRODUCTS.join(", ")}.`;
      }
      break;
    }
    case "dd-researcher": {
      if (!(DD_KINDS as readonly string[]).includes(str(input.kind))) errors.kind = "Pick npm package or crypto token.";
      requireText("subject", input.subject, input.kind === "crypto-token"
        ? "Required — the CoinGecko ID to research (e.g. bitcoin)."
        : "Required — the npm package name to research (e.g. express).");
      break;
    }
    case "dep-upgrade": {
      const pkg = input.packageJson;
      if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) errors.packageJson = "Provide a JSON object (your package.json).";
      else if (Object.keys(rec(pkg)).length === 0) errors.packageJson = "Paste a package.json with at least one field.";
      break;
    }
    case "evalbot": {
      requireText("deliverable.content", rec(input.deliverable).content, "Required — the content EvalBot scores.");
      const rubric = rec(input.rubric);
      const threshold = num(rubric.acceptThreshold);
      if (threshold === undefined || threshold < 0 || threshold > 100) errors["rubric.acceptThreshold"] = "Enter a 0–100 acceptance threshold.";
      const criteria = arr(rubric.criteria);
      if (criteria.length === 0) errors["rubric.criteria"] = "Add at least one criterion.";
      criteria.forEach((value, index) => {
        const criterion = rec(value);
        if (!str(criterion.id).trim()) errors[`rubric.criteria.${index}.id`] = "Required — a short identifier for this criterion.";
        const weight = num(criterion.weight);
        if (weight === undefined || weight <= 0) errors[`rubric.criteria.${index}.weight`] = "Positive weight required.";
        if (!str(criterion.description).trim()) errors[`rubric.criteria.${index}.description`] = "Describe what this criterion checks.";
        const test = rec(criterion.test);
        if (!str(test.needle).trim() && str(test.check) !== "min-length") errors[`rubric.criteria.${index}.test.needle`] = "Required — the text the mechanical check looks for.";
      });
      break;
    }
    case "treasury-ops": {
      const policy = rec(input.policy);
      const accounts = arr(policy.accounts);
      if (accounts.length === 0) errors["policy.accounts"] = "Add at least one account.";
      accounts.forEach((value, index) => {
        const account = rec(value);
        if (!str(account.id).trim()) errors[`policy.accounts.${index}.id`] = "Required — the account identifier.";
        if (num(account.minBalance) === undefined || (num(account.minBalance) ?? -1) < 0) errors[`policy.accounts.${index}.minBalance`] = "Non-negative minimum balance required.";
      });
      const perTransfer = num(policy.maxPerTransfer);
      const perRun = num(policy.maxPerRun);
      if (perTransfer === undefined || perTransfer <= 0) errors["policy.maxPerTransfer"] = "Positive per-transfer cap required.";
      if (perRun === undefined || perRun <= 0) errors["policy.maxPerRun"] = "Positive per-run cap required.";
      const balances = rec(input.balances);
      accounts.forEach((value, index) => {
        const id = str(rec(value).id).trim();
        if (id && num(balances[id]) === undefined) errors[`balances.${id}`] = `Enter a numeric balance for "${id}".`;
        void index;
      });
      break;
    }
    case "site-auditor": {
      if (!URL_PATTERN.test(str(input.url).trim())) errors.url = "Enter a full URL, e.g. https://example.com.";
      const samples = num(input.samples);
      if (samples === undefined || !Number.isInteger(samples) || samples < 1 || samples > 5) errors.samples = "Between 1 and 5 samples.";
      break;
    }
    case "sec-audit": {
      requireFiles("files", input.files);
      const pkg = input.packageJson;
      if (pkg !== undefined && (typeof pkg !== "object" || pkg === null || Array.isArray(pkg))) errors.packageJson = "Optional, but must be a JSON object when provided.";
      break;
    }
    case "compliance": {
      if (!(COMPLIANCE_KINDS as readonly string[]).includes(str(input.kind))) errors.kind = "Pick person, entity, or wallet.";
      if (input.kind === "wallet") requireText("walletAddress", input.walletAddress, "Required — the wallet address to screen.");
      else requireText("name", input.name, "Required — the full legal name to screen.");
      requireText("country", input.country, "Required — an ISO country code, e.g. GB.");
      const aliases = input.aliases;
      if (aliases !== undefined && (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string"))) {
        errors.aliases = "Aliases must be a list of names.";
      }
      break;
    }
    default:
      break;
  }
  return errors;
}

/**
 * Switching the compliance kind must not submit stale conditional fields:
 * person/entity carry `name`, wallet carries `walletAddress`.
 */
export function complianceKindChange(input: Record<string, unknown>, kind: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...input, kind };
  if (kind === "wallet") {
    delete next.name;
    if (typeof next.walletAddress !== "string") next.walletAddress = "";
  } else {
    delete next.walletAddress;
    if (typeof next.name !== "string") next.name = "";
  }
  return next;
}

/** Oracle product change resets params to that product's known defaults. */
export function oracleProductChange(input: Record<string, unknown>, product: string): Record<string, unknown> {
  return { ...input, product, params: { ...(ORACLE_DEFAULT_PARAMS[product] ?? {}) } };
}

/**
 * Map the gateway's error envelope onto form fields. `details` lines follow
 * `field "name"…`; agent errors follow `… requires fieldName`. Anything that
 * cannot be attributed to a field stays in `global`.
 */
export function mapGatewayErrors(
  message: string,
  details: string[] | undefined,
  knownKeys: string[],
): { global: string[]; byField: FieldErrors } {
  const byField: FieldErrors = {};
  const global: string[] = [];
  const attribute = (line: string): boolean => {
    const quoted = line.match(/field "([^"]+)"/)?.[1];
    if (quoted) {
      const key = knownKeys.find((candidate) => candidate === quoted || candidate.endsWith(`.${quoted}`)) ?? quoted;
      byField[key] = byField[key] ? `${byField[key]} ${line}` : line;
      return true;
    }
    const required = line.match(/requires (\w+)/)?.[1];
    if (required) {
      const key = knownKeys.find((candidate) => candidate === required || candidate.endsWith(`.${required}`)) ?? required;
      byField[key] = byField[key] ? `${byField[key]} ${line}` : line;
      return true;
    }
    return false;
  };
  for (const line of details ?? []) if (!attribute(line)) global.push(line);
  if ((details ?? []).length === 0 && !attribute(message)) global.push(message);
  return { global, byField };
}

/** All dotted paths present in an input object (for gateway-error mapping). */
export function flattenInputKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenInputKeys(item, prefix ? `${prefix}.${index}` : String(index)));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return [path, ...flattenInputKeys(item, path)];
    });
  }
  return [];
}

/** Short human summary of exactly what will be / was submitted. */
export function summarizeAgentInput(name: string, input: Record<string, unknown>): string[] {
  const lines: string[] = [];
  switch (name) {
    case "procurement-butler": {
      lines.push(`Goal: ${str(input.goal) || "—"}`);
      lines.push(`Budget: ${num(input.budgetDem) ?? "—"} DEM`);
      lines.push(`Files: ${arr(input.files).map((file) => str(rec(file).path) || "(unnamed)").join(", ") || "none"}`);
      break;
    }
    case "oracle-desk": {
      lines.push(`Product: ${str(input.product)}`);
      const params = rec(input.params);
      lines.push(`Params: ${Object.entries(params).map(([key, value]) => `${key}=${String(value)}`).join(", ") || "none"}`);
      break;
    }
    case "dd-researcher":
      lines.push(`Subject: ${str(input.subject)} (${str(input.kind)})`);
      break;
    case "dep-upgrade": {
      const dependencies = rec(rec(input.packageJson).dependencies);
      lines.push(`package.json: ${Object.keys(dependencies).length} dependencies`);
      lines.push(`Include next major: ${input.includeNextMajor === true ? "yes" : "no"}`);
      break;
    }
    case "evalbot": {
      const rubric = rec(input.rubric);
      lines.push(`Criteria: ${arr(rubric.criteria).length} · threshold ${num(rubric.acceptThreshold) ?? "—"}`);
      lines.push(`Deliverable: ${str(rec(input.deliverable).content).length} chars`);
      break;
    }
    case "treasury-ops": {
      const policy = rec(input.policy);
      lines.push(`Accounts: ${arr(policy.accounts).map((account) => str(rec(account).id)).join(", ")}`);
      lines.push(`Caps: ${num(policy.maxPerTransfer) ?? "—"} per transfer · ${num(policy.maxPerRun) ?? "—"} per run`);
      break;
    }
    case "site-auditor":
      lines.push(`URL: ${str(input.url)}`);
      lines.push(`Samples: ${num(input.samples) ?? "—"}`);
      break;
    case "sec-audit":
      lines.push(`Files: ${arr(input.files).map((file) => str(rec(file).path) || "(unnamed)").join(", ")}`);
      lines.push(`package.json: ${input.packageJson === undefined ? "not provided" : "provided"}`);
      break;
    case "compliance":
      lines.push(`Kind: ${str(input.kind)}`);
      lines.push(input.kind === "wallet" ? `Wallet: ${str(input.walletAddress)}` : `Name: ${str(input.name)}`);
      lines.push(`Country: ${str(input.country)}${arr(input.aliases).length ? ` · aliases: ${arr(input.aliases).join(", ")}` : ""}`);
      break;
    default:
      lines.push(`${Object.keys(input).length} fields`);
  }
  return lines;
}

/** One-line safety statement rendered with each form (honest boundaries). */
export function agentSafetyNote(name: string): string | null {
  switch (name) {
    case "procurement-butler":
      return "Runs the full live purchase flow: discovery, negotiation, a real DEM payment, delivery, and verification. The DEM budget bounds spend.";
    case "dep-upgrade":
      return "Plans upgrades only — it never installs or modifies anything.";
    case "treasury-ops":
      return "Plans and approves transfers against your policy — it never moves funds.";
    case "sec-audit":
      return "Scans only the content you paste here. It has no access to your filesystem.";
    case "site-auditor":
      return "Fetches the public URL you provide, up to the sample count.";
    default:
      return null;
  }
}
