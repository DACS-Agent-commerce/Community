/**
 * Full reindex, callable: incremental chain scan to the tip, §6.3.5 domain
 * crawl, then re-verify every registration (submitted + discovered) against
 * chain state and rewrite the catalog cache. Used by the CLI (npm run index)
 * and by POST /api/dacs/reindex (the UI's refresh button).
 */
import { discoveredDealKey, normalizeScanState, ownArray, SCAN_STATE_SCHEMA_VERSION } from "./scanState.js";
import { MAX_REGISTRATION_BUNDLE_BINDINGS, parseRegistration } from "./registration.js";
import { ownerSignedRegistration } from "./registrationSig.js";
import { boundedJson } from "./artifactLimits.js";
import { canonicalDemosAgentClaim } from "./claimRef.js";
import { createHash } from "node:crypto";
import { indexRegistration, listingBindingRejection, type ResolveIdentities } from "./indexer";
import { readAnchorResult, type AnchorRead } from "./chain";
import { findValidListingRevocation, revocationSellerClaim, verifyStoredListing } from "./listingVerification";
import { catalogBundleBindings, verifyBundleBinding } from "./bundleBinding";
import {
  readChainTip,
  scanChain,
  scanConsensusAnchorBackfill,
} from "./scan";
import { chainResetRequired, chainResetThreshold } from "./chainContinuity";
import { scanStateCurrent, servedCatalogChain, servedChainUnchanged } from "./chainGate";
import type { catalogNodeDeployment } from "./listingFinality";
import { crawlDomains, normalizeSubmittedDomain, revocationBindingKey, wellKnownWithdrawalProvenance, type WellKnownAgent } from "./wellknown";
import { upsertCounterpartyEvidenceSeller } from "./counterpartyEvidence";
import { refreshReachabilityHints } from "./reachability";
import {
  loadCatalog,
  loadDomains,
  loadFixtureSeeds,
  loadRegistrations,
  loadScanState,
  admitRevocationCandidates,
  retainListingRevocation,
  retainedListingRevocation,
  recordWellKnownWithdrawalCheck,
  loadWithdrawalCursor,
  saveWithdrawalCursor,
  finishWithdrawalCarriageReplay,
  saveCatalog,
  saveScanState,
  beginScanRun,
  finishScanRun,
  loadRetryableArtifacts,
  clearChainDerivedArtifacts,
  openChainReadWindow,
  commitChainReadWindow,
  revertChainReadWindow,
  recordArtifact,
  pruneFailureHistory,
  pruneListingRejections,
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
  /** Node deployment read injected by tests; production reads the configured node. */
  nodeDeployment?: typeof catalogNodeDeployment;
  /** Alternate discovery transport for deterministic/offline deployments. */
  crawlWellKnown?: typeof crawlDomains;
}

