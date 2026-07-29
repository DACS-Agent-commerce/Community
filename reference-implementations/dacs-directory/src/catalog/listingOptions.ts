export const PUBLISHABLE_RAIL_OPTIONS = [
  { railId: "pay-dem", phaseKind: "pay-dem", label: "DEM on Demos", availability: "live" },
  { railId: "pay-x402", phaseKind: "pay-x402", label: "USDC via x402", availability: "live" },
  {
    railId: "ap2:stripe-paymentintents",
    phaseKind: "pay-ap2",
    label: "Stripe PaymentIntents via AP2",
    availability: "operator_gated",
  },
] as const;

export const PUBLISHABLE_PRICING_KINDS = ["fixed", "negotiable", "auction", "metered"] as const;
export type PublishablePricingKind = (typeof PUBLISHABLE_PRICING_KINDS)[number];

export function publishableRail(railId: string) {
  return PUBLISHABLE_RAIL_OPTIONS.find((option) => option.railId === railId);
}

export function negotiationPhaseForPricing(kind: PublishablePricingKind): string {
  return kind === "negotiable" ? "negotiate-rfq"
    : kind === "auction" ? "negotiate-sealed-envelope"
      : "negotiate-fixed-price";
}
