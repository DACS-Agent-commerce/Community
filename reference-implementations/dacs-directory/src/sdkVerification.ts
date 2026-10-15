/**
 * One compatibility seam for the SDK's public verification exports.
 *
 * The current SDK exposes these names from its top-level barrel, but that
 * barrel also statically re-exports optional Node/multi-chain modules. Resolve
 * the public names through their pure implementations until the SDK ships a
 * browser-safe public verification subpath.
 */
export {
  verifyBundleCore,
  type BundleVerification,
} from "../vendor/dacs-sdk/dist/agent/verifyBundleCore.js";
export {
  verifySignedArtifact,
} from "../vendor/dacs-sdk/dist/agent/signedArtifact.js";
