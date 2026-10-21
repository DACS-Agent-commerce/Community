import { canonicalDemosAgentClaim } from "./claimRef.js";
import { VerificationUnavailable, type UndecidedKind } from "./verificationUnavailable.js";

type Obj = Record<string, unknown>;
/** The node's answer that it holds no such record, having checked the chain through checkedThroughBlock. */
export interface SettlementNotFound { notFound: true; checkedThroughBlock: number }
/** Resolves the node's response or its SettlementNotFound answer. Throw (VerificationUnavailable in
 * production) when the node gives no answer; any other value is a reply about the requested record. */
export type SettlementNodeRead = (message: "getTxByHash" | "getBlockByNumber", data: Obj) => Promise<unknown>;
const isNotFound = (v: unknown): v is SettlementNotFound =>
  Boolean(v && typeof v === "object" && (v as Obj).notFound === true && Number.isSafeInteger((v as Obj).checkedThroughBlock));
const rec = (v: unknown): Obj | null => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;
const hash = (v: unknown) => typeof v === "string" && /^(?:0x)?[a-fA-F0-9]{64}$/.test(v) ? v.replace(/^0x/, "").toLowerCase() : null;
const address = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const claim = canonicalDemosAgentClaim(v);
  return claim ? `0x${claim.slice(-64)}` : /^0x[a-fA-F0-9]{64}$/.test(v) ? v.toLowerCase() : null;
};
/** DEM decimal to OS, using integer arithmetic (DACS-4 §9.5.9). */
export function demOs(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(v)) return null;
  const [whole, fraction = ""] = v.split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
}
// getTxByHash reconstructs persisted OS as a safe number or an exact string.
// The nested send payload is not reconstructed: only its canonical OS string is
// supported. Numeric legacy DEM payloads need historical fork semantics and stay
// indeterminate; do not infer their unit from the size of the amount.
const payloadOs = (v: unknown): bigint | null => typeof v === "string" && /^(?:0|[1-9]\d*)$/.test(v) ? BigInt(v) : null;
const storedOs = (v: unknown): bigint | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
  ? BigInt(v) : payloadOs(v);

export type NativePaymentVerdict = { verdict: "pass" } | { verdict: "fail"; reason: string } |
  { verdict: "indeterminate"; reason: string; kind: UndecidedKind };

/** The payer, payee and OS amount one pay-dem phase of an agreement settles (DACS-4 §9.5.9 steps 2-3, PB-2). */
function agreedNativeTransfer(agreement: Obj, phaseIndex: number) {
  const terms = rec(agreement.terms);
  const price = rec(terms?.price);
  const parties = Array.isArray(agreement.parties) ? agreement.parties.map(rec) : [];
  const bindings = Array.isArray(terms?.payoutBindings) ? terms.payoutBindings.map(rec) : [];
  const binding = bindings.find((b) => b?.phaseIndex === phaseIndex && b.railId === rec(terms?.rail)?.railId);
  return {
    currency: price?.currency,
    amount: demOs(price?.amount),
    payer: address(parties.find((p) => p?.role === "buyer")?.primaryClaim),
    payee: address(agreement.payeeBoundAgreementVersion === "1" ? binding?.payeeAddress : parties.find((p) => p?.role === "seller")?.primaryClaim),
    seller: address(parties.find((p) => p?.role === "seller")?.primaryClaim),
  };
}

/**
 * Whether one pay-dem phase of an agreement names a transfer this adapter can settle: the payee is the
 * agreement seller (PB-2 tier 1), and the payer, the payee and a positive DEM price in whole OS are known.
 * These are terms fixed at commitment, so every committed session is held to them, whatever its outcome;
 * checking them only beside a successful payment would refute completions while that agreement's failures count.
 */
export function nativeAgreementAdmission(agreement: Obj, phaseIndex: number): string | null {
  const { currency, amount, payer, payee, seller } = agreedNativeTransfer(agreement, phaseIndex);
  if (!seller || payee !== seller) return "the payee is not the agreement seller";
  if (!payer || !payee || currency !== "DEM" || amount === null || amount <= 0n) return "the agreement names no DEM price, payer and payee";
  return null;
}

/**
 * Public node reads establish terminal inclusion and the actual native-send payload. Only the node's answer
 * about this transaction refutes it (`fail`), and so does a cited block after the block in which the citing
 * bundle was consensus-anchored (`bundleAnchoredAt`, ms): inclusion cannot follow the bundle that asserts it.
 * Otherwise the payment is undecided (`indeterminate`), never refuted, and the reason keeps the cause. Its kind
 * says whether a later pass may decide it: no answer, a node behind the bundle's anchor, or a reply about
 * another transaction or block is `no-answer`; a send payload or applied list this profile cannot read as a
 * settlement is the transaction's `lasting` state, which no later pass changes.
 */
