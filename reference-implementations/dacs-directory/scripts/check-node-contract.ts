/**
 * Read-only node contract probe: `npm run check:node -- <exact program name> [known SDK logical address]`.
 * Uses DEMOS_RPC (default as in src/catalog/chain.ts); prints a dated JSON report and exits 1 when
 * the contract does not hold. It sends no transactions.
 */
import { probeNodeContract } from "../src/catalog/nodeContract.js";

const programName = process.argv[2];
if (!programName) {
  console.error("usage: npm run check:node -- <exact program name of a known public program> [known SDK logical address]");
  process.exit(2);
}
const report = await probeNodeContract(process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/", programName, process.argv[3]);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
