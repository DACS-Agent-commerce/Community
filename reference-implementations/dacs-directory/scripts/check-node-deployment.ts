/**
 * Read-only deployment check: `npm run check:node-deployment`.
 * Reports the chain and build the configured node (DEMOS_RPC) serves, in the form
 * DEMOS_CHAIN_IDENTITY and DEMOS_NODE_BUILDS take, and exits 1 when they are not
 * pinned. Publication/inclusion require both pins; catalog refresh requires the
 * chain pin and reports build drift as a warning.
 * It sends no transactions and changes no pin: the operator reviews the reported
 * chain and build before setting the variables.
 */
import { observeNodeDeployment } from "../src/catalog/listingFinality.js";

let observed;
try {
  observed = await observeNodeDeployment();
} catch (error) {
  console.error(`could not read the Demos node's build and chain: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
console.log(JSON.stringify({
  rpc: process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/",
  chainIdentity: observed.chainIdentity,
  build: observed.build,
  pinned: observed.pin.ok,
  ...(observed.pin.ok ? {} : { reason: observed.pin.reason }),
}, null, 2));
if (!observed.pin.ok) {
  console.error(
    `\nPublication/inclusion observations require the pinned chain and build (${observed.pin.reason}).\nCatalog refresh requires the chain pin; build drift alone is a warning. After reviewing both, set\n` +
    `  DEMOS_CHAIN_IDENTITY=${observed.chainIdentity}\n` +
    (observed.build ? `  DEMOS_NODE_BUILDS=${observed.build}\n` : "") +
    "or point DEMOS_RPC at a node that serves the pinned deployment.",
  );
  process.exit(1);
}
