/**
 * Why a read or adapter decided nothing (DACS-5 §10.5.1 at run time):
 * - `no-answer`: the infrastructure gave no reply about the record: a transport failure or timeout, a
 *   node error or unstructured reply, a node that has not reached the citing bundle's anchor. A later
 *   pass may get one, so the seller is held, for a bounded time (indexer.ts MAX_SELLER_HOLD_MS).
 * - `lasting`: the reply describes a state the session's own record keeps, which a party to it chose
 *   and no later pass decides: a payload this anonymous reader is denied, an extended pointer. It
 *   excludes that session alone; holding the seller for it would let a party suppress the seller's
 *   failures for good.
 */
export type UndecidedKind = "no-answer" | "lasting";

/**
 * A read or adapter that gave no authoritative answer. It never says the record is absent or false, so
 * the evidence graph leaves the session undecided rather than refuting it, and the message keeps the
 * real cause. Every thrower states the kind; there is no default.
 */
export class VerificationUnavailable extends Error {
  readonly kind: UndecidedKind;
  constructor(message: string, kind: UndecidedKind) {
    super(message);
    this.name = "VerificationUnavailable";
    this.kind = kind;
  }
}
