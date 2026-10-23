/**
 * Read-only node contract probe: `npm run check:node -- <exact program name> [known SDK logical address]`.
 * Uses DEMOS_RPC (default as in src/catalog/chain.ts); prints a dated JSON report and exits 1 when
 * the contract does not hold. A successful generic diagnostic exits 2; only
 * an observation bound to the requested SDK logical address exits 0. It sends no transactions.
 */
import { probeNodeContract } from "../src/catalog/nodeContract.js";

const programName = process.argv[2];
if (!programName) {
  console.error("usage: npm run check:node -- <exact program name of a known public program> [known SDK logical address]");
  process.exit(2);
}
const expectedLogicalAddress = process.argv[3];
const report = await probeNodeContract(process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/", programName, expectedLogicalAddress);
const scope = expectedLogicalAddress === undefined ? "generic-read" : "sdk-anchor";
console.log(JSON.stringify({ scope, ...report }, null, 2));
process.exit(report.ok ? (scope === "sdk-anchor" ? 0 : 2) : 1);
