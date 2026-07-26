/**
 * Pure form logic for the /try agent forms: per-agent descriptors, blank
 * defaults, local validation, gateway-error mapping, and submission summaries.
 *
 * The single source of truth for a run is the gateway input object itself —
 * controls edit paths inside it, the Advanced JSON view edits the same object,
 * and `runAgent()` submits it unchanged. Local validation is advisory for
 * immediate feedback; the gateway remains authoritative.
 */
import type { AgentCard, PaymentRail } from "./try-dacs-contract.js";

/**
 * A renderable field derived from the gateway's published input schema. The
 * gateway describes fields as { name, type, required, description } (plus
 * optional enum/min/max); this normalizes them for the generic form renderer.
 */
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
export const EVAL_CHECKS = ["content-includes", "regex-match", "min-length"] as const;
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

const SCHEMA_KINDS: Record<string, AgentFieldSchema["kind"]> = {
  string: "text",
  text: "textarea",
  number: "number",
  integer: "number",
  boolean: "checkbox",
  enum: "select",
};

const schemaFieldKind = (field: Record<string, unknown>): AgentFieldSchema["kind"] | null => {
  // The gateway expresses an enum as a companion `enum` array on a string
  // field ({ type: "string", enum: [...] }); it may also use type: "enum".
  if (Array.isArray(field.enum)) return field.enum.every((option) => typeof option === "string") ? "select" : null;
  return SCHEMA_KINDS[String(field.type)] ?? null;
};

const labelFromName = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * Parse the gateway's published input schema (agents[].input as
 * { name, type, required, description }[]) into renderable fields. Fields the
 * generic renderer cannot represent (objects, arrays, unknown types) yield
 * null so the caller falls back to the built-in form or the Advanced JSON
 * editor — a partially-rendered schema would silently drop required input.
 */
export function parseAgentFieldSchema(agent: AgentCard & { input?: unknown }): AgentFieldSchema[] | null {
  if (!Array.isArray(agent.input) || agent.input.length === 0) return null;
  const fields: AgentFieldSchema[] = [];
  for (const value of agent.input) {
    const field = rec(value);
    if (typeof field.name !== "string" || !field.name.trim()) return null;
    const kind = schemaFieldKind(field);
    if (!kind) return null;
    const options = Array.isArray(field.enum) ? field.enum as string[] : undefined;
    fields.push({
      key: field.name,
      label: labelFromName(field.name),
      kind,
      required: field.required === true,
      help: typeof field.description === "string" ? field.description : undefined,
      options: options as string[] | undefined,
      min: num(field.min),
      max: num(field.max),
    });
  }
  return fields;
}

/**
 * Validate an input object against a gateway-published field schema: required
 * fields must be present and non-empty; numbers must parse and honour min/max;
 * selects must hold one of the published options. Advisory only — the gateway
 * remains authoritative.
 */
/**
 * Default input for a schema-driven agent. Selects seed to their first option
 * and checkboxes to false so what the form displays matches submitted state
 * (a required select must not read as "chosen" while its value is empty).
 * Text/number fields start absent so their required validation fires.
 */
export function initialSchemaInput(fields: AgentFieldSchema[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === "checkbox") input[field.key] = false;
    else if (field.kind === "select" && field.options && field.options.length > 0) input[field.key] = field.options[0];
  }
  return input;
}

export function validateSchemaInput(fields: AgentFieldSchema[], input: Record<string, unknown>): FieldErrors {
  const errors: FieldErrors = {};
  for (const field of fields) {
    const value = input[field.key];
    const missing = value === undefined || value === null || (typeof value === "string" && value.trim() === "");
    if (field.required && field.kind === "checkbox") {
      if (value !== true) errors[field.key] = `Required — ${field.label} must be checked.`;
      continue;
    }
    if (field.required && missing) {
      errors[field.key] = `Required — ${field.label}.`;
      continue;
    }
    if (missing) continue;
    if (field.kind === "number") {
      const parsed = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(parsed)) errors[field.key] = `${field.label} must be a number.`;
      else if (field.min !== undefined && parsed < field.min) errors[field.key] = `${field.label} must be at least ${field.min}.`;
      else if (field.max !== undefined && parsed > field.max) errors[field.key] = `${field.label} must be at most ${field.max}.`;
    } else if (field.kind === "select" && field.options && !field.options.includes(String(value))) {
      errors[field.key] = `${field.label} must be one of: ${field.options.join(", ")}.`;
    }
  }
  return errors;
}

/** True when the agent has a dedicated built-in form (vs schema/JSON fallback). */
export function hasBuiltinForm(name: string): boolean {
  return (KNOWN_FORM_AGENTS as readonly string[]).includes(name);
}

/** Blank starting input per agent — examples are opt-in via "Load example". */
export function initialAgentInput(name: string, paymentRail: PaymentRail = "pay-dem"): Record<string, unknown> {
  switch (name) {
    case "procurement-butler":
      return paymentRail === "pay-x402"
        ? { goal: "", budgetUsdc: 0.1, files: [{ path: "", content: "" }], paymentRail }
        : { goal: "", budgetDem: 5, files: [{ path: "", content: "" }], paymentRail };
    case "oracle-desk":
      return { product: "crypto-price", params: { ...ORACLE_DEFAULT_PARAMS["crypto-price"] }, paymentRail };
    case "dd-researcher":
      return { kind: "npm-package", subject: "", paymentRail };
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
      return { kind: "entity", name: "" };
    default:
      return {};
  }
}

