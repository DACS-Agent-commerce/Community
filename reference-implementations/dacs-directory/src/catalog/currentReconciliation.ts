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

export function currentBundleCopiesDiverge(
  buyerBundle: Record<string, unknown>,
  sellerBundle: Record<string, unknown>,
): boolean {
  const buyerType = buyerBundle.faultBundleVersion === "1" ? "fault" : buyerBundle.bundleVersion === "1" ? "legacy" : "unknown";
  const sellerType = sellerBundle.faultBundleVersion === "1" ? "fault" : sellerBundle.bundleVersion === "1" ? "legacy" : "unknown";
  return buyerType !== sellerType ||
    (buyerType === "fault" && buyerBundle.faultedParty !== sellerBundle.faultedParty) ||
    flipOutcome(String(buyerBundle.outcome)) !== String(sellerBundle.outcome) ||
    phaseSummariesDiverge(buyerBundle.phaseSummary, sellerBundle.phaseSummary);
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
  const authoritative = sellerOk ? sellerGraph! : buyerGraph;
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
    selectedLocator,
  };
}
