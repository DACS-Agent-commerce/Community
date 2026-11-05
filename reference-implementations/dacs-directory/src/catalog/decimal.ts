const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Non-negative decimal strings as exact integers at one shared scale, so they
 * can be added or compared without binary floating-point drift. Returns null
 * when any value is not a plain decimal string.
 */
export function scaledDecimals(values: unknown[]): { scale: number; units: bigint[] } | null {
  if (!values.every((value): value is string => typeof value === "string" && DECIMAL.test(value))) return null;
  const parts = values.map((value) => value.split("."));
  const scale = Math.max(0, ...parts.map(([, fraction = ""]) => fraction.length));
  return { scale, units: parts.map(([whole, fraction = ""]) => BigInt(whole + fraction.padEnd(scale, "0"))) };
}

const PLAIN_DECIMAL = /^[0-9]*\.?[0-9]*$/;

/**
 * The dacs-sdk CD-1 grammar (canonical/decimal.ts): digits with at most one dot
 * and at least one digit, so `.5`, `1.`, `007` and `00.5` are valid; sign,
 * exponent and whitespace are not. Returns the canonical form (leading integer
 * zeros and trailing fractional zeros dropped, `.5` -> `0.5`, `1.` -> `1`), or
 * null when the input is not a plain decimal.
 */
export function canonicalPlainDecimal(input: string): string | null {
  if (!PLAIN_DECIMAL.test(input) || !/[0-9]/.test(input)) return null;
  const [whole = "", fraction = ""] = input.split(".");
  const integer = whole.replace(/^0+/, "") || "0";
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed === "" ? integer : `${integer}.${trimmed}`;
}
