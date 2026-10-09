/**
 * Server-only compatibility seam for pure Demos finality-evidence helpers.
 * Importing the SDK substrate barrel also loads the optional demosdk adapter
 * and its unrelated multichain/ZK tree, which the Directory does not use.
 */
export {
  assertDemosWriteEvidence,
  demosSignedTransactionProofHash,
  demosWriteEvidenceToAnchorReceipt,
} from "../vendor/dacs-sdk/dist/substrate/demosWriteEvidence.js";
export type {
  DemosWriteEvidence,
} from "../vendor/dacs-sdk/dist/substrate/SubstrateAdapter.js";
