import { flipOutcome } from "./reputation.js";
import type { EvidenceGraph } from "./evidenceGraph.js";
import type { RegisteredDeal } from "./types.js";

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];

/**
 * Compare only the contradiction-bearing DACS-5 phase facts. Advisory fields
 * are deliberately ignored, while the phase index set is part of the verdict.
 */
export function phaseSummariesDiverge(left: unknown, right: unknown): boolean {
  const indexed = (value: unknown) => {
    const phases = records(value);
    if (!Array.isArray(value) || phases.length !== value.length) return null;
    const byIndex = new Map<number, { kind: unknown; outcome: unknown; errorClass: unknown }>();
    for (const phase of phases) {
      const index = phase.index;
      if (!Number.isSafeInteger(index) || Number(index) < 0 || byIndex.has(Number(index))) return null;
      byIndex.set(Number(index), { kind: phase.kind, outcome: phase.outcome, errorClass: phase.errorClass });
    }
    return byIndex;
  };
  const a = indexed(left);
  const b = indexed(right);
  if (!a || !b || a.size !== b.size) return true;
  for (const [index, facts] of a) {
    const other = b.get(index);
    // DACS-5 §10.4.3 / §10.5.1: shared indices compare kind/outcome/errorClass.
    if (!other || facts.kind !== other.kind || facts.outcome !== other.outcome || facts.errorClass !== other.errorClass) return true;
  }
  return false;
}

/** Callers pass verified copies: a current FaultAttestationBundle, or an AttestationBundle (current or SDK profile). */
const bundleType = (bundle: Record<string, unknown>) => bundle.faultBundleVersion === "1" ? "fault" : "legacy";

/** DACS-5 §10.4.3 outcome class: completed, failed-substrate, abort, or failure. */
function outcomeClass(outcome: unknown): string {
  return outcome === "aborted-by-self" || outcome === "aborted-by-other" ? "abort"
    : outcome === "failed-perm" || outcome === "failed-counterparty" ? "failure" : String(outcome);
}

/**
 * The §10.4.1 permissible-set mapping of a legacy copy's role-relative outcome to the parties it
 * may fault: none for completed or failed-substrate, the anchoring role for its own fault, and
 * every other session role for a counterparty fault (a singleton in a two-party session).
 */
function impliedFaultSet(legacy: Record<string, unknown>): Set<string> {
  const anchored = String(legacy.anchoredByRole);
  const roles = records(legacy.parties).map((party) => String(party.role));
  const outcome = legacy.outcome;
  if (outcome === "completed" || outcome === "failed-substrate") return new Set(["none"]);
  if (outcome === "failed-perm" || outcome === "aborted-by-self") return new Set([anchored]);
  if (outcome === "failed-counterparty" || outcome === "aborted-by-other") return new Set(roles.filter((role) => role !== anchored));
  return new Set();
}

/**
 * DACS-5 §10.4.3 "canonically diverge", applied by version: a FaultAttestationBundle pair compares
 * the absolute faultedParty and outcome class; a legacy pair compares outcomes after the
 * perspective flip; a mixed pair checks the fault bundle's faultedParty against the legacy copy's
 * implied-fault set and the outcome classes. The shared-index phaseSummary limb applies to all.
 */
export function currentBundleCopiesDiverge(
  buyerBundle: Record<string, unknown>,
  sellerBundle: Record<string, unknown>,
): boolean {
  if (phaseSummariesDiverge(buyerBundle.phaseSummary, sellerBundle.phaseSummary)) return true;
  const buyerType = bundleType(buyerBundle);
  const sellerType = bundleType(sellerBundle);
  if (buyerType === "fault" && sellerType === "fault") {
    return buyerBundle.faultedParty !== sellerBundle.faultedParty ||
      outcomeClass(buyerBundle.outcome) !== outcomeClass(sellerBundle.outcome);
  }
  if (buyerType === "legacy" && sellerType === "legacy") {
    return flipOutcome(String(buyerBundle.outcome)) !== String(sellerBundle.outcome);
  }
  const [fault, legacy] = buyerType === "fault" ? [buyerBundle, sellerBundle] : [sellerBundle, buyerBundle];
  return !impliedFaultSet(legacy).has(String(fault.faultedParty)) ||
    outcomeClass(fault.outcome) !== outcomeClass(legacy.outcome);
}

function sellerRelativeOutcome(graph: EvidenceGraph, sellerClaim: string): string {
  const outcome = String(graph.bundle.outcome ?? "");
  if (graph.bundle.faultBundleVersion !== "1") {
    return graph.bundle.anchoredByRole === "seller" ? outcome : (flipOutcome(outcome) ?? "");
  }
  if (outcome === "completed" || outcome === "failed-substrate") return outcome;
  const sellerRole = roleOf(graph, sellerClaim);
  const sellerFaulted = graph.bundle.faultedParty === sellerRole;
  const abort = outcome === "aborted-by-self" || outcome === "aborted-by-other";
  return abort
    ? sellerFaulted ? "aborted-by-self" : "aborted-by-other"
    : sellerFaulted ? "failed-perm" : "failed-counterparty";
}

const roleOf = (graph: EvidenceGraph | null, claim: string) => {
  const parties = records(graph?.bundle.parties);
  return parties.find((party) => String(party.primaryClaim).toLowerCase() === claim.toLowerCase())?.role;
};

/** Pure two-copy selection used by the indexer and by byte-stable fixtures. */
export function reconcileCurrentCopies(
  deal: RegisteredDeal,
  sellerClaim: string,
  buyerGraph: EvidenceGraph,
  sellerGraph: EvidenceGraph | null,
) {
  const binds = (graph: EvidenceGraph | null, expectedRole: "buyer" | "seller") => Boolean(
    graph?.ok && graph.bundle.jobId === deal.jobId && graph.bundle.anchoredByRole === expectedRole &&
    roleOf(graph, deal.owners.buyer) === "buyer" && roleOf(graph, sellerClaim) === "seller",
  );
  const buyerOk = binds(buyerGraph, "buyer");
  const sellerOk = binds(sellerGraph, "seller");
  const divergent = Boolean(
    buyerOk && sellerOk && currentBundleCopiesDiverge(buyerGraph.bundle, sellerGraph!.bundle),
  );
  // The scored party's own copy is authoritative, except that in a non-divergent mixed-version pair
  // the FaultAttestationBundle copy is (§10.4.3(c), §10.5.1).
  const mixed = buyerOk && sellerOk && !divergent && bundleType(buyerGraph.bundle) !== bundleType(sellerGraph!.bundle);
  const authoritative = mixed
    ? bundleType(buyerGraph.bundle) === "fault" ? buyerGraph : sellerGraph!
    : sellerOk ? sellerGraph! : buyerGraph;
  const refsVerified = Boolean(sellerOk && buyerOk && !divergent && authoritative.refsVerified);
  const sellerOutcome = sellerRelativeOutcome(authoritative, sellerClaim);
  const selectedLocator = authoritative === sellerGraph ? deal.sellerBundleRef! : deal.buyerBundleRef;
  return {
    authoritative,
    buyerOk,
    sellerOk,
    divergent,
    refsVerified,
    sellerOutcome,
    orchestratorFaultNeutral: authoritative.bundle.faultBundleVersion === "1" && authoritative.bundle.faultedParty === "orchestrator",
    selectedLocator,
  };
}
