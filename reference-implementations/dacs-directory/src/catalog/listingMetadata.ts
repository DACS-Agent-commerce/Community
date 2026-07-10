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

/** Normalize signed-but-extensible listing fields before they reach the UI. */
export function listingPresentation(scope: Record<string, unknown>) {
  const rawCategory = typeof scope.category === "string"
    ? scope.category.trim().toLowerCase()
    : "";
  const category = /^[a-z0-9.-]{1,64}$/.test(rawCategory)
    ? rawCategory
    : "services.other";
  const protocolId = /^[a-z0-9:-]{1,128}$/;
  return {
    title: typeof scope.name === "string" ? scope.name.slice(0, 200) : "Unnamed service",
    description: typeof scope.description === "string" ? scope.description.slice(0, 2000) : "",
    category,
    tags: boundedStrings(scope.tags, 16, 64),
    rails: boundedStrings(scope.supportedPaymentRails, 16, 128, protocolId),
    delivery: boundedStrings(scope.supportedDelivery, 16, 128, protocolId),
    negotiation: boundedStrings(scope.supportedNegotiation, 16, 128, protocolId),
  };
}