export async function reindexAll(opts: ReindexOptions = {}): Promise<ReindexSummary> {
  const log = opts.log ?? console.log;
  const omitted = { omittedSellers: 0, omittedBindings: 0, omittedDeals: 0 };
  revertChainReadWindow();
  // A refusal is recorded as a failed run, so the public status shows the catalog is not advancing.
  function refuse(error: string): never {
    const { lastSeenTxId } = loadScanState();
    finishScanRun(beginScanRun(lastSeenTxId), { ...omitted, toTx: lastSeenTxId, txs: 0, artifacts: 0, rejected: 0, error });
    throw new Error(error);
  }
  const served = await servedCatalogChain(opts.nodeDeployment);
  if (!served.ok) return refuse(`catalog not updated: ${served.cause}`);
  if (served.warning) log(`node build warning: ${served.warning}`);
  // Node reads made after the gate are persisted only while the node still serves the gated chain.
  const chainChange = async (): Promise<string | null> => {
    const again = await servedChainUnchanged(served.chainIdentity, opts.nodeDeployment);
    return again.ok ? null : `the served chain changed during the pass: ${again.cause}`;
  };
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
    // Verified before crawl data is merged in, which changes what the owner signed.
    regs.push({ ...parsed.value, ownerSigned: await ownerSignedRegistration(parsed.value),
      ...(raw.listingContentHashes && typeof raw.listingContentHashes === "object" && !Array.isArray(raw.listingContentHashes)
        ? { listingContentHashes: raw.listingContentHashes } : {}),
    });
  }
  let prior = loadCatalog();

  // ── Passive discovery, incremental: walk latest → cursor, union into the
  //    accumulated scan state. Discoveries persist while the chain does; a
  //    changed chain identity or a confirmed large tip regression clears
  //    derived state before a genesis rescan. First run backfills the full history.
  let state = loadScanState();
  const resetThreshold = chainResetThreshold();
  let observedChainTip: number | null = null;
  try {
    observedChainTip = await readChainTip();
  } catch {
    // The normal scan below retains the established fail-closed behaviour and
    // surfaces the node error. This preflight exists only for reset detection.
  }
  // Only a recorded chain other than the served one proves the cached evidence is foreign. No
  // recorded chain (an upgrade or an unfinished reset) is not that proof: the
  // state replays from genesis below, like a schema bump, and keeps its withdrawal evidence. A
  // verified withdrawal is the seller's signature over that Listing, so keeping it fails closed (RB-3).
  const chainReplaced = state.chainIdentity !== undefined && state.chainIdentity !== served.chainIdentity;
  const tipRegressed = observedChainTip !== null && chainResetRequired(state, observedChainTip, resetThreshold);
  if (chainReplaced || tipRegressed) {
    const previousCursor = state.lastSeenTxId;
    // Every reset follows a read of the gated chain, so a node changing chain resets nothing.
    const changed = await chainChange();
    if (changed) return refuse(`catalog not updated: ${changed}`);
    // A replaced chain's catalog is no evidence for the rebuild and is emptied first; until the
    // reset state below is saved, the recorded identity keeps the reset due. A tip regression
    // keeps serving its catalog, and the rebuild falls back on it, until the rebuild replaces it.
    if (chainReplaced) {
      prior = { catalogVersion: "1", generatedAt: Date.now(), sellers: [] };
      saveCatalog(prior);
    }
    clearChainDerivedArtifacts();
    state = normalizeScanState({
      // No identity and no current schema: only a complete replay stamps them.
      schemaVersion: 0,
      lastSeenTxId: 0,
      ...(observedChainTip === null ? {} : { lastChainTip: observedChainTip }),
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
      `${chainReplaced ? "chain replacement detected: the node serves another chain than the recorded one"
        : `chain replacement detected: tip ${observedChainTip} is more than ${resetThreshold} txs behind`} cursor ${previousCursor}; ` +
        `cleared chain-derived cache and restarting from genesis`,
    );
  } else if (state.chainIdentity === undefined) {
    log("no chain is recorded for the cached state; replaying history from genesis");
  }
  // v9 replays history to recover duplicate programs discarded by older caches.
  // It retains earlier storage classification, binding and consensus-time replays.
  // v10 replays it again so every owner's deal and binding is rebuilt under its own key.
  // A reset state records no chain identity and replays, like a schema bump.
  const needsHistoryReplay = !scanStateCurrent(state, served.chainIdentity);
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
    state.bundleBindings[jobId] = catalogBundleBindings(verified).bindings;
  }
  // Registrations are untrusted carriage (BB-3). Re-verify on every ingest so
  // hand-edited or legacy persisted JSON cannot bypass the BB-4 gate.
  for (const reg of regs) {
    const verified = reg.bundleBindings ?? [];
    for (const binding of verified) {
      const bounded = catalogBundleBindings([...ownArray(state.bundleBindings, binding.jobId), binding]);
      state.bundleBindings[binding.jobId] = bounded.bindings;
      state.bundleBindingOverflow = [...new Set([
        ...state.bundleBindingOverflow,
        ...bounded.overflowKeys,
      ])].sort();
    }
  }
  for (const seller of prior.sellers) for (const listing of seller.listings) {
    const locator = listing.revocation?.markerAnchor.locator;
    if (!locator) continue;
    const verified = state.verifiedRevocations[listing.contentHash] ?? [];
    if (!verified.includes(locator)) verified.push(locator);
    state.verifiedRevocations[listing.contentHash] = verified;
  }
  const runId = beginScanRun(sinceTxId);
  let scan: Awaited<ReturnType<typeof scanChain>> | undefined;
  try {
    // Everything the pass saves from here on is made from node reads: the scan cursor, artifacts,
    // candidates, replay progress and what indexing records. It stays provisional until the final
    // chain check passes; a reset above is already final.
    openChainReadWindow();
    scan = await scanChain(null, { maxTxs, sinceTxId, retryLocators: loadRetryableArtifacts(),
      knownPrograms: new Map(Object.entries(state.programs)) });
    if (!scan.complete) {
      throw new Error(
        scan.scanError ? `chain scan failed before reaching its cursor: ${scan.scanError}` :
        `chain scan hit DACS_SCAN_MAX_TXS=${maxTxs} before reaching its cursor; increase the limit so the catalog cannot skip history`,
      );
    }
    const scanChainChange = await chainChange();
    if (scanChainChange) throw new Error(`catalog not updated: ${scanChainChange}`);
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
      // A deal without an attributed seller has no seller copy.
      if (!deal.owners.seller) delete deal.sellerBundleRef;
    }
    omitted.omittedBindings += scan.omittedBindings;
    // Every candidate is queued once, in arrival order, with the owner and stored value it was read
    // with. The value hash covers the signature envelope, which the content hash omits, so a marker
    // re-published with a corrected signature is examined again.
    const observed = new Map(scan.observations.map((observation) => [observation.locator, observation]));
    const storedValueHash = (data: Record<string, unknown> | undefined) => {
      const json = data ? boundedJson(data) : null;
      return json === null ? null : createHash("sha256").update(json, "utf8").digest("hex");
    };
    for (const [hash, addresses] of scan.revocations) {
      admitRevocationCandidates(hash, addresses.map((locator) =>
        ({ locator, owner: observed.get(locator)?.owner, contentHash: storedValueHash(observed.get(locator)?.data) })));
    }
    for (const [jobId, bindings] of scan.bundleBindings) {
      const bounded = catalogBundleBindings([...ownArray(state.bundleBindings, jobId), ...bindings]);
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
        const backfillChainChange = await chainChange();
        if (backfillChainChange) throw new Error(backfillChainChange);
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
    saveScanState(state);
    finishWithdrawalCarriageReplay();
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
    let crawlIncomplete = false;
    if (domains.length > 0) {
      const crawl = await (opts.crawlWellKnown ?? crawlDomains)(domains);
      crawlIncomplete = crawl.errors.length > 0;
      for (const e of crawl.errors) {
        let domain: string;
        try { domain = normalizeSubmittedDomain(e.domain); }
        catch { continue; /* An invalid legacy domain cannot identify an authenticated source. */ }
        recordWellKnownWithdrawalCheck(domain);
        log(`well-known: ${e.domain} — ${e.error}`);
      }
      for (const agent of crawl.agents) {
        await ingestWellKnownRevocations(agent);
        const reg = sellerReg(agent.seller) as Registration & { wellKnownDomains?: string[]; discovered?: boolean };
        // agent.json is unsigned: its name never replaces one the owner signed.
        if (agent.displayName && !reg.ownerSigned && reg.displayName.startsWith("agent ")) reg.displayName = agent.displayName;
        for (const anchor of agent.listingAnchors) {
          // A revoked or incomplete row can carry a marker, but cannot introduce an
          // active offer. Authenticated unresolved sources create holds; unsigned
          // carriage must first resolve a verified tombstone. Independent active
          // registrations, chain observations and complete mirrors remain usable.
          if (!reg.listingAnchors.includes(anchor)) {
            const retained = retainedListingRevocation(agent.contentHashes[anchor]);
            if (!agent.activeListingAnchors.includes(anchor) && !wellKnownWithdrawalProvenance(agent) &&
                canonicalDemosAgentClaim(retained?.sellerPrimaryClaim ?? "") !== agent.seller) continue;
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
          const carried = catalogBundleBindings([...reg.bundleBindings, ...agent.bundleBindings]);
          reg.bundleBindings = carried.bindings;
          for (const binding of carried.bindings) {
            const accumulated = catalogBundleBindings([...ownArray(state.bundleBindings, binding.jobId), binding]);
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
      const locator = listing.revocation?.markerAnchor.locator;
      if (!locator) continue;
      const verified = state.verifiedRevocations[listing.contentHash] ?? [];
      if (!verified.includes(locator)) verified.push(locator);
      state.verifiedRevocations[listing.contentHash] = verified;
    }
    state.reachabilityCursor = await refreshReachabilityHints(catalogSellers, prior.sellers, {
      cursor: state.reachabilityCursor,
    });
    const indexChainChange = await chainChange();
    if (indexChainChange) throw new Error(`catalog not updated: ${indexChainChange}`);
    // The scan state, the catalog and every write above are kept together or not at all.
    commitChainReadWindow(() => {
      if (needsHistoryReplay) {
        // Stamped in the transaction that saves the rebuilt catalog, so an interrupted replay
        // stays due and index-now refuses until the catalog matches this chain.
        state.schemaVersion = SCAN_STATE_SCHEMA_VERSION;
        state.chainIdentity = served.chainIdentity;
      }
      saveScanState(state);
      // A failed crawl hides the pointers only it discovers; absence from an incomplete pass is not removal.
      if (!crawlIncomplete) pruneListingRejections(allRegs);
      saveCatalog({ catalogVersion: "1", generatedAt, sellers: catalogSellers });
    });
    finishScanRun(runId, { ...omitted, toTx: state.lastSeenTxId, chainTip: scan.chainTip, txs: scan.txsScanned,
      artifacts: scan.observations.length, rejected: scan.failures.length });

    log(`catalog written: ${catalogSellers.length} seller(s)`);
    return { sellers: catalogSellers.length, newTxs: scan.txsScanned, cursor: state.lastSeenTxId };
  } catch (error) {
    revertChainReadWindow();
    finishScanRun(runId, { ...omitted, toTx: state.lastSeenTxId, chainTip: scan?.chainTip,
      txs: scan?.txsScanned ?? 0, artifacts: scan?.observations.length ?? 0, rejected: scan?.failures.length ?? 0,
      error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Total node reads spent resolving one domain's withdrawal carriage per pass. */
export const WELL_KNOWN_WITHDRAWAL_READS_PER_PASS = 32;

/** Authenticate the listing publisher before letting discovery carriage affect RB-4. */
export async function ingestWellKnownRevocations(agent: WellKnownAgent): Promise<void> {
  const domain = normalizeSubmittedDomain(agent.domain);
  const provenance = wellKnownWithdrawalProvenance(agent);
  if (provenance) {
    // Binding resolution has not happened yet. Keep it seller-scoped until a
    // verified listing read (here or in indexRegistration) establishes ownership.
    if (!recordWellKnownWithdrawalCheck(domain, agent.seller, agent.withdrawalHashes,
      agent.incompleteWithdrawalHashes ?? [],
      agent.withdrawalIndex, agent.revocations, provenance, agent.contentHashes)) return;
  } else recordWellKnownWithdrawalCheck(domain);

  const byHash = new Map<string, typeof agent.revocations>();
  for (const binding of new Map(agent.revocations.map((binding) => [revocationBindingKey(binding), binding])).values()) {
    const group = byHash.get(binding.listingContentHash) ?? [];
    group.push(binding);
    byHash.set(binding.listingContentHash, group);
  }
  const jobs = [...new Set(agent.listingAnchors)].flatMap((anchor) => {
    const bindings = byHash.get(agent.contentHashes[anchor]) ?? [];
    return bindings.map((binding) => ({ anchor, binding }));
  });
  if (!jobs.length) return;
  const indexHash = agent.withdrawalIndex?.hash ?? "";
  let cursor = loadWithdrawalCursor(domain, agent.seller, indexHash) % jobs.length;
  let reads = 0;
  const exhausted = Symbol("withdrawal read budget exhausted");
  const cache = new Map<string, AnchorRead>();
  const read = async (locator: string): Promise<AnchorRead> => {
    const cached = cache.get(locator);
    if (cached) return cached;
    if (reads >= WELL_KNOWN_WITHDRAWAL_READS_PER_PASS) throw exhausted;
    reads++;
    let result = await readAnchorResult(locator);
    // One transient read may recover within the pass. Missing unsigned markers
    // cannot authenticate an alleged publisher and never create pending work.
    if (result.status === "unavailable" && reads < WELL_KNOWN_WITHDRAWAL_READS_PER_PASS) {
      reads++;
      result = await readAnchorResult(locator);
    }
    cache.set(locator, result);
    return result;
  };
  const listings = new Map<string, Awaited<ReturnType<typeof verifyStoredListing>>>();
  const markers = new Map<string, Awaited<ReturnType<typeof findValidListingRevocation>>>();
  let examined = 0;
  try {
    for (; examined < jobs.length; examined++, cursor = (cursor + 1) % jobs.length) {
      const { anchor, binding } = jobs[cursor];
      const anchored = await read(anchor);
      if (anchored.status !== "present") continue;
      if (!listings.has(anchor)) listings.set(anchor, await verifyStoredListing(anchored.record.data, anchor).catch(() => null));
      const listing = listings.get(anchor);
      if (!listing || listingBindingRejection(listing.sellerClaim, anchored.record.owner, agent.seller) ||
          listing.contentHash !== agent.contentHashes[anchor]) continue;
      const id = listing.scope.listingId ?? listing.scope.serviceId;
      const version = listing.scope.listingVersion ?? listing.scope.version ?? 1;
      if (binding.sellerPrimaryClaim !== revocationSellerClaim(listing) || binding.listingContentHash !== listing.contentHash ||
          binding.listingId !== id || binding.listingVersion !== version) continue;
      if (provenance) {
        admitRevocationCandidates(listing.contentHash, [{ locator: binding.markerAnchor.locator }]);
      } else {
        // publicEndpoint is a self-claim, never authority over unresolved hints.
        // Standard unsigned indexes can still carry independently verified markers.
        const key = JSON.stringify([listing.contentHash, binding.markerAnchor.locator]);
        if (!markers.has(key)) markers.set(key,
          await findValidListingRevocation([binding.markerAnchor.locator], listing, Number(version),
            async (locator) => { const result = await read(locator); return result.status === "present" ? result.record.data : null; }));
        const found = markers.get(key);
        if (found && found.markerContentHash === binding.markerContentHash && found.logicalAddress === binding.logicalAddress) {
          const marker = cache.get(binding.markerAnchor.locator);
          if (marker?.status === "present") retainListingRevocation(found, marker.record.data);
          admitRevocationCandidates(listing.contentHash, [{ locator: binding.markerAnchor.locator }]);
        }
      }
    }
  } catch (error) {
    if (error !== exhausted) throw error;
  } finally {
    saveWithdrawalCursor(domain, agent.seller, indexHash, cursor);
  }
}
