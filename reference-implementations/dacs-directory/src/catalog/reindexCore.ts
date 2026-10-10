/**
 * Full reindex, callable: incremental chain scan to the tip, §6.3.5 domain
 * crawl, then re-verify every registration (submitted + discovered) against
 * chain state and rewrite the catalog cache. Used by the CLI (npm run index)
 * and by POST /api/dacs/reindex (the UI's refresh button).
 */
import { discoveredDealKey, normalizeScanState, ownArray, SCAN_STATE_SCHEMA_VERSION } from "./scanState.js";
import { MAX_REGISTRATION_BUNDLE_BINDINGS, parseRegistration } from "./registration.js";
import { createHash } from "node:crypto";
import { indexRegistration, type ResolveIdentities } from "./indexer";
import { boundedBundleBindings, verifyBundleBinding } from "./bundleBinding";
import {
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
  admitRevocationCandidates,
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
  throwIfInfrastructureError,
} from "./store";
import type { BundleBinding, Registration } from "./types";
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
  const omitted = { omittedSellers: 0, omittedBindings: 0, omittedDeals: 0 };
  const regs: (Registration & { discovered?: boolean })[] = [];
  for (const raw of loadRegistrations()) {
    // The registration and its binding count are checked before any binding is verified;
    // admitted bindings are then verified one at a time.
    const rawBindings: unknown = raw?.bundleBindings;
    const admitted = Array.isArray(rawBindings) && rawBindings.length <= MAX_REGISTRATION_BUNDLE_BINDINGS ? rawBindings : undefined;
    let parsed = parseRegistration(admitted ? { ...raw, bundleBindings: [] } : raw);
    if (parsed.ok && admitted) {
      const bindings: BundleBinding[] = [];
      for (const binding of admitted) {
        const verified = await verifyBundleBinding(binding);
        if (verified) bindings.push(verified);
      }
      omitted.omittedBindings += admitted.length - bindings.length;
      parsed = parseRegistration({ ...raw, bundleBindings: bindings });
    }
    if (!parsed.ok) {
      omitted.omittedSellers++;
      const claim = typeof raw?.primaryClaim === "string" ? raw.primaryClaim.slice(0, 24) : "invalid claim";
      log(`seller indexing failed (${claim}), omitted from this catalog: ${parsed.error}`);
      continue;
    }
    regs.push({ ...parsed.value,
      ...(raw.listingContentHashes && typeof raw.listingContentHashes === "object" && !Array.isArray(raw.listingContentHashes)
        ? { listingContentHashes: raw.listingContentHashes } : {}),
    });
  }
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
    state = normalizeScanState({
      schemaVersion: SCAN_STATE_SCHEMA_VERSION,
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
    });
    saveScanState(state);
    log(
      `chain replacement detected: tip ${observedChainTip} is more than ${resetThreshold} txs ` +
        `behind cursor ${previousCursor}; cleared chain-derived cache and restarting from genesis`,
    );
  }
  // v9 replays history to recover duplicate programs discarded by older caches.
  // It retains earlier storage classification, binding and consensus-time replays.
  // v10 replays it again so every owner's deal and binding is rebuilt under its own key.
  const needsHistoryReplay = state.schemaVersion !== SCAN_STATE_SCHEMA_VERSION;
  // Overflow is recomputed per signer from the replayed bindings.
  if (needsHistoryReplay) state.bundleBindingOverflow = [];
  const configuredMax = Number(process.env.DACS_SCAN_MAX_TXS ?? 100000);
  const maxTxs = Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : 100000;
  const configuredOverlap = Number(process.env.DACS_SCAN_REPLAY_DEPTH ?? 2);
  const overlap = Number.isSafeInteger(configuredOverlap) && configuredOverlap >= 0 ? configuredOverlap : 2;
  const sinceTxId = needsHistoryReplay ? 0 : Math.max(0, state.lastSeenTxId - overlap);
  state.verifiedRevocations ??= Object.create(null);
  state.bundleBindings ??= Object.create(null);
  state.bundleBindingOverflow ??= [];
  for (const [jobId, raw] of Object.entries(state.bundleBindings)) {
    const verified = (await Promise.all(raw.map((binding) => verifyBundleBinding(binding)))).filter((binding) => binding !== null);
    omitted.omittedBindings += raw.length - verified.length;
    state.bundleBindings[jobId] = boundedBundleBindings(verified).bindings;
  }
  // Registrations are untrusted carriage (BB-3). Re-verify on every ingest so
  // hand-edited or legacy persisted JSON cannot bypass the BB-4 gate.
  for (const reg of regs) {
    const verified = reg.bundleBindings ?? [];
    for (const binding of verified) {
      const bounded = boundedBundleBindings([...ownArray(state.bundleBindings, binding.jobId), binding]);
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
  const runId = beginScanRun(sinceTxId);
  let scan: Awaited<ReturnType<typeof scanChain>> | undefined;
  try {
    scan = await scanChain(null, { maxTxs, sinceTxId, retryLocators: loadRetryableArtifacts(),
      knownPrograms: new Map(Object.entries(state.programs)) });
    if (!scan.complete) {
      throw new Error(
        scan.scanError ? `chain scan failed before reaching its cursor: ${scan.scanError}` :
        `chain scan hit DACS_SCAN_MAX_TXS=${maxTxs} before reaching its cursor; increase the limit so the catalog cannot skip history`,
      );
    }
    // Before v9, cached deals could carry stale attribution, so they are rebuilt; later
    // entries are kept and the replay adds or refreshes each owner's entry.
    if (needsHistoryReplay && (state.schemaVersion ?? 0) < 9) state.deals = Object.create(null);
    for (const [addr, owner] of scan.listings) state.listings[addr] = owner;
    for (const [key, deal] of scan.deals) {
      // Seller copies are matched within one scan window; keep the stored one when this window has none.
      const stored = Object.hasOwn(state.deals, key) ? state.deals[key] : undefined;
      if (!deal.sellerBundleRef && stored?.sellerBundleRef && stored.owners.seller === deal.owners.seller) {
        deal.sellerBundleRef = stored.sellerBundleRef;
      }
      state.deals[key] = deal;
    }
    state.programs ??= Object.create(null);
    for (const [key, address] of scan.programs) state.programs[key] = address;
    // A later duplicate invalidates prior automatic attribution too.
    for (const deal of Object.values(state.deals)) {
      const key = `0x${deal.owners.buyer.slice(-64)}\ndacs3:agreement:${deal.jobId}`;
      const bundleKey = `0x${deal.owners.buyer.slice(-64)}\ndacs5:bundle:${deal.jobId}`;
      if (state.programs[key] === null || state.programs[bundleKey] === null) {
        deal.owners.seller = "";
        delete (deal as { sellerFromAgreement?: string }).sellerFromAgreement;
      }
    }
    omitted.omittedBindings += scan.omittedBindings;
    // Every candidate is queued once, in arrival order, with the owner and content it was read with.
    const observed = new Map(scan.observations.map((observation) => [observation.locator, observation]));
    for (const [hash, addresses] of scan.revocations) {
      admitRevocationCandidates(hash, addresses.map((locator) =>
        ({ locator, owner: observed.get(locator)?.owner, contentHash: observed.get(locator)?.contentHash })));
    }
    for (const [jobId, bindings] of scan.bundleBindings) {
      const bounded = boundedBundleBindings([...ownArray(state.bundleBindings, jobId), ...bindings]);
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
    state.schemaVersion = SCAN_STATE_SCHEMA_VERSION;
    saveScanState(state);
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
      const key = discoveredDealKey(deal.owners.buyer, deal.jobId);
      if (!reg.deals.some((d) => discoveredDealKey(d.owners.buyer, d.jobId) === key)) reg.deals.push(deal);
      const bindings = ownArray(state.bundleBindings, deal.jobId);
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
            const accumulated = boundedBundleBindings([...ownArray(state.bundleBindings, binding.jobId), binding]);
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
      // Fail closed per seller: one that cannot be indexed is left out of this pass, never the whole catalog.
      const record = await indexRegistration(reg, before, opts.resolveIdentities, opts.resolveRecipe, (kind, count) => {
        if (kind === "bindings") omitted.omittedBindings += count;
        else omitted.omittedDeals += count;
      }).catch((error: unknown) => {
        throwIfInfrastructureError(error);
        omitted.omittedSellers++;
        const reason = error instanceof Error ? error.message.slice(0, 200) : "unknown error";
        log(`  seller indexing failed (${reg.primaryClaim.slice(0, 24)}…), omitted from this catalog: ${reason}`);
        return null;
      });
      if (!record) continue;
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
    }
    state.reachabilityCursor = await refreshReachabilityHints(catalogSellers, prior.sellers, {
      cursor: state.reachabilityCursor,
    });
    saveScanState(state);

    saveCatalog({ catalogVersion: "1", generatedAt, sellers: catalogSellers });
    finishScanRun(runId, { ...omitted, toTx: state.lastSeenTxId, chainTip: scan.chainTip, txs: scan.txsScanned,
      artifacts: scan.observations.length, rejected: scan.failures.length });

    log(`catalog written: ${catalogSellers.length} seller(s)`);
    return { sellers: catalogSellers.length, newTxs: scan.txsScanned, cursor: state.lastSeenTxId };
  } catch (error) {
    finishScanRun(runId, { ...omitted, toTx: state.lastSeenTxId, chainTip: scan?.chainTip,
      txs: scan?.txsScanned ?? 0, artifacts: scan?.observations.length ?? 0, rejected: scan?.failures.length ?? 0,
      error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
