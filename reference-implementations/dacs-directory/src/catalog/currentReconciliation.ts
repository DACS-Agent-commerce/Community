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
  return flipOutcome(String(buyerBundle.outcome)) !== String(sellerBundle.outcome) ||
    phaseSummariesDiverge(buyerBundle.phaseSummary, sellerBundle.phaseSummary);
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
  const refsVerified = Boolean((sellerOk || buyerOk) && !divergent && authoritative.refsVerified);
  const sellerOutcome = authoritative === sellerGraph
    ? String(authoritative.bundle.outcome ?? "")
    : flipOutcome(String(authoritative.bundle.outcome ?? ""));
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
