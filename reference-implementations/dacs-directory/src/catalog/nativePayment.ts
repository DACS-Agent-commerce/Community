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
// The pinned node uses numeric DEM; the SDK's post-fork wire carries OS strings.
const wireOs = (v: unknown): bigint | null => typeof v === "string" && /^(?:0|[1-9]\d*)$/.test(v)
  ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? demOs(String(v)) : null;

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
    if (hash(tx.hash) !== txHash || tx.blockNumber !== ref.blockNumber || content?.type !== "native" ||
        address(content.from) !== payer || address(content.to) !== payee ||
        payload?.nativeOperation !== "send" || !Array.isArray(args) || args.length !== 2 ||
        address(args[0]) !== payee || wireOs(args[1]) !== amount || wireOs(content.amount) !== amount) return "fail";
    const block = rec(await read("getBlockByNumber", { blockNumber: ref.blockNumber }));
    if (!block) return "indeterminate";
    const transactions = rec(block.content)?.ordered_transactions;
    return block.number === ref.blockNumber && Array.isArray(transactions) && transactions.some((h) => hash(h) === txHash) ? "pass" : "fail";
  } catch { return "indeterminate"; }
}
