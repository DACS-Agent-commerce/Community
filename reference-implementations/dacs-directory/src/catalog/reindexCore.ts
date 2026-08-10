/**
 * Full reindex, callable: incremental chain scan to the tip, §6.3.5 domain
 * crawl, then re-verify every registration (submitted + discovered) against
 * chain state and rewrite the catalog cache. Used by the CLI (npm run index)
 * and by POST /api/dacs/reindex (the UI's refresh button).
 */
import { createHash } from "node:crypto";
import { indexRegistration, type ResolveIdentities } from "./indexer";
import { boundedBundleBindings, verifyBundleBinding } from "./bundleBinding";
import {
  boundedRevocationCandidates,
  readChainTip,
  scanChain,
  scanConsensusAnchorBackfill,
} from "./scan";
import { chainResetRequired, chainResetThreshold } from "./chainContinuity";
import { crawlDomains } from "./wellknown";
import { upsertCounterpartyEvidenceSeller } from "./counterpartyEvidence";
import { refreshReachabilityHints } from "./reachability";
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
  clearChainDerivedArtifacts,
  recordArtifact,
  pruneFailureHistory,
  recordArtifactFailure,
  loadUnanchoredBundleTargets,
  recordConsensusAnchors,
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
  //    accumulated scan state. Discoveries persist while the chain does; a
  //    confirmed large tip regression clears derived state before a genesis
  //    rescan. First run backfills the full history.
  let state = loadScanState();
  const resetThreshold = chainResetThreshold();
  let observedChainTip: number | null = null;
  try {
    observedChainTip = await readChainTip();
  } catch {
    // The normal scan below retains the established fail-closed behaviour and
    // surfaces the node error. This preflight exists only for reset detection.
  }
  if (observedChainTip !== null && chainResetRequired(state, observedChainTip, resetThreshold)) {
    const previousCursor = state.lastSeenTxId;
    clearChainDerivedArtifacts();
    state = {
      schemaVersion: 8,
      lastSeenTxId: 0,
      lastChainTip: observedChainTip,
      listings: {},
      deals: {},
      programs: {},
      revocations: {},
      verifiedRevocations: {},
      bundleBindings: {},
      bundleBindingOverflow: [],
      anchorBackfillComplete: false,
    };
    saveScanState(state);
    log(
      `chain replacement detected: tip ${observedChainTip} is more than ${resetThreshold} txs ` +
        `behind cursor ${previousCursor}; cleared chain-derived cache and restarting from genesis`,
    );
  }
  // v8 replays history to classify stable storage failures without the legacy
  // STORAGE_UNREADABLE bucket. It retains v7's BundleBinding, v6's consensus-
  // time and v5's revocation-marker binding replays.
  const needsHistoryReplay = state.schemaVersion !== 8;
  const configuredMax = Number(process.env.DACS_SCAN_MAX_TXS ?? 100000);
  const maxTxs = Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : 100000;
  const configuredOverlap = Number(process.env.DACS_SCAN_REPLAY_DEPTH ?? 2);
  const overlap = Number.isSafeInteger(configuredOverlap) && configuredOverlap >= 0 ? configuredOverlap : 2;
  const sinceTxId = needsHistoryReplay ? 0 : Math.max(0, state.lastSeenTxId - overlap);
  state.verifiedRevocations ??= {};
  state.bundleBindings ??= {};
  state.bundleBindingOverflow ??= [];
  // Registrations are untrusted carriage (BB-3). Re-verify on every ingest so
  // hand-edited or legacy persisted JSON cannot bypass the BB-4 gate.
  for (const reg of regs) {
    const verified = (await Promise.all((reg.bundleBindings ?? []).map(verifyBundleBinding)))
      .filter((binding) => binding !== null);
    for (const binding of verified) {
      const bounded = boundedBundleBindings([...(state.bundleBindings[binding.jobId] ?? []), binding]);
      state.bundleBindings[binding.jobId] = bounded.bindings;
      state.bundleBindingOverflow = [...new Set([
        ...state.bundleBindingOverflow,
        ...bounded.overflowKeys,
      ])].sort();
    }
  }
  for (const seller of prior.sellers) for (const listing of seller.listings) {
    const locator = listing.revocationBinding?.markerAnchor.locator;
    if (!locator) continue;
    const verified = state.verifiedRevocations[listing.contentHash] ?? [];
    if (!verified.includes(locator)) verified.push(locator);
    state.verifiedRevocations[listing.contentHash] = verified;
  }
  const verifiedRevocations = new Map(
    Object.entries(state.verifiedRevocations).map(([hash, addresses]) => [hash, new Set(addresses)]),
  );
  const runId = beginScanRun(sinceTxId);
  let scan;
  try {
    scan = await scanChain(null, { maxTxs, sinceTxId, retryLocators: loadRetryableArtifacts(), verifiedRevocations });
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
  if (needsHistoryReplay) state.revocations = {};
  state.revocations ??= {};
  let revocationCandidatesTruncated = scan.revocationCandidatesTruncated;
  for (const [hash, addresses] of scan.revocations) {
    const priorCandidates = state.revocations[hash];
    const prior = Array.isArray(priorCandidates)
      ? priorCandidates
      : priorCandidates ? [priorCandidates] : [];
    const merged = boundedRevocationCandidates(
      [...addresses, ...prior],
      verifiedRevocations.get(hash),
    );
    state.revocations[hash] = merged.candidates;
    revocationCandidatesTruncated += merged.truncated;
  }
  for (const [jobId, bindings] of scan.bundleBindings) {
    const bounded = boundedBundleBindings([...(state.bundleBindings[jobId] ?? []), ...bindings]);
    state.bundleBindings[jobId] = bounded.bindings;
    state.bundleBindingOverflow = [...new Set([
      ...state.bundleBindingOverflow,
      ...bounded.overflowKeys,
    ])].sort();
  }
  state.bundleBindingOverflow = [...new Set([
    ...state.bundleBindingOverflow,
    ...scan.bundleBindingOverflow,
  ])].sort();
  // Bound legacy and inactive hashes too; a hash need not reappear in the
  // current scan window for old persisted state to remain attacker-inflated.
  for (const [hash, stored] of Object.entries(state.revocations)) {
    const candidates = Array.isArray(stored) ? stored : [stored];
    const bounded = boundedRevocationCandidates(candidates, verifiedRevocations.get(hash));
    state.revocations[hash] = bounded.candidates;
    revocationCandidatesTruncated += bounded.truncated;
  }
  for (const observation of scan.observations) recordArtifact(observation);
  for (const failure of scan.failures) {
    const stable = failure.code === "STORAGE_NOT_FOUND" || failure.code === "STORAGE_NOT_PUBLIC";
    recordArtifactFailure(failure.locator, failure.kind, failure.code, failure.message, stable ? 1 : 5);
  }
  // One bounded age-prune batch per pass keeps failure telemetry from growing
  // without limit (issue #51) while never becoming a blocking maintenance job.
  pruneFailureHistory();

  // SR-2: bounded historical walk over only unresolved bundle content. The
  // target fingerprint prevents permanently-unresolvable rows from causing a
  // full-history rescan on every indexing pass, while a changed/new target set
  // automatically starts a fresh resumable cycle.
  let anchorTargets = loadUnanchoredBundleTargets();
  const targetKey = (targets: ReadonlyMap<string, string>) => createHash("sha256")
    .update([...targets].sort(([a], [b]) => a.localeCompare(b)).map(([locator, hash]) => `${locator}:${hash}`).join("\n"))
    .digest("hex");
  let unresolvedKey = targetKey(anchorTargets);
  if (state.anchorBackfillTargetKey !== unresolvedKey) {
    state.anchorBackfillCursor = undefined;
    state.anchorBackfillComplete = false;
    state.anchorBackfillTargetKey = unresolvedKey;
  }
  if (anchorTargets.size > 0 && !state.anchorBackfillComplete) {
    try {
      const configuredBackfillMax = Number(process.env.DACS_ANCHOR_BACKFILL_MAX_TXS ?? 500);
      const configuredBackfillBudget = Number(process.env.DACS_ANCHOR_BACKFILL_BUDGET_MS ?? 10_000);
      const backfill = await scanConsensusAnchorBackfill(anchorTargets, {
        cursor: state.anchorBackfillCursor,
        maxTxs: configuredBackfillMax,
        budgetMs: configuredBackfillBudget,
      });
      const updated = recordConsensusAnchors(backfill.observations);
      state.anchorBackfillCursor = backfill.nextCursor;
      state.anchorBackfillComplete = backfill.complete;
      anchorTargets = loadUnanchoredBundleTargets();
      unresolvedKey = targetKey(anchorTargets);
      state.anchorBackfillTargetKey = unresolvedKey;
      if (anchorTargets.size === 0) state.anchorBackfillComplete = true;
      log(`SR-2 anchor backfill: scanned ${backfill.txsScanned} tx(s), resolved ${updated}, ` +
        `${anchorTargets.size} bundle(s) remain${backfill.complete ? " (history exhausted)" : ""}`);
    } catch (error) {
      log(`SR-2 anchor backfill deferred: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (anchorTargets.size === 0) {
    state.anchorBackfillCursor = undefined;
    state.anchorBackfillComplete = true;
    state.anchorBackfillTargetKey = unresolvedKey;
  }
  const nextCursor = Math.max(state.lastSeenTxId, scan.highestTxId);
  if (nextCursor > state.lastSeenTxId) state.cursorAdvancedAt = Date.now();
  // Seed upgraded state once so an already-frozen cursor becomes diagnosable
  // after the configured interval instead of remaining "unknown" forever.
  else state.cursorAdvancedAt ??= Date.now();
  state.lastSeenTxId = nextCursor;
  state.lastChainTip = scan.chainTip;
  state.schemaVersion = 8;
  saveScanState(state);
  finishScanRun(runId, { toTx: state.lastSeenTxId, chainTip: scan.chainTip, txs: scan.txsScanned,
    artifacts: scan.observations.length, rejected: scan.failures.length });
  log(
    `chain scan: ${scan.txsScanned} new txs (cursor → ${state.lastSeenTxId}) — ` +
      `+${scan.listings.size} listing(s), +${scan.deals.size} deal(s); ` +
      `accumulated: ${Object.keys(state.listings).length} listing(s), ${Object.keys(state.deals).length} deal(s)`,
  );
  if (revocationCandidatesTruncated > 0) {
    log(`revocation candidates: truncated ${revocationCandidatesTruncated} unverified locator(s) at the per-listing bound`);
  }
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
    const bindings = state.bundleBindings[deal.jobId] ?? [];
    if (bindings.length > 0) {
      reg.bundleBindings ??= [];
      const knownBindings = new Set(reg.bundleBindings.map((binding) => JSON.stringify(binding)));
      for (const binding of bindings) {
        const key = JSON.stringify(binding);
        if (!knownBindings.has(key)) {
          reg.bundleBindings.push(binding);
          knownBindings.add(key);
        }
      }
    }
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
      if (agent.bundleBindings.length > 0) {
        reg.bundleBindings ??= [];
        const carried = boundedBundleBindings([...reg.bundleBindings, ...agent.bundleBindings]);
        reg.bundleBindings = carried.bindings;
        for (const binding of carried.bindings) {
          const accumulated = boundedBundleBindings([...(state.bundleBindings[binding.jobId] ?? []), binding]);
          state.bundleBindings[binding.jobId] = accumulated.bindings;
          state.bundleBindingOverflow = [...new Set([
            ...state.bundleBindingOverflow,
            ...carried.overflowKeys,
            ...accumulated.overflowKeys,
          ])].sort();
        }
      }
      log(`well-known: ${agent.domain} → ${agent.seller.slice(0, 30)}… (+${agent.listingAnchors.length} anchor(s), ` +
        `+${agent.bundleBindings.length} bundle binding(s), index hash ✓)`);
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

  for (const seller of catalogSellers) for (const listing of seller.listings) {
    const locator = listing.revocationBinding?.markerAnchor.locator;
    if (!locator) continue;
    const verified = state.verifiedRevocations[listing.contentHash] ?? [];
    if (!verified.includes(locator)) verified.push(locator);
    state.verifiedRevocations[listing.contentHash] = verified;
    const stored = state.revocations?.[listing.contentHash];
    const candidates = Array.isArray(stored) ? stored : stored ? [stored] : [];
    state.revocations![listing.contentHash] = boundedRevocationCandidates(
      [locator, ...candidates],
      new Set(verified),
    ).candidates;
  }
  state.reachabilityCursor = await refreshReachabilityHints(catalogSellers, prior.sellers, {
    cursor: state.reachabilityCursor,
  });
  saveScanState(state);

  saveCatalog({ catalogVersion: "1", generatedAt, sellers: catalogSellers });
  log(`catalog written: ${catalogSellers.length} seller(s)`);
  return { sellers: catalogSellers.length, newTxs: scan.txsScanned, cursor: state.lastSeenTxId };
}
