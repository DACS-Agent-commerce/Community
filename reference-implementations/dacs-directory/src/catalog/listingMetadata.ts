const boundedStrings = (
  value: unknown,
  maxItems: number,
  maxLength: number,
  pattern?: RegExp,
): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (!normalized || normalized.length > maxLength || (pattern && !pattern.test(normalized))) continue;
    if (!out.includes(normalized)) out.push(normalized);
    if (out.length === maxItems) break;
  }
  return out;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Normalize signed-but-extensible listing fields before they reach the UI. */
export function listingPresentation(scope: Record<string, unknown>) {
  const currentOffering = scope.offering && typeof scope.offering === "object" && !Array.isArray(scope.offering)
    ? scope.offering as Record<string, unknown>
    : null;
  const rawCategoryValue = currentOffering?.category ?? scope.category;
  const rawCategory = typeof rawCategoryValue === "string"
    ? rawCategoryValue.trim().toLowerCase()
    : "";
  const category = /^[a-z0-9.-]{1,64}$/.test(rawCategory)
    ? rawCategory
    : "services.other";
  const protocolId = /^[a-z0-9:-]{1,128}$/;
  // DACS-4 §9.4.2 registry rail IDs carry uppercase asset codes (`demos-native:DEM`).
  const railId = /^[A-Za-z0-9._~:-]{1,128}$/;
  const pipeline = Array.isArray(scope.pipeline)
    ? scope.pipeline.filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === "object" && !Array.isArray(step))
      .map((step) => step.kind).filter((kind): kind is string => typeof kind === "string")
    : [];
  // Payment phases and the rail each names (DACS-4: a payment phase pays exactly `parameters.rail`).
  // All or nothing: a payment phase without a valid rail, or more than 16, leaves the list empty,
  // so a reader never judges a pipeline from part of it.
  const paymentPhases = currentOffering && Array.isArray(scope.pipeline)
    ? (() => {
      const phases: Array<{ kind: string; rail: string } | null> = scope.pipeline.flatMap((step) => {
        const phase = record(step);
        if (typeof phase?.kind !== "string" || !phase.kind.startsWith("pay-")) return [];
        const rail = record(phase.parameters)?.rail;
        return [protocolId.test(phase.kind) && typeof rail === "string" && railId.test(rail) ? { kind: phase.kind, rail } : null];
      });
      return phases.length <= 16 && phases.every((phase) => phase !== null) ? phases as Array<{ kind: string; rail: string }> : [];
    })()
    : undefined;
  // Negotiation and commit phases in signed pipeline order (the purchase flow needs one negotiation
  // followed by one commit). More than 16 leaves the list empty, so a reader never judges part of it.
  const flowPhases = currentOffering
    ? (() => {
      const kinds = pipeline.filter((kind) => (kind.startsWith("negotiate-") || kind.startsWith("commit-")) && protocolId.test(kind));
      return kinds.length <= 16 ? kinds : [];
    })()
    : undefined;
  const acceptedRails = Array.isArray(scope.acceptedRails)
    ? scope.acceptedRails.filter((rail): rail is Record<string, unknown> => Boolean(rail) && typeof rail === "object" && !Array.isArray(rail))
      .map((rail) => rail.railId).filter((rail): rail is string => typeof rail === "string")
    : [];
  const pricing = scope.pricing && typeof scope.pricing === "object" && !Array.isArray(scope.pricing)
    ? scope.pricing as Record<string, unknown>
    : null;
  const price = pricing?.kind === "fixed" ? pricing.price
    : pricing?.kind === "negotiable" ? pricing.bandCenter
      : pricing?.kind === "auction" ? pricing.reservePrice
        : pricing?.kind === "metered" ? pricing.unitPrice : null;
  const priceTerm = price && typeof price === "object" && !Array.isArray(price)
    ? price as Record<string, unknown> : null;
  const minimum = pricing?.kind === "metered" ? record(pricing.minTotal) : null;
  const pricingKind: "fixed" | "negotiable" | "auction" | "metered" | undefined =
    pricing?.kind === "fixed" || pricing?.kind === "negotiable" || pricing?.kind === "auction" || pricing?.kind === "metered"
    ? pricing.kind : undefined;
  return {
    title: typeof currentOffering?.title === "string" ? currentOffering.title.slice(0, 200)
      : typeof scope.name === "string" ? scope.name.slice(0, 200) : "Unnamed service",
    description: typeof currentOffering?.description === "string" ? currentOffering.description.slice(0, 2000)
      : typeof scope.description === "string" ? scope.description.slice(0, 2000) : "",
    category,
    tags: boundedStrings(currentOffering?.tags ?? scope.tags, 16, 64),
    rails: boundedStrings(currentOffering ? acceptedRails : scope.supportedPaymentRails, 16, 128, railId),
    paymentPhases,
    flowPhases,
    delivery: currentOffering
      ? pipeline.filter((kind) => kind.startsWith("deliver-"))
      : boundedStrings(scope.supportedDelivery, 16, 128, protocolId),
    negotiation: currentOffering
      ? pipeline.filter((kind) => kind.startsWith("negotiate-"))
      : boundedStrings(scope.supportedNegotiation, 16, 128, protocolId),
    deliverable: currentOffering?.deliverable && typeof currentOffering.deliverable === "object"
      ? currentOffering.deliverable as Record<string, unknown> : undefined,
    pricing: pricing ? {
      kind: pricingKind,
      priceHint: typeof priceTerm?.amount === "string" ? priceTerm.amount : undefined,
      currency: typeof priceTerm?.currency === "string" ? priceTerm.currency : undefined,
      unit: pricing?.kind === "metered" && typeof pricing.unit === "string"
        ? pricing.unit
        : typeof priceTerm?.unit === "string" ? priceTerm.unit : undefined,
      minTotalHint: typeof minimum?.amount === "string" ? minimum.amount : undefined,
      minPct: typeof pricing.minPct === "number" ? pricing.minPct : undefined,
      maxPct: typeof pricing.maxPct === "number" ? pricing.maxPct : undefined,
      selectionRule: typeof pricing.selectionRule === "string" ? pricing.selectionRule : undefined,
    } : {},
  };
}
