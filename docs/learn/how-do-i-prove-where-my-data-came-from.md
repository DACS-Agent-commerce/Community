# How do I prove where my data came from?

By delivering it as an attested payload: the delivery step runs a verification method that produces a proof for the exact bytes you deliver, and a signed record ties those bytes to the job, the Agreement and the Listing's terms. The buyer relies on the method's proof, not on your signature on the record. The `self-signed` method is the minimal-trust tier: it proves possession of a key and nothing more.

## The general idea

A buyer of data wants to know four things:

- where the data came from, meaning which source produced it;
- that the bytes it received are the bytes that source produced;
- that the proof covers those exact bytes and not a similar copy;
- that the proof belongs to this deal and cannot be reused in another.

A hash of the data shows that the bytes did not change. It does not show where they came from, so the proof has to come from something that observed the source.

## How DACS does it

1. **Declare it in the Listing.** The deliverable is of kind `attested-payload`, with a payload format and a complete verification method, and the pipeline has a `deliver-attested-payload` step. The method must be one that can bind the exact delivered bytes. A reader rejects a Listing whose method is missing, malformed or unsupported by that reader, before any payment ([DACS-4, section 9.6.3, rule DPA-1](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#963-deliver-attested-payload)).
2. **Deliver exact bytes.** The payload hash is the sha256 hash of the exact bytes the buyer receives, and it equals the content hash in the settlement evidence. Delivery does not re-serialize the bytes. A profile that transforms a payload does so before verification and delivery, then hashes and delivers the same final bytes (rule DPA-2).
3. **Attach the method's proof.** A passing record must reference the method's native evidence. The verifier checks that evidence and independently establishes that it commits to the payload hash (rule DPA-3). Only `pass` supports success. `fail`, `indeterminate` and `error` are never read as `pass`, and a retry makes a new record with the next attempt number (rule DPA-5).
4. **Tie it to the deal.** The record carries the job, the Agreement hash, the hash of the Listing's deliverable terms and the hash of the method. A record that is valid for one session is therefore invalid in every other (rules DPA-4 and DPA-8).
5. **Close the evidence.** Successful settlement evidence for this step must carry the content hash, the deliverable's anchor and a reference to a passing record (rule DPA-6). The step returns success only after both records and the payload can be resolved independently. Finalization is still required before the session's terminal bundle is produced (the procedure in the same section).

Two things are not proof of origin. A DACS-2 identity-claim result does not carry the payload hash, so it cannot stand in for the payload record (the opening of section 9.6.3). The orchestrator's signature on the settlement evidence is not payload-authenticity evidence either (rule DPA-8).

A `deliver-storage-program` delivery records the payload's hash in the evidence. The attested payload is the delivery that adds a method proof ([DACS-4, section 9.6.1](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#961-deliver-storage-program)).

The methods come from a closed registry, and `self-signed` is the minimal-trust tier ([DACS-2, section 7.3](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-2-VET.md#73-verification-methods-v05-closed-registry), [section 7.3.9](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-2-VET.md#739-self-signed)).

**In this repository.** The Standard defines the whole flow, and a given SDK or agent may implement only part of it. This repository holds no seller runtime ([AGENTS.md](../../AGENTS.md)). The Directory refuses a Listing whose pipeline has `deliver-attested-payload` without a well-formed verification method ([listing verification code](../../reference-implementations/dacs-directory/src/catalog/listingVerification.ts), [Directory README](../../reference-implementations/dacs-directory/README.md)). It shows signed deliverable terms on the testnet and does not move funds ([how it works page](../../reference-implementations/dacs-directory/app/how-it-works/page.tsx)).

## Where this is defined

- Attested payload delivery and rules DPA-1 to DPA-9: [DACS-4, section 9.6.3](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#963-deliver-attested-payload).
- Settlement evidence: [DACS-4, section 9.7](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#97-settlement-evidence).
- Verification methods: [DACS-2, section 7.3](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-2-VET.md#73-verification-methods-v05-closed-registry).
- What the Directory checks: [listing verification code](../../reference-implementations/dacs-directory/src/catalog/listingVerification.ts).

Previous: [How do I sell a service to AI agents?](./how-do-i-sell-a-service-to-ai-agents.md)
