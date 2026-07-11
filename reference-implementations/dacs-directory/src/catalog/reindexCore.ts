/**
 * Full reindex, callable: incremental chain scan to the tip, §6.3.5 domain
 * crawl, then re-verify every registration (submitted + discovered) against
 * chain state and rewrite the catalog cache. Used by the CLI (npm run index)
 * and by POST /api/dacs/reindex (the UI's refresh button).
 */
import { indexRegistration, type ResolveIdentities } from "./indexer";
import { scanChain } from "./scan";
import { crawlDomains } from "./wellknown";
import { upsertCounterpartyEvidenceSeller } from "./counterpartyEvidence";
import {
  loadCatalog,
  loadDomains,
  loadFixtureSeeds,
  loadRegistrations,
  loadScanState,
  saveCatalog,
  saveScanState,
  beginScanRun,
  finishScanRun,
  loadRetryableArtifacts,
  recordArtifact,
  recordArtifactFailure,
} from "./store";
import type { Registration } from "./types";
import type { ResolveRecipe } from "./identityVerification";

export interface ReindexSummary {
  sellers: number;
  newTxs: number;
  cursor: number;
}

export interface ReindexOptions {
  log?: (line: string) => void;
  /**
   * Identity resolver injected by tests or alternate deployments. Production
   * CLI/routes use the narrow authenticated fetch implementation in gcr.ts.
   */
  resolveIdentities?: ResolveIdentities;
  resolveRecipe?: ResolveRecipe;
}

