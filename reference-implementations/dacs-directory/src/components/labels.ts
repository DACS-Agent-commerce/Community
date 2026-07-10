/** Human labels for the spec's kebab-case rail / delivery / negotiation ids. */
export const RAIL_LABELS: Record<string, string> = {
  "pay-dem": "DEM",
  "pay-x402": "USDC · x402",
  "pay-evm-erc8183": "ERC-8183",
};
export const railLabel = (r: string) => RAIL_LABELS[r] ?? r.replace(/^pay-/, "");
/** "negotiate-fixed-price" → "fixed price" */
export const negotiationLabel = (n: string) =>
  n.replace(/^negotiate-/, "").replace(/-/g, " ");
/** "deliver-attested-payload" → "attested payload" */
export const deliveryLabel = (d: string) =>
  d.replace(/^deliver-/, "").replace(/-/g, " ");

/** §6.3.2.1 identity tiers, in trust order, with chip classes + hover copy. */
export const IDENTITY_TIERS = [
  {
    id: "institutional",
    label: "institutional",
    chipClass: "tier-institutional",
    hint: "Holds a verified authority-issued regulatory identity (LEI, FINRA CRD, SAM UEI, FedRAMP, CMMC, NAICS) — §6.3.2.1",
  },
  {
    id: "verified",
    label: "verified",
    chipClass: "tier-verified",
    hint: "Has at least one identity claim verified on-chain (GitHub, Discord, wallet, DID) — §6.3.2.1. Derived from on-chain CCI claims, never self-reported.",
  },
  {
    id: "self-declared",
    label: "self-declared",
    chipClass: "tier-self",
    hint: "No verified identity claims — only its signing key. §6.3.2.1",
  },
] as const;
export type IdentityTierId = (typeof IDENTITY_TIERS)[number]["id"];
export const tierMeta = (id: string) =>
  IDENTITY_TIERS.find((t) => t.id === id) ?? IDENTITY_TIERS[2];
