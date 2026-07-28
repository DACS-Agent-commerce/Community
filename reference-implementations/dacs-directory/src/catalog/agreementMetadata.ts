const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/**
 * Read the current DACS-3 settlement rail from signed agreement terms.
 * Legacy callers may retain their older price.rail fallback separately.
 */
export function agreementRail(
  agreement: Record<string, unknown> | undefined,
): string | null {
  const rail = record(record(agreement?.terms)?.rail);
  const railId = rail?.railId;
  return typeof railId === "string" && railId.length > 0 && railId.length <= 256
    ? railId
    : null;
}
