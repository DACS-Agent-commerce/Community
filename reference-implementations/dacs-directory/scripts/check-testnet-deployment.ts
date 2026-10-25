/**
 * Startup gate of the testnet deployment (deploy/testnet): exits 1 unless this
 * environment is the testnet profile and the configured node serves the
 * pinned testnet chain. The systemd units run it before the web server and
 * before every index pass.
 *
 *   npm run check:testnet
 */
import { checkTestnetStartup } from "../src/catalog/testnetDeployment.js";

const result = await checkTestnetStartup();
if (!result.ok) {
  console.error(`refusing to start: ${result.reason}`);
  process.exit(1);
}
console.log(`testnet chain ${result.chainIdentity} confirmed`);