export function blankCriterion(): Record<string, unknown> {
  return { id: "", kind: "mechanical", weight: 1, description: "", test: { check: "content-includes", needle: "" } };
}

/**
 * Switching a criterion's mechanical check swaps its parameters: needle for
 * content-includes / regex-match, minChars for min-length. Stale parameters
 * from the previous check must not be submitted (probed live: min-length
 * without minChars silently scores "length < min undefined").
 */
export function criterionCheckChange(test: Record<string, unknown>, check: string): Record<string, unknown> {
  if (check === "min-length") {
    return { check, minChars: typeof test.minChars === "number" ? test.minChars : 1 };
  }
  if (check === "regex-match") {
    // The gateway runs new RegExp(test.pattern); an undefined pattern matches
    // everything and would falsely accept. Carry a string over from either key.
    const carried = typeof test.pattern === "string" ? test.pattern : typeof test.needle === "string" ? test.needle : "";
    return { check, pattern: carried };
  }
  const carried = typeof test.needle === "string" ? test.needle : typeof test.pattern === "string" ? test.pattern : "";
  return { check, needle: carried };
}

/** Repeatable-row helpers (pure; unit-tested). */
export function addRow<T>(rows: T[], blank: T): T[] {
  return [...rows, blank];
}
export function removeRow<T>(rows: T[], index: number, minimum = 0): T[] {
  if (rows.length <= minimum) return rows;
  return rows.filter((_, i) => i !== index);
}

// Gateway-valid targets include bare hosts (example.com) as well as full
// URLs; local validation must not reject what the gateway accepts.
const URL_PATTERN = /^(https?:\/\/)?[^\s/]+\.[^\s]{2,}/i;

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
      if (input.paymentRail === "pay-x402") {
        const budget = num(input.budgetUsdc);
        if (budget === undefined || budget <= 0 || budget > 10) errors.budgetUsdc = "Enter a Base Sepolia USDC budget above 0 and no more than 10.";
      } else {
        const budget = num(input.budgetDem);
        if (budget === undefined || budget <= 0 || budget > 10) errors.budgetDem = "Enter a DEM budget above 0 and no more than 10.";
      }
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
        const check = str(test.check);
        if (check === "min-length") {
          const minChars = num(test.minChars);
          if (minChars === undefined || !Number.isInteger(minChars) || minChars < 1) {
            errors[`rubric.criteria.${index}.test.minChars`] = "Required — the minimum character count this check enforces.";
          }
        } else if (check === "regex-match") {
          const pattern = str(test.pattern);
          if (!pattern.trim()) {
            errors[`rubric.criteria.${index}.test.pattern`] = "Required — a pattern (an empty pattern matches everything).";
          } else {
            try { new RegExp(pattern); }
            catch { errors[`rubric.criteria.${index}.test.pattern`] = "Not a valid regular expression."; }
          }
        } else if (!str(test.needle).trim()) {
          errors[`rubric.criteria.${index}.test.needle`] = "Required — the text the mechanical check looks for.";
        }
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
      if (!URL_PATTERN.test(str(input.url).trim())) errors.url = "Enter a site to audit, e.g. https://example.com or example.com.";
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
      if (input.country !== undefined && typeof input.country !== "string") {
        errors.country = "Country must be an ISO code string, e.g. GB.";
      }
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
      lines.push(input.paymentRail === "pay-x402"
        ? `Budget: ${num(input.budgetUsdc) ?? "—"} USDC · Base Sepolia x402`
        : `Budget: ${num(input.budgetDem) ?? "—"} DEM`);
      lines.push(`Files: ${arr(input.files).map((file) => str(rec(file).path) || "(unnamed)").join(", ") || "none"}`);
      break;
    }
    case "oracle-desk": {
      lines.push(`Product: ${str(input.product)}`);
      const params = rec(input.params);
      lines.push(`Params: ${Object.entries(params).map(([key, value]) => `${key}=${String(value)}`).join(", ") || "none"}`);
      lines.push(`Payment: ${input.paymentRail === "pay-x402" ? "USDC · Base Sepolia x402" : "DEM · Demos"}`);
      break;
    }
    case "dd-researcher":
      lines.push(`Subject: ${str(input.subject)} (${str(input.kind)})`);
      lines.push(`Payment: ${input.paymentRail === "pay-x402" ? "USDC · Base Sepolia x402" : "DEM · Demos"}`);
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
export function agentSafetyNote(name: string, paymentRail: PaymentRail = "pay-dem"): string | null {
  switch (name) {
    case "procurement-butler":
      return paymentRail === "pay-x402"
        ? "Runs the full live purchase flow with a real Base Sepolia USDC payment. Your USDC budget is a hard spend cap."
        : "Runs the full live purchase flow with a real DEM payment. Your DEM budget is a hard spend cap.";
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
