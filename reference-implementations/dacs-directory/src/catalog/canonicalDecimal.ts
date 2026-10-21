/**
 * CORE CD-1 for one PriceTerm.amount. Producers MUST emit the minimal-digit canonical form; verifiers MUST
 * canonicalise before any price-band or price-equality comparison, so every verifier-side reading of an amount
 * goes through here. A plain unsigned decimal reads as its canonical form ("2.0" and "02" are "2", "0.50" is "0.5").
 * Anything else (a sign, an exponent, another separator, whitespace, a bare point, a non-string) is null, and the
 * caller refuses it. Hashes and signatures stay over the stored bytes, never over this form.
 */
export function cd1Amount(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const integer = whole.replace(/^0+(?=\d)/, "");
  const decimals = fraction.replace(/0+$/, "");
  return decimals ? `${integer}.${decimals}` : integer;
}
