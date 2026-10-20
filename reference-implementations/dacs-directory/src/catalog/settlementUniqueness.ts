import type { DealRecord } from "./types.js";
import { demosSigningIdentity } from "./bundleSignerPolicy.js";
import { paymentEvidenceAddress } from "@kynesyslabs/dacs/canonical";
import { isChainTxRef, isSettlementEvidence } from "@kynesyslabs/dacs/artifacts";

/** Bump whenever persisted settlement eligibility/identity rules change. */
export const SETTLEMENT_PROJECTION_VERSION = 3;

const CURRENT_OUTCOMES = new Set([
  "completed", "failed-perm", "failed-counterparty", "failed-substrate",
  "aborted-by-self", "aborted-by-other",
]);

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const isSafeUint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const isPositiveSafeInt = (value: unknown): value is number => isSafeUint(value) && value > 0;
const CANONICAL_HASH = /^[0-9a-f]{64}$/;

/** A legacy spelling with `0x` or upper case collapses to SB-1 lower-case hex. */
function collapsedHash(value: unknown): string | null {
  return typeof value === "string" ? /^(?:0x)?([0-9a-f]{64})$/i.exec(value)?.[1].toLowerCase() ?? null : null;
}

/** Canonical Base58 that decodes to exactly 64 bytes (pinned SDK `isCanonicalSolanaSignature`). */
function isSolanaSignature(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 88) return false;
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let bytes = 0;
  for (let cursor = decoded; cursor > 0n; cursor >>= 8n) bytes += 1;
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1") leadingZeros += 1;
  return leadingZeros + bytes === 64;
}

/**
 * DACS-4 SB-1 `settlement-tx-id` of one signed payment TxRef, or null when this
 * Directory cannot project it: a malformed ref, a current arm with a
 * non-canonical coordinate, or an arm whose identity needs authenticated
 * ledger data the Directory does not resolve (legacy `evm`/`solana`/`x402`,
 * a legacy non-Demos rail, and every other arm). SB-1 makes such a reference
 * `error` or `indeterminate`, and SB-2 does not count it.
 */
export function settlementTxId(ref: unknown): string | null {
  if (!isRecord(ref)) return null;
  // Frozen legacy MVP TxRef `{ rail, txHash, kind }`: a native Demos transfer is one settlement.
  // The id is kept as deal history only. `settlementClaims` never counts it:
  // the pinned SDK's `isSettlementEvidence` refuses this shape, and `pay-dem`
  // accepts only the current `demos` arm.
  if (typeof ref.rail === "string") {
    const hash = ref.kind === "settlement" && ref.rail === "demos" &&
      Object.keys(ref).every((key) => ["kind", "rail", "txHash"].includes(key))
      ? collapsedHash(ref.txHash) : null;
    return hash && `demos:${hash}`;
  }
  if (!isChainTxRef(ref)) return null;
  switch (ref.kind) {
    case "demos": {
      const hash = collapsedHash(ref.txHash);
      return hash && `demos:${hash}`;
    }
    case "evm-event":
      return isPositiveSafeInt(ref.chainId) && typeof ref.txHash === "string" && CANONICAL_HASH.test(ref.txHash) &&
        isSafeUint(ref.logIndex) ? `evm:${ref.chainId}:${ref.txHash}:${ref.logIndex}` : null;
    case "x402-event":
      return isPositiveSafeInt(ref.chainId) && typeof ref.settlementTxHash === "string" &&
        CANONICAL_HASH.test(ref.settlementTxHash) && isSafeUint(ref.logIndex)
        ? `evm:${ref.chainId}:${ref.settlementTxHash}:${ref.logIndex}` : null;
    case "solana-instruction":
      return (ref.cluster === "mainnet" || ref.cluster === "devnet" || ref.cluster === "testnet") &&
        isSolanaSignature(ref.signature) && isSafeUint(ref.instructionIndex)
        ? `solana:${ref.cluster}:${ref.signature}:${ref.instructionIndex}` : null;
    default:
      return null;
  }
}

/**
 * Pinned registry identity to handler mapping.
 */
// DACS-4 §9.4.2 at Standard d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20.
// Unknown/custom registry entries need authenticated resolution before use.
const PINNED_RAIL_HANDLERS: Readonly<Record<string, string>> = {
  "demos-native:DEM": "pay-dem",
  "evm-erc20:1:USDC": "pay-evm-erc20",
  "evm-erc20:8453:USDC": "pay-evm-erc20",
  "evm-erc20:42161:USDC": "pay-evm-erc20",
  "evm-erc20:137:USDC": "pay-evm-erc20",
  "solana-spl:mainnet:USDC": "pay-solana-spl",
  "solana-spl:mainnet:USDT": "pay-solana-spl",
  "x402:default": "pay-x402",
};
const JOB_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * Project only SDK-valid success evidence whose anchor's storage metadata
 * carries a matching PC-2 tuple. The storage program's name and owner are not
 * yet checked against that address and the evidence signer (docs/TP-1.md).
 */
