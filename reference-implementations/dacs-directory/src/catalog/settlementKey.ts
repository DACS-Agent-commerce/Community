/**
 * DACS-4 §9.5.8 SB-1 settlement keys and the SB-2 cross-session uniqueness ledger.
 *
 * The key is the uniqueness defence, so it is byte-exact: lower-case hex hashes without `0x`,
 * decimal indices, and Solana signatures that decode to exactly 64 bytes. A reference that fails
 * canonicalisation, or whose kind SB-1 gives no key, is malformed and yields `null` (`error`); it
 * never mints a distinct key.
 */
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const index = (value: unknown): string | null =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : null;
const txHash = (value: unknown): string | null =>
  typeof value === "string" ? value.match(/^(?:0x)?([0-9a-fA-F]{64})$/)?.[1].toLowerCase() ?? null : null;
const CLUSTERS = new Set(["mainnet", "devnet", "testnet"]);
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Byte length of a base58 string, or null when it is not base58. */
function base58Bytes(value: string): number | null {
  if (!value) return null;
  let number = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const leadingZeros = value.length - value.replace(/^1+/, "").length;
  return leadingZeros + (number === 0n ? 0 : Math.ceil(number.toString(16).length / 2));
}

/** The SB-1 `settlement-tx-id` of one current ChainTxRef, or null (`error`). */
export function settlementTxId(ref: unknown): string | null {
  const value = record(ref);
  if (!value) return null;
  if (value.kind === "demos") {
    const hash = txHash(value.txHash);
    return hash ? `demos:${hash}` : null;
  }
  if (value.kind === "evm" || value.kind === "x402") {
    // The upstream evm and x402 ChainTxRef variants carry no logIndex, yet SB-1 requires one; a
    // reference without it is malformed under SB-1 and is never counted.
    const chainId = index(value.chainId);
    const hash = txHash(value.kind === "evm" ? value.txHash : value.settlementTxHash);
    const logIndex = index(value.logIndex);
    return chainId && hash && logIndex ? `evm:${chainId}:${hash}:${logIndex}` : null;
  }
  if (value.kind === "solana") {
    const instruction = index(value.instructionIndex);
    return typeof value.cluster === "string" && CLUSTERS.has(value.cluster) &&
      typeof value.signature === "string" && base58Bytes(value.signature) === 64 && instruction
      ? `solana:${value.cluster}:${value.signature}:${instruction}` : null;
  }
  return null;
}

/**
 * The pinned SDK's pre-SB-1 TxRef `{ rail, txHash, kind }` on a `pay-dem` phase is a native Demos
 * transfer, keyed like the current `demos` variant. No other legacy rail carries the event index
 * SB-1 needs, so its references are `error`.
 */
export function legacySettlementTxId(phase: unknown, ref: unknown): string | null {
  const value = record(ref);
  return phase === "pay-dem" && value?.rail === "demos" && value.kind === "payment"
    ? settlementTxId({ kind: "demos", txHash: value.txHash }) : null;
}

export interface SettlementClaim {
  id: string;
  jobId: string;
  phaseIndex: number;
  /** The consumer's session identity when a jobId is unique only per producer; another session's
   * binding of the same (jobId, phaseIndex) is a second binding. */
  session?: string;
}

export type Sb2Effect = "count" | "already-counted" | "reject";

/**
 * SB-2 for one claim against the consumer's ledger of consumed ids. The caller presents claims in
 * the winning order (earlier observedAt, then lower evidence hash), so the first binding of an id
 * stands and any binding under another (jobId, phaseIndex), or another session, is rejected.
 */
export function admitSettlement(ledger: Map<string, Omit<SettlementClaim, "id">>, claim: SettlementClaim): Sb2Effect {
  const prior = ledger.get(claim.id);
  if (!prior) {
    ledger.set(claim.id, { jobId: claim.jobId, phaseIndex: claim.phaseIndex, session: claim.session });
    return "count";
  }
  return prior.jobId === claim.jobId && prior.phaseIndex === claim.phaseIndex && prior.session === claim.session ? "already-counted" : "reject";
}