export async function nativePaymentVerdict(ref: Obj, agreement: Obj, phaseIndex: number, read?: SettlementNodeRead,
  bundleAnchoredAt?: number): Promise<NativePaymentVerdict> {
  const fail = (reason: string): NativePaymentVerdict => ({ verdict: "fail", reason });
  const undecided = (reason: string, kind: UndecidedKind = "no-answer"): NativePaymentVerdict => ({ verdict: "indeterminate", reason, kind });
  const txHash = hash(ref.txHash);
  if (!txHash || !Number.isSafeInteger(ref.blockNumber) || Number(ref.blockNumber) < 1) return fail("the payment reference names no transaction and block");
  const refused = nativeAgreementAdmission(agreement, phaseIndex);
  if (refused) return fail(refused);
  const { amount, payer, payee } = agreedNativeTransfer(agreement, phaseIndex);
  if (!read) return undecided("no node reader is installed", "lasting");
  try {
    const answer = await read("getTxByHash", { hash: txHash });
    if (isNotFound(answer)) {
      const checked = answer.checkedThroughBlock;
      if (checked >= Number(ref.blockNumber)) return fail(`the node has no such transaction through block ${checked}`);
      // The cited block is beyond what the node checked. If the last block it checked is already later than the
      // citing bundle's consensus anchor (block timestamps rise with height), so is the cited one, and the bundle
      // asserts a transfer that did not exist when it was anchored. Otherwise the node is behind: no answer.
      const checkedBlock = Number.isSafeInteger(bundleAnchoredAt) && checked >= 1 ? rec(await read("getBlockByNumber", { blockNumber: checked })) : null;
      const checkedAt = Number(rec(checkedBlock?.content)?.timestamp);
      if (checkedBlock?.number === checked && checkedBlock.status === "confirmed" && Number.isSafeInteger(checkedAt) &&
          checkedAt * 1_000 > Number(bundleAnchoredAt)) {
        return fail(`the cited block ${ref.blockNumber} follows block ${checked}, which is later than the bundle's consensus anchor`);
      }
      return undecided(`the node has checked only through block ${checked}`);
    }
    const tx = rec(answer);
    if (!tx || hash(tx.hash) !== txHash) return undecided("the node's reply is not about this transaction");
    if (tx.status !== "confirmed") return tx.status === "failed" ? fail("the node reports the transaction failed") : undecided("the transaction is not terminal");
    const content = rec(tx.content);
    const data = content?.data;
    const payload = Array.isArray(data) && data[0] === "native" ? rec(data[1]) : null;
    const args = payload?.args;
    if (Array.isArray(args) && typeof args[1] === "number") return undecided("a numeric legacy DEM send payload needs historical fork semantics", "lasting");
    // The node credits and debits the exact address string it stores (ac8f45f handleNativeOperations,
    // GCRBalanceRoutines findOneBy({ pubkey })), and its TO check accepts hex in any case. Another spelling
    // of the payee's key is another account, so only the canonical payer and payee strings match.
    if (tx.blockNumber !== ref.blockNumber || content?.type !== "native" ||
        content.from !== payer || content.to !== payee ||
        payload?.nativeOperation !== "send" || !Array.isArray(args) || args.length !== 2 ||
        args[0] !== payee || payloadOs(args[1]) !== amount || storedOs(content.amount) !== amount) {
      return fail("the transaction is not the agreed native send in the cited block");
    }
    const blockAnswer = await read("getBlockByNumber", { blockNumber: ref.blockNumber });
    const block = isNotFound(blockAnswer) ? null : rec(blockAnswer);
    if (!block || block.number !== ref.blockNumber) return undecided("the node's reply is not about the cited block");
    // The pinned source (ac8f45f) has no block attrs. A newer deployment (node2) lists the transactions whose
    // GCR edits the block applied; where it states that list, a transfer it does not name, or a list it
    // cannot read, does not establish settlement.
    const attrs = block.attrs === undefined ? {} : rec(block.attrs);
    const applied = attrs?.gcrAppliedTxs;
    if (!attrs || (applied !== undefined && !Array.isArray(applied))) return undecided("the node's block reply states no readable applied-transaction list");
    // A stated list that leaves the transfer out is the block's own record, which no later read changes.
    if (Array.isArray(applied) && !applied.some((h) => hash(h) === txHash)) {
      return undecided("the block's applied-transaction list does not name the transfer", "lasting");
    }
    const transactions = rec(block.content)?.ordered_transactions;
    if (!Array.isArray(transactions)) return undecided("the node's block reply lists no transactions");
    return transactions.some((h) => hash(h) === txHash) ? { verdict: "pass" } : fail("the cited block does not include the transaction");
  } catch (error) {
    // The production reader classifies its own failures. Anything else has no known cause, so it holds nothing.
    if (error instanceof VerificationUnavailable) return undecided(error.message, error.kind);
    return undecided(error instanceof Error && error.message ? error.message : "the node read failed", "lasting");
  }
}

export async function verifyNativePayment(ref: Obj, agreement: Obj, phaseIndex: number, read?: SettlementNodeRead): Promise<"pass" | "fail" | "indeterminate"> {
  return (await nativePaymentVerdict(ref, agreement, phaseIndex, read)).verdict;
}
