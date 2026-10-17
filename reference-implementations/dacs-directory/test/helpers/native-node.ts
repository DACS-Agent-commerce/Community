import type { SettlementNodeRead } from "../../src/catalog/nativePayment.js";
type Obj = Record<string, any>;
/** Offline confirmed native sends, separate from the signed success assertions under test. */
export function nativeNodeFixture(artifacts: () => Iterable<Obj>): SettlementNodeRead {
  return async (message, data) => {
    const records = [...artifacts()];
    const payments = records.filter((r) => r.evidenceVersion === "1" && r.phase === "pay-dem");
    const clean = (s: string) => s.replace(/^0x/, "").toLowerCase();
    if (message === "getBlockByNumber") return { number: data.blockNumber,
      content: { ordered_transactions: payments.flatMap((p) => (p.paymentTxRefs ?? []).filter((r: Obj) => r.blockNumber === data.blockNumber).map((r: Obj) => clean(r.txHash))) } };
    const evidence = payments.find((p) => (p.paymentTxRefs ?? []).some((r: Obj) => typeof r.txHash === "string" && clean(r.txHash) === data.hash));
    const ref = evidence?.paymentTxRefs.find((r: Obj) => clean(r.txHash) === data.hash);
    const agreement = records.find((r) => (r.agreementVersion === "1" || r.payeeBoundAgreementVersion === "1") && r.jobId === evidence?.jobId);
    if (!ref || !agreement) return null;
    const party = (role: string) => `0x${agreement.parties.find((p: Obj) => p.role === role).primaryClaim.slice(-64)}`;
    const [whole, fraction = ""] = agreement.terms.price.amount.split(".");
    const amount = (BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, "0"))).toString();
    const to = agreement.payeeBoundAgreementVersion === "1" ? agreement.terms.payoutBindings[0].payeeAddress : party("seller");
    return { hash: data.hash, status: "confirmed", blockNumber: ref.blockNumber,
      content: { type: "native", from: party("buyer"), to, amount: BigInt(amount) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : amount, data: ["native", { nativeOperation: "send", args: [to, amount] }] } };
  };
}