export function settlementClaims(evidence: Array<{ raw: Record<string, unknown>; logicalAddress?: unknown }>, context: {
  jobId: unknown;
  railId: string | null;
  railRegistryVersion: unknown;
  phaseSummary: unknown;
  pipeline: unknown;
}): {
  settlementTxIds: NonNullable<DealRecord["settlementTxIds"]>;
  projected: boolean;
} {
  let projected = true;
  const handler = context.railRegistryVersion === 1 && context.railId !== null &&
    Object.hasOwn(PINNED_RAIL_HANDLERS, context.railId) ? PINNED_RAIL_HANDLERS[context.railId] : null;
  // A pinned EVM or Solana rail id names its network (`evm-erc20:{chainId}:…`,
  // `solana-spl:{cluster}:…`); a TxRef on another network is not its payment.
  const railNetwork = handler ? context.railId?.split(":")[1] : undefined;
  const settlementTxIds = evidence.filter(({ raw }) => raw.outcome === "success").flatMap(({ raw: record, logicalAddress }) => {
    // Delivery evidence cannot replace payment evidence in a settlement phase.
    if (typeof record.phase === "string" && record.phase.startsWith("deliver-")) {
      if (!isSettlementEvidence(record) || !Array.isArray(context.phaseSummary) ||
          !context.phaseSummary.some((phase) => isRecord(phase) && isSafeUint(phase.index) &&
            (phase.kind === "deliver" || phase.kind === record.phase) &&
            Array.isArray(context.pipeline) && isRecord(context.pipeline[phase.index]) &&
            context.pipeline[phase.index].kind === record.phase)) projected = false;
      return [];
    }
    // The metadata-of-record belongs to the same native anchor whose signed
    // bytes the evidence graph verified. A ref annotation cannot supply it.
    const address = typeof logicalAddress === "string"
      ? /^dacs4:payment:([^:]+):([^:]+):(0|[1-9][0-9]*)(:resolved)?$/.exec(logicalAddress) : null;
    const phaseIndex = address ? Number(address[3]) : NaN;
    const phase = Array.isArray(context.phaseSummary) ? context.phaseSummary.find((entry) =>
      isRecord(entry) && entry.index === phaseIndex) : undefined;
    const pipelinePhase = Array.isArray(context.pipeline) ? context.pipeline[phaseIndex] : undefined;
    // ST-8 resolutions use HTLC/tank rails, outside this pinned projection.
    let addressMatches = false;
    if (address && isSafeUint(phaseIndex) && typeof record.jobId === "string" && JOB_ID.test(record.jobId) &&
        record.jobId === context.jobId && address[1] === record.jobId && context.railId !== null) {
      try {
        addressMatches = logicalAddress === paymentEvidenceAddress(record.jobId, context.railId, phaseIndex, Boolean(address[4])) &&
          !address[4];
      } catch { /* A malformed tuple never supplies a claim. */ }
    }
    if (!isSettlementEvidence(record) || !addressMatches || !handler || record.phase !== handler ||
        !isRecord(phase) || (phase.kind !== "settle" && phase.kind !== handler) || phase.outcome !== "ok" ||
        !isRecord(pipelinePhase) || pipelinePhase.kind !== handler ||
        !isRecord(pipelinePhase.parameters) || pipelinePhase.parameters.rail !== context.railId) {
      projected = false;
      return [];
    }
    const refs = record.paymentTxRefs as unknown[];
    return refs.flatMap((ref) => {
      const id = settlementTxId(ref);
      const railMatches = !isRecord(ref) ? false
        : handler === "pay-dem" ? ref.kind === "demos"
          : handler === "pay-evm-erc20" ? ref.kind === "evm-event" && ref.chainId === Number(railNetwork)
            : handler === "pay-solana-spl" ? ref.kind === "solana-instruction" && ref.cluster === railNetwork
              : handler === "pay-x402" && ref.kind === "x402-event";
      if (id === null || !railMatches) projected = false;
      return id === null ? [] : [{ id, observedAt: Number(record.observedAt), phaseIndex }];
    });
  });
  return { settlementTxIds, projected };
}

/**
 * Collision grouping key. SB-1 renders hashes as lower-case hex without `0x`,
 * so spelling variants of one hash group together; grouping more never lets a
 * collision go uncounted.
 */
