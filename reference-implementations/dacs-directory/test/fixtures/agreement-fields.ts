/** Unix ms generation time carried by schema-valid agreement fixtures. */
export const AGREEMENT_GENERATED_AT = 80;
const AGREEMENT_PARTY_BUNDLE_HASH = { buyer: "a".repeat(64), seller: "b".repeat(64), "bidder-non-winning": "d".repeat(64) };
const VET_RECORD_LOCATOR = `stor-${(0xf0).toString(16).padStart(40, "0")}`;

/** A DACS-3 §8.5 AgreementParty with the bundle hash and Vet record reference the schema requires. */
export const agreementParty = (role: keyof typeof AGREEMENT_PARTY_BUNDLE_HASH, primaryClaim: string) => ({
  role,
  bundleHash: AGREEMENT_PARTY_BUNDLE_HASH[role],
  primaryClaim,
  vetRecordRef: { anchor: { kind: "storage-program", locator: VET_RECORD_LOCATOR }, contentHash: "c".repeat(64) },
});
