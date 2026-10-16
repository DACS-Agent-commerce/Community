import type { DealRecord } from "./types.js";

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
  if (typeof ref.rail === "string") {
    const hash = ref.rail === "demos" ? collapsedHash(ref.txHash) : null;
    return hash && `demos:${hash}`;
  }
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
 * SB-1 identities claimed by a deal's success-outcome settlement evidence.
 * `projected` is false when any cited reference cannot be projected; such a
 * deal is not countable.
 */
export function settlementClaims(evidence: Array<Record<string, unknown>>): {
  settlementTxIds: NonNullable<DealRecord["settlementTxIds"]>;
  projected: boolean;
} {
  let projected = true;
  const settlementTxIds = evidence.filter((record) => record.outcome === "success").flatMap((record) => {
    const refs = Array.isArray(record.paymentTxRefs) ? record.paymentTxRefs : [];
    const observedAt = Number(record.observedAt);
    const phaseIndex = Number(record.phaseIndex ?? 0);
    return refs.flatMap((ref) => {
      const id = settlementTxId(ref);
      if (id === null) projected = false;
      return id === null ? [] : [{ id, observedAt, phaseIndex }];
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

/**
 * The records DACS-5 may count over one window, shared by seller reputation and
 * listing hints so the two never disagree.
 *
 * DACS-4 SB-2: the complete presented set of admissible records is grouped by
 * settlement id before the window is applied. One record repeating one
 * (jobId, phaseIndex) claim is idempotent. A group claimed by two or more
 * records or tuples is indeterminate without settlement-side binding
 * authority, which this Directory does not verify, so no member counts. The
 * producer-set observedAt, arrival and jobId order never pick a winner.
 */
export function countableDeals(deals: DealRecord[], windowStart: number, windowEnd: number): {
  deals: DealRecord[];
  useAnchorTimestamps: boolean;
} {
  const eligible = deals.filter((deal) =>
    deal.refsVerified && deal.reputationEligible &&
    CURRENT_OUTCOMES.has(deal.sellerOutcome ?? ""),
  );
  const claimants = new Map<string, Set<string>>();
  for (const deal of eligible) for (const tx of deal.settlementTxIds ?? []) {
    const key = settlementGroupKey(tx.id);
    const claimant = JSON.stringify([deal.owners?.buyer, deal.jobId, tx.phaseIndex, deal.bundleContentHash]);
    claimants.set(key, (claimants.get(key) ?? new Set()).add(claimant));
  }
  const unique = eligible.filter((deal) =>
    !(deal.settlementTxIds ?? []).some((tx) => claimants.get(settlementGroupKey(tx.id))!.size > 1));
  // A determinism receipt declares one timestamp basis for its entire input
  // set. Use SR-2 anchor time only when it is available for every eligible
  // record; otherwise fall back to finalisedAt uniformly and exclude records
  // that cannot be evaluated on that honest basis.
  const useAnchorTimestamps = eligible.length > 0 &&
    eligible.every((deal) => typeof deal.anchorTimestamp === "number");
  return {
    useAnchorTimestamps,
    deals: unique.filter((deal) => {
      const timestamp = useAnchorTimestamps ? deal.anchorTimestamp : deal.finalisedAt;
      return typeof timestamp === "number" && timestamp >= windowStart && timestamp <= windowEnd;
    }),
  };
}

/** A deal in the category or one of its dot-separated children. */
export const inCategory = (deal: DealRecord, category: string): boolean =>
  deal.category === category || Boolean(deal.category?.startsWith(`${category}.`));