function settlementGroupKey(id: string): string {
  return id.trim().replace(/(?:0x)?([0-9a-f]{64})/gi, (_match, hash: string) => hash.toLowerCase());
}

const isAdmissibleDeal = (deal: DealRecord): boolean =>
  deal.refsVerified && Boolean(deal.reputationEligible) && CURRENT_OUTCOMES.has(deal.sellerOutcome ?? "");

/**
 * One commercial session. A jobId is unique only per producer, so the parties'
 * signing identities are part of the key (as in `dedupeVerifiedDeals`).
 */
const sessionKey = (deal: DealRecord): string => JSON.stringify([
  demosSigningIdentity(String(deal.owners?.buyer)), demosSigningIdentity(String(deal.owners?.seller)), deal.jobId,
]);

/** What the complete presented set removes from every count. */
export interface SettlementExclusions {
  /** SB-2 groups claimed under two or more distinct (session, phaseIndex) tuples. */
  settlementIds: ReadonlySet<string>;
  /** Sessions presented as more than one distinct bundle. */
  sessions: ReadonlySet<string>;
}

/** Build the complete catalog exclusion set once, before any seller/window scope. */
export function settlementCollisions(presentedDeals: DealRecord[]): SettlementExclusions {
  const tuples = new Map<string, Set<string>>();
  const bundles = new Map<string, Set<string>>();
  presentedDeals.filter(isAdmissibleDeal).forEach((deal, index) => {
    const session = sessionKey(deal);
    // A record without a content hash is never provably identical to another.
    bundles.set(session, (bundles.get(session) ?? new Set()).add(deal.bundleContentHash ?? `unhashed:${index}`));
    for (const tx of deal.settlementTxIds ?? []) {
      const key = settlementGroupKey(tx.id);
      tuples.set(key, (tuples.get(key) ?? new Set()).add(JSON.stringify([session, tx.phaseIndex])));
    }
  });
  const conflicting = (groups: Map<string, Set<string>>) =>
    new Set([...groups].filter(([, members]) => members.size > 1).map(([key]) => key));
  return { settlementIds: conflicting(tuples), sessions: conflicting(bundles) };
}

/**
 * The records DACS-5 may count over one window, shared by seller reputation and
 * listing hints so the two never disagree.
 *
 * DACS-4 SB-2: the complete presented set of admissible records is grouped by
 * settlement id before the window is applied. Repeated presentation of one
 * session's identical bundle is idempotent and counts once. A group claimed
 * under two or more distinct (jobId, phaseIndex) tuples is indeterminate
 * without settlement-side binding authority, which this Directory does not
 * verify, so no member counts. A session presented as two different bundles
 * is excluded from every count, as DACS-5 §10.4.3(d) excludes a divergent
 * jobId. The producer-set observedAt, arrival and jobId order never pick a
 * winner.
 */
export function countableDeals(
  deals: DealRecord[], windowStart: number, windowEnd: number,
  excluded: SettlementExclusions = settlementCollisions(deals),
): {
  deals: DealRecord[];
  useAnchorTimestamps: boolean;
} {
  const eligible = deals.filter(isAdmissibleDeal);
  const admitted = eligible.filter((deal) => !excluded.sessions.has(sessionKey(deal)) &&
    !(deal.settlementTxIds ?? []).some((tx) => excluded.settlementIds.has(settlementGroupKey(tx.id))));
  // A determinism receipt declares one timestamp basis for its entire input
  // set. Use SR-2 anchor time only when it is available for every eligible
  // record; otherwise fall back to finalisedAt uniformly and exclude records
  // that cannot be evaluated on that honest basis.
  const useAnchorTimestamps = eligible.length > 0 &&
    eligible.every((deal) => typeof deal.anchorTimestamp === "number");
  const sessions = new Set<string>();
  return {
    useAnchorTimestamps,
    deals: admitted.filter((deal) => {
      const timestamp = useAnchorTimestamps ? deal.anchorTimestamp : deal.finalisedAt;
      return typeof timestamp === "number" && timestamp >= windowStart && timestamp <= windowEnd;
    }).filter((deal) => {
      // The window is applied first, so which identical copy counts never
      // depends on presentation order.
      const session = sessionKey(deal);
      if (sessions.has(session)) return false;
      sessions.add(session);
      return true;
    }),
  };
}

/** A deal in the category or one of its dot-separated children. */
export const inCategory = (deal: DealRecord, category: string): boolean =>
  deal.category === category || Boolean(deal.category?.startsWith(`${category}.`));
