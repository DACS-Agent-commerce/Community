/**
 * Server-only compatibility seam for the current SDK's public Listing reader
 * and publication gates. Keep this separate from sdkVerification.ts: the
 * Listing implementation intentionally uses node:net for outbound-address
 * policy and must never enter the browser verification bundle.
 */
export {
  resolveListingPayloadVerificationCapability,
  resolveListingRails,
  validateListingArtifact,
  type ListingValidationDeps,
} from "../vendor/dacs-sdk/dist/agent/listingValidation.js";
