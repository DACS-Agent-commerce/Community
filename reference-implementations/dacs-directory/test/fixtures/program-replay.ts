import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import * as store from "../../src/catalog/store.js";
import { reindexAll } from "../../src/catalog/reindexCore.js";
import { SCAN_STATE_SCHEMA_VERSION } from "../../src/catalog/scanState.js";
import { GET as artifact } from "../../app/api/dacs/artifact/route.js";
import { dids, locator, vector } from "./current-evidence.js";
import { nodeOnChain } from "./pinned-node.js";
import { seedScanState } from "./chain-state.js";

export { store };
export const chainIdentity = "b".repeat(64);
export const buyer = dids[0], seller = dids[1], owner = `0x${buyer.slice(-64)}`;
const fixture = await vector("program-provenance", 6000);
export const agreementName = "dacs3:agreement:program-provenance";
export const bundleName = "dacs5:bundle:program-provenance";
export const receiptName = "dacs2:receipt:program-provenance";
export const agreementAt = fixture.locators.agreement, bundleAt = fixture.locators.buyer, receiptAt = locator(6010);
export const staleAt = locator(6099);
export const key = (name: string) => store.programBindingKey(owner, name);
export const retainedHash = "e".repeat(64), retainedMarker = locator(6098);
const programs = new Map([
  [agreementAt, { name: agreementName, data: fixture.agreement }],
  [bundleAt, { name: bundleName, data: {} }],
  [receiptAt, { name: receiptName, data: { receipt: "current-chain" } }],
]);

/** Two finalized transactions, one per page, plus an optional receipt. */
export function serveHistory(receipt = false): void {
  const written = [agreementAt, bundleAt, ...(receipt ? [receiptAt] : [])];
  globalThis.fetch = async (input, init) => {
    if (init?.body) {
      const call = JSON.parse(String(init.body)).params?.[0];
      if (call?.message !== "getTransactions") return Response.json({ result: 200, response: [] });
      const id = call.data.start === "latest" ? written.length : Math.min(call.data.start, written.length);
      return Response.json({ result: 200, response: id < 1 ? [] : [{ id, status: "confirmed", type: "transfer",
        content: JSON.stringify({ memo: written[id - 1] }) }] });
    }
    const at = String(input).split("/").pop() ?? "";
    const program = programs.get(at);
    return program ? Response.json({ success: true, owner, programName: program.name, data: program.data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
}

export function seed(programs: Record<string, string | null>, proven = false): void {
  store.saveRegistrations([]);
  store.saveDomains([]);
  store.saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [] });
  store.clearChainDerivedArtifacts();
  seedScanState({ schemaVersion: SCAN_STATE_SCHEMA_VERSION, lastSeenTxId: 0, listings: {}, deals: {}, programs,
    anchorBackfillComplete: true, verifiedRevocations: { [retainedHash]: [retainedMarker] },
    ...(proven ? { chainIdentity } : {}) });
  serveHistory();
}

export const replay = (nodeDeployment = nodeOnChain(chainIdentity)) => reindexAll({ nodeDeployment, log: () => {},
  resolveIdentities: async () => { throw new Error("identity unavailable"); } });

export function assertAttributed(): void {
  const state = store.loadScanState();
  assert.equal(state.programs[key(agreementName)], agreementAt);
  assert.equal(state.programs[key(bundleName)], bundleAt);
  assert.equal(Object.values(state.deals).find((deal) => deal.jobId === "program-provenance")?.owners.seller, seller);
  assert.ok(store.loadCatalog().sellers.some((record) => record.primaryClaim === seller && record.discovered));
  assert.deepEqual(store.loadCatalogChain(), { evidenceChain: chainIdentity, readySchema: SCAN_STATE_SCHEMA_VERSION });
  assert.deepEqual(state.verifiedRevocations?.[retainedHash], [retainedMarker], "withdrawal evidence is preserved");
}

export async function assertReceipt(): Promise<void> {
  assert.equal(store.resolveProgramAddress(owner, receiptName), receiptAt);
  const response = await artifact(new NextRequest(`http://localhost/api/dacs/artifact?owner=${owner}&name=${encodeURIComponent(receiptName)}`));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).value, { receipt: "current-chain" });
}
