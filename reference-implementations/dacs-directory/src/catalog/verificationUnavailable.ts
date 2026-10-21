/**
 * Why a read or adapter decided nothing (DACS-5 §10.5.1 at run time). Either way the session is undecided: it
 * counts neither as completed nor as failed, and the rates it could change are published as ranges
 * (reputation.ts). The kind only says whether a later pass may decide it:
 * - `no-answer`: the infrastructure gave no reply about the record: a transport failure or timeout, a
 *   node error or unstructured reply, a node that has not reached the citing bundle's anchor. A later
 *   pass may get one.
 * - `lasting`: the reply describes a state the session's own record keeps, which a party to it chose
 *   and no later pass decides: a payload this anonymous reader is denied, an extended pointer.
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
