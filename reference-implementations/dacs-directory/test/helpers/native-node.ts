// Authenticated operator fixture; never obtained from a listing or an RPC reply.
process.env.DACS_RAIL_SNAPSHOTS = JSON.stringify([{ registryVersion: 1, rails: [{
  railId: "demos-native:DEM", railVersion: 1, railType: "demos-native", phaseHandler: "pay-dem",
  availability: "live", asset: { kind: "native-dem", symbol: "DEM", decimals: 9 }, network: { kind: "demos" },
}] }]);
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
    // The node stores the account string the send credits: 0x and lowercase hex of the payee's key,
    // as in the captured transactions, never a claim reference.
    const account = (address: string) => { const hex = /([0-9a-fA-F]{64})$/.exec(address)?.[1]; return hex ? `0x${hex.toLowerCase()}` : address; };
    const to = agreement.payeeBoundAgreementVersion === "1" ? account(agreement.terms.payoutBindings[0].payeeAddress) : party("seller");
    return { hash: data.hash, status: "confirmed", blockNumber: ref.blockNumber,
      content: { type: "native", from: party("buyer"), to, amount: BigInt(amount) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : amount, data: ["native", { nativeOperation: "send", args: [to, amount] }] } };
  };
}
