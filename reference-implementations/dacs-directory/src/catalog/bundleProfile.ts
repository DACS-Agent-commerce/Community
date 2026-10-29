const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Select by reference format before verification; failures never select another reader. */
export function usesCurrentBundleProfile(raw: Record<string, unknown> | null): boolean {
  if (!raw) return false;
  // Fault fields exist only in the current profile; any value, even an unsupported one, is refused there.
  if (Object.hasOwn(raw, "faultBundleVersion") || Object.hasOwn(raw, "faultedParty")) return true;
  if (raw.bundleVersion !== "1") return false;
  const refs = [raw.agreementRef,
    ...(Array.isArray(raw.vetRecords) ? raw.vetRecords : []),
    ...(Array.isArray(raw.settlementEvidence) ? raw.settlementEvidence : []),
    ...(Array.isArray(raw.phaseSummary) ? raw.phaseSummary.map(phase => record(phase)?.attestationRef) : []),
  ].map(record).filter((ref): ref is Record<string, unknown> => ref !== null);
  // A current discriminator wins even when mixed with old fields or malformed.
  if (refs.some(ref => Object.hasOwn(ref, "anchor")) || raw.ratingRefs !== undefined || raw.amendments !== undefined) return true;
  return !refs.some(ref => typeof ref.kind === "string" && typeof ref.id === "string");
}
