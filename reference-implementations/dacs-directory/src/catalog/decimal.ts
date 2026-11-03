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
