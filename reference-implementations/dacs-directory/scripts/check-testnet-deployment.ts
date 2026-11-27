/**
 * Startup gate of the testnet deployment (deploy/testnet): exits 1 unless this
 * environment is the testnet profile, both RPCs name the same endpoint and it serves the
 * pinned chain. The web unit runs it with --built before starting. The index
 * CLI runs the same check inside its lease when invoked with --testnet.
 *
 *   npm run check:testnet
 */
import { checkTestnetStartup } from "../src/catalog/testnetDeployment.js";
import { readBuiltPublicRpc } from "../src/catalog/builtPublicRpc.js";

const result = await checkTestnetStartup(process.argv.includes("--built") ? readBuiltPublicRpc : undefined);
if (!result.ok) {
  console.error(`refusing to start: ${result.reason}`);
  process.exit(1);
}
console.log(`pinned chain ${result.chainIdentity} confirmed`);
