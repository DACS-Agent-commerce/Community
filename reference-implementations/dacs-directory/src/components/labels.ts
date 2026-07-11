/** Human labels for the spec's kebab-case rail / delivery / negotiation ids. */
export const RAIL_LABELS: Record<string, string> = {
  "pay-dem": "DEM",
  "pay-x402": "USDC · x402",
  "pay-evm-erc8183": "ERC-8183",
};
export const railLabel = (r: string) => RAIL_LABELS[r] ?? r.replace(/^pay-/, "");
/** "negotiate-fixed-price" → "fixed price"; acronym ids get proper casing. */
export const NEGOTIATION_LABELS: Record<string, string> = {
  "negotiate-rfq": "RFQ",
};
export const negotiationLabel = (n: string) =>
  NEGOTIATION_LABELS[n] ?? n.replace(/^negotiate-/, "").replace(/-/g, " ");
export const pricingModelLabel = (negotiation: string[] | undefined) =>
  negotiation?.length ? negotiation.map(negotiationLabel).join(", ") : "Not stated";
/** "deliver-attested-payload" → "attested payload" */
export const deliveryLabel = (d: string) =>
  d.replace(/^deliver-/, "").replace(/-/g, " ");

/** DACS identity tiers. Elevation requires a fresh resolved DACS-2 VerifyResult. */
export const IDENTITY_TIERS = [
  {
    id: "institutional",
    label: "institutional verification",
    chipClass: "tier-institutional",
    hint: "A fresh DACS-2 result verifies an authority-issued regulatory identity.",
  },
  {
    id: "verified",
    label: "DACS-verified identity",
    chipClass: "tier-verified",
    hint: "At least one identity claim has a fresh passing DACS-2 verification result.",
  },
  {
    id: "self-declared",
    label: "signing key only",
    chipClass: "tier-self",
    hint: "The listing is signed, but no fresh DACS-2 identity verification has been resolved.",
  },
] as const;
export type IdentityTierId = (typeof IDENTITY_TIERS)[number]["id"];
export const tierMeta = (id: string) =>
  IDENTITY_TIERS.find((t) => t.id === id) ?? IDENTITY_TIERS[2];
