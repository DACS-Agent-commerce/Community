/**
 * Rail IDs are DACS-4 §9.4.2 registry IDs, distinct from the phase handler
 * (`phaseKind`) they dispatch to. Every row repeats the pinned Standard's
 * v0.1 registry table (DACS-Standard d45c0a2, the dacs-sdk 3904d70
 * `dacs.standardRevision`); test/rail-registry.test.ts checks it against an
 * independent copy of that table.
 */
export const PUBLISHABLE_RAIL_OPTIONS = [
  { railId: "demos-native:DEM", railVersion: 1, phaseKind: "pay-dem", label: "DEM on Demos", availability: "live" },
  { railId: "x402:default", railVersion: 1, phaseKind: "pay-x402", label: "x402 micropayments", availability: "live" },
  {
    railId: "ap2:stripe-paymentintents",
    railVersion: 1,
    phaseKind: "pay-ap2",
    label: "Stripe PaymentIntents via AP2",
    availability: "operator_gated",
  },
] as const;

/**
 * DACS-4 PA-1 definitions carried in this exact reviewed app release.
 *
 * LRR-6 lets a PA-1 reader resolve only against a disclosed, signed in-code
 * snapshot. The pinned Standard publishes the v0.1 registry as an unsigned
 * table and no steward key exists, so no definition signature is verified:
 * `signatureValid` is false, and the SDK resolver answers `indeterminate`
 * (`pa1-definition-unverifiable`) once every other LRR check passes.
 */
export const PUBLISHER_IN_CODE_RAIL_DEFINITIONS = PUBLISHABLE_RAIL_OPTIONS.map((rail) => ({
  railId: rail.railId,
  railVersion: rail.railVersion,
  phaseHandler: rail.phaseKind,
  governanceAnchoring: "in-code",
  signatureValid: false,
}));

/**
 * A pay-bearing listing is published only on DACS-1 LP-6 `verified`. With the
 * unsigned table above every rail resolves `indeterminate`, so the browser
 * publisher refuses until a signed PA-1 snapshot or an authenticated PA-2/PA-3
 * registry exists.
 */
export function railAuthorityPermitsPublication(result: { disposition: string }): boolean {
  return result.disposition === "verified";
}

export const PUBLISHABLE_PRICING_KINDS = ["fixed", "negotiable", "auction", "metered"] as const;
export type PublishablePricingKind = (typeof PUBLISHABLE_PRICING_KINDS)[number];

/** DACS-4 §9.4.2 registry rail IDs: an exact `<namespace>:<qualifier>` token. */
export const RAIL_ID_PATTERN = /^[A-Za-z0-9._~-]+(?::[A-Za-z0-9._~-]+)+$/;

export function publishableRail(railId: string) {
  return PUBLISHABLE_RAIL_OPTIONS.find((option) => option.railId === railId);
}

export function negotiationPhaseForPricing(kind: PublishablePricingKind): string {
  return kind === "negotiable" ? "negotiate-rfq"
    : kind === "auction" ? "negotiate-sealed-envelope"
      : "negotiate-fixed-price";
}
