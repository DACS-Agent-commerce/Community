/** Human labels for the spec's kebab-case rail / delivery / negotiation ids. */
export const RAIL_LABELS: Record<string, string> = {
  "pay-dem": "DEM wallet",
  "pay-x402": "USDC",
  "pay-evm-erc8183": "Protected escrow",
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
    label: "Organisation verified",
    chipClass: "tier-institutional",
    hint: "This provider has linked an identity issued by a recognised organisation or regulator.",
  },
  {
    id: "verified",
    label: "Identity verified",
    chipClass: "tier-verified",
    hint: "This provider has proved ownership of at least one linked account or wallet.",
  },
  {
    id: "self-declared",
    label: "Basic profile",
    chipClass: "tier-self",
    hint: "This profile has a signing key but no linked identity has been verified yet.",
  },
] as const;
export type IdentityTierId = (typeof IDENTITY_TIERS)[number]["id"];
export const tierMeta = (id: string) =>
  IDENTITY_TIERS.find((t) => t.id === id) ?? IDENTITY_TIERS[2];
