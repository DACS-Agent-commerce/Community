import { canonicalDemosAgentClaim } from "./claimRef.js";

type Obj = Record<string, unknown>;
export type SettlementNodeRead = (message: "getTxByHash" | "getBlockByNumber", data: Obj) => Promise<unknown>;
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

/** Public node reads establish terminal inclusion and the actual native-send payload. */
export async function verifyNativePayment(ref: Obj, agreement: Obj, phaseIndex: number, read?: SettlementNodeRead): Promise<"pass" | "fail" | "indeterminate"> {
  const txHash = hash(ref.txHash);
  if (!txHash || !Number.isSafeInteger(ref.blockNumber) || Number(ref.blockNumber) < 1) return "fail";
  const terms = rec(agreement.terms);
  const price = rec(terms?.price);
  const amount = demOs(price?.amount);
  const parties = Array.isArray(agreement.parties) ? agreement.parties.map(rec) : [];
  const payer = address(parties.find((p) => p?.role === "buyer")?.primaryClaim);
  const bindings = Array.isArray(terms?.payoutBindings) ? terms.payoutBindings.map(rec) : [];
  const binding = bindings.find((b) => b?.phaseIndex === phaseIndex && b.railId === rec(terms?.rail)?.railId);
  const payee = address(agreement.payeeBoundAgreementVersion === "1" ? binding?.payeeAddress : parties.find((p) => p?.role === "seller")?.primaryClaim);
  const seller = address(parties.find((p) => p?.role === "seller")?.primaryClaim);
  if (!seller || payee !== seller) return "fail";
  if (!payer || !payee || price?.currency !== "DEM" || amount === null || amount <= 0n) return "fail";
  if (!read) return "indeterminate";
  try {
    const tx = rec(await read("getTxByHash", { hash: txHash }));
    if (!tx) return "indeterminate";
    if (tx.status !== "confirmed") return tx.status === "failed" ? "fail" : "indeterminate";
    const content = rec(tx.content);
    const data = content?.data;
    const payload = Array.isArray(data) && data[0] === "native" ? rec(data[1]) : null;
    const args = payload?.args;
    if (Array.isArray(args) && typeof args[1] === "number") return "indeterminate";
    // The node credits and debits the exact address string it stores (ac8f45f handleNativeOperations,
    // GCRBalanceRoutines findOneBy({ pubkey })), and its TO check accepts hex in any case. Another spelling
    // of the payee's key is another account, so only the canonical payer and payee strings match.
    if (hash(tx.hash) !== txHash || tx.blockNumber !== ref.blockNumber || content?.type !== "native" ||
        content.from !== payer || content.to !== payee ||
        payload?.nativeOperation !== "send" || !Array.isArray(args) || args.length !== 2 ||
        args[0] !== payee || payloadOs(args[1]) !== amount || storedOs(content.amount) !== amount) return "fail";
    const block = rec(await read("getBlockByNumber", { blockNumber: ref.blockNumber }));
    if (!block) return "indeterminate";
    const transactions = rec(block.content)?.ordered_transactions;
    return block.number === ref.blockNumber && Array.isArray(transactions) && transactions.some((h) => hash(h) === txHash) ? "pass" : "fail";
  } catch { return "indeterminate"; }
}
