/**
 * The complete SDK Listing reader that `npm run check:listing-upgrade` runs on
 * each replacement Listing. The script and test/sdk-reader-verifiers.test.ts
 * both use this module, so the test pins exactly what the check runs.
 */
import type { ListingValidationDeps } from "../sdkListingValidation.js";
import { PUBLISHER_IN_CODE_RAIL_DEFINITIONS } from "./listingOptions.js";
import { sdkIdentityPresentationVerifier, sdkListingSignatureVerifier } from "./sdkReaderVerifiers.js";

export function listingUpgradeReaderDeps(input: {
  catalogObservedAt: number;
  readMarker: (marker: { locator: string }) => Promise<unknown>;
  supportedPayloadMethods: readonly string[];
  signer: string;
  nowMs?: () => number;
}): ListingValidationDeps {
  return {
    nowMs: input.nowMs ?? (() => Date.now()),
    verifyListingSignature: sdkListingSignatureVerifier(),
    revocation: {
      surfaces: [{ kind: "catalog", status: "active", catalogObservedAt: input.catalogObservedAt }],
      readMarker: input.readMarker,
      verifyMarkerSignature: () => false,
    },
    verifyIdentityPresentation: sdkIdentityPresentationVerifier(),
    loadRailResolution: () => ({
      trustPhase: "PA-1",
      trustPolicyAcceptsPA1: true,
      registry: { state: "not-used", entries: [], definitions: [] },
      inCodeDefinitions: PUBLISHER_IN_CODE_RAIL_DEFINITIONS,
    }),
    resolvePayloadVerificationCapability: ({ verificationMethod }) =>
      input.supportedPayloadMethods.includes(verificationMethod.kind)
        ? { disposition: "supported", reason: "deployment acceptance verifier is configured for this method" }
        : { disposition: "unsupported", reason: "method is not configured in this independent verifier" },
    verifySellerControl: ({ bundle, signer }) => signer === bundle.presentedBy && signer === input.signer,
  } as ListingValidationDeps;
}

/**
 * Why a replacement fails acceptance, or null when the reader returned
 * `verified` (DACS-1 LR-3, LP-6). With this release's unsigned PA-1 table a
 * pay-bearing replacement resolves `indeterminate`, so the check refuses it,
 * as the publisher does.
 */
export function listingUpgradeRefusal(validation: { disposition: string; reason?: string }): string | null {
  if (validation.disposition === "verified") return null;
  const result = `complete SDK reader returned ${validation.disposition} (${validation.reason ?? "no reason"})`;
  return validation.reason === "pa1-definition-unverifiable"
    ? `${result}: this release's PA-1 rail table is unsigned, so no pay-bearing replacement is LP-6 verified until a signed snapshot ships`
    : result;
}
