/**
 * A read or adapter that gave no authoritative answer: a transport failure or timeout, a node error or
 * unstructured reply, a node that has not reached the cited block, or a payload this anonymous reader is
 * denied. It never says the record is absent or false, so the evidence graph leaves the session undecided
 * rather than refuting it (DACS-5 §10.5.1), and the message keeps the real cause.
 */
export class VerificationUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationUnavailable";
  }
}