export async function reindexAll(opts: ReindexOptions = {}): Promise<ReindexSummary> {
  const log = opts.log ?? console.log;
  const regs: (Registration & { discovered?: boolean })[] = loadRegistrations();
  const prior = loadCatalog();

  // ── Passive discovery, incremental: walk latest → cursor, union into the
  //    accumulated scan state. Discoveries are never forgotten (the chain is
  //    the proof; this state is just the memory of where to look). First run
  //    backfills the full history.
  const state = loadScanState();
  const needsBindingBackfill = state.schemaVersion !== 4;
  const configuredMax = Number(process.env.DACS_SCAN_MAX_TXS ?? 100000);
  const maxTxs = Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : 100000;
  const configuredOverlap = Number(process.env.DACS_SCAN_REPLAY_DEPTH ?? 2);
  const overlap = Number.isSafeInteger(configuredOverlap) && configuredOverlap >= 0 ? configuredOverlap : 2;
  const sinceTxId = needsBindingBackfill ? 0 : Math.max(0, state.lastSeenTxId - overlap);
  const runId = beginScanRun(sinceTxId);
  let scan;
  try {
    scan = await scanChain(null, { maxTxs, sinceTxId, retryLocators: loadRetryableArtifacts() });
  } catch (error) {
    finishScanRun(runId, { toTx: state.lastSeenTxId, txs: 0, artifacts: 0, rejected: 0, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  if (!scan.complete) {
    finishScanRun(runId, { toTx: state.lastSeenTxId, chainTip: scan.chainTip, txs: scan.txsScanned,
      artifacts: scan.observations.length, rejected: scan.failures.length,
      error: scan.scanError ?? `scan limit ${maxTxs} reached before cursor` });
    throw new Error(
      scan.scanError ? `chain scan failed before reaching its cursor: ${scan.scanError}` :
      `chain scan hit DACS_SCAN_MAX_TXS=${maxTxs} before reaching its cursor; increase the limit so the catalog cannot skip history`,
    );
  }
  for (const [addr, owner] of scan.listings) state.listings[addr] = owner;
  for (const [jobId, deal] of scan.deals) state.deals[jobId] = deal;
  state.programs ??= {};
  for (const [key, address] of scan.programs) state.programs[key] = address;
  if (needsBindingBackfill) state.revocations = {};
  state.revocations ??= {};
  for (const [hash, addresses] of scan.revocations) {
    const priorCandidates = state.revocations[hash];
    const prior = Array.isArray(priorCandidates)
      ? priorCandidates
      : priorCandidates ? [priorCandidates] : [];
    state.revocations[hash] = [...new Set([...addresses, ...prior])];
  }
  for (const observation of scan.observations) recordArtifact(observation);
  for (const failure of scan.failures) recordArtifactFailure(failure.locator, failure.kind, failure.code, failure.message);
  state.lastSeenTxId = Math.max(state.lastSeenTxId, scan.highestTxId);
  state.lastChainTip = scan.chainTip;
  state.schemaVersion = 4;
  saveScanState(state);
  finishScanRun(runId, { toTx: state.lastSeenTxId, chainTip: scan.chainTip, txs: scan.txsScanned,
    artifacts: scan.observations.length, rejected: scan.failures.length });
  log(
    `chain scan: ${scan.txsScanned} new txs (cursor → ${state.lastSeenTxId}) — ` +
      `+${scan.listings.size} listing(s), +${scan.deals.size} deal(s); ` +
      `accumulated: ${Object.keys(state.listings).length} listing(s), ${Object.keys(state.deals).length} deal(s)`,
  );
  const didOf = (addr: string) => `did:demos:agent:${addr.replace(/^0x/, "")}`;
  const known = new Set(regs.map((r) => r.primaryClaim));

  // Fold discovered listings/deals into synthetic registrations per seller.
  const discovered = new Map<string, Registration & { discovered: true }>();
  const sellerReg = (claim: string) => {
    if (known.has(claim)) return regs.find((r) => r.primaryClaim === claim)!;
    if (!discovered.has(claim)) {
      discovered.set(claim, {
        primaryClaim: claim,
        displayName: `agent ${claim.slice(-8)}`,
        listingAnchors: [],
        deals: [],
        discovered: true,
      });
    }
    return discovered.get(claim)!;
  };
  // Index from the ACCUMULATED state, not just this pass's window.
  for (const [anchor, owner] of Object.entries(state.listings)) {
    const reg = sellerReg(didOf(owner));
    if (!reg.listingAnchors.includes(anchor)) reg.listingAnchors.push(anchor);
  }
  for (const deal of Object.values(state.deals)) {
    if (!deal.owners.seller) continue; // unattributable — skip
    const reg = sellerReg(deal.owners.seller);
    reg.deals ??= [];
    if (!reg.deals.some((d) => d.jobId === deal.jobId)) reg.deals.push(deal);
  }
  // ── Channel 3: §6.3.5 well-known crawl (hash-bound per-agent indexes) ──
  const domains = loadDomains();
  if (domains.length > 0) {
    const crawl = await crawlDomains(domains);
    for (const e of crawl.errors) log(`well-known: ${e.domain} — ${e.error}`);
    for (const agent of crawl.agents) {
      const reg = sellerReg(agent.seller) as Registration & { wellKnownDomains?: string[]; discovered?: boolean };
      if (agent.displayName && reg.displayName.startsWith("agent ")) reg.displayName = agent.displayName;
      for (const anchor of agent.listingAnchors) {
        if (!reg.listingAnchors.includes(anchor)) {
          reg.listingAnchors.push(anchor);
          const declaredHash = agent.contentHashes[anchor];
          if (declaredHash) {
            reg.listingContentHashes ??= {};
            reg.listingContentHashes[anchor] = declaredHash;
          }
        }
      }
      reg.wellKnownDomains = [...new Set([...(reg.wellKnownDomains ?? []), agent.domain])];
      log(`well-known: ${agent.domain} → ${agent.seller.slice(0, 30)}… (+${agent.listingAnchors.length} anchor(s), index hash ✓)`);
    }
  }
  const allRegs = [...regs, ...discovered.values()];

  const sellers = [];
  for (const reg of allRegs) {
    const before = prior.sellers.find((s) => s.primaryClaim === reg.primaryClaim);
    log(`indexing ${reg.displayName} (${reg.primaryClaim.slice(0, 24)}…)`);
    const record = await indexRegistration(reg, before, opts.resolveIdentities, opts.resolveRecipe);
    record.discovered = (reg as { discovered?: boolean }).discovered ?? false;
    record.wellKnownDomains = (reg as { wellKnownDomains?: string[] }).wellKnownDomains;
    log(
      `  listings=${record.listings.length} cci=${record.cci.length} deals=${record.deals.length} ` +
        `verified=${record.deals.filter((d) => d.refsVerified).length} completed=${record.reputation.completed}`,
    );
    sellers.push(record);
  }

  const generatedAt = Date.now();
  const fixtureSeeds = loadFixtureSeeds();
  const catalogSellers = fixtureSeeds.includes("counterparty-evidence")
    ? upsertCounterpartyEvidenceSeller(sellers, generatedAt)
    : sellers;
  if (fixtureSeeds.includes("counterparty-evidence")) {
    log("fixture: Counterparty Evidence Desk preserved");
  }

  saveCatalog({ catalogVersion: "1", generatedAt, sellers: catalogSellers });
  log(`catalog written: ${catalogSellers.length} seller(s)`);
  return { sellers: catalogSellers.length, newTxs: scan.txsScanned, cursor: state.lastSeenTxId };
}
