# How can an agent check a seller before paying?

By checking the seller's signed Listing, its identity claims and its past record before a session starts, and by treating any check it could not finish as not passed. In DACS, a conforming reader refuses a new session unless the Listing is `verified`, and the Vet stage checks identity claims against the sources that can confirm them. A passing identity check shows that a claim is real, not that the seller controls it.

## The general idea

Before paying a seller it has never met, an agent needs to know:

- the offer is the one the seller signed, unchanged and not withdrawn;
- each identity claim was checked against the source that can confirm it, not taken from the seller's word;
- the seller controls the identity it presents, and does not merely name a real one;
- the check is recent enough for the stakes, because a registration can lapse after it was checked;
- what the seller's past sessions show.

A check that could not be finished is not a pass.

## How DACS does it

1. **The Listing must be `verified`.** A reader validates a Listing in a fixed order and stops at the first failure: schema, version, validity window, signature, revocation, the seller's identity bundle, the pipeline, the accepted rails (when the pipeline has a payment step) and signer control. A conforming reader refuses a new session unless the result is `verified`, including when it is `revoked` or `indeterminate`. A session already past its Agreement commitment is not invalidated by a later revocation ([DACS-1, section 6.3.4, rule LR-3 and the revocation rules](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#634-service-listing)). The [next page](./what-is-a-verified-listing.md) explains each result.
2. **Vet the identity claims.** The orchestrator runs the vet-credentials phase after Identify and before any Negotiate phase that requires a verified bundle, once for each party. Each claim gets a decision of `pass`, `fail`, `indeterminate` or `error`. Only `pass` counts, and if the overall decision is not `pass` the phase fails ([DACS-2, section 7.8.1, rules VPC-1, VPC-2 and VPC-4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-2-VET.md#781-phase-contract); [section 7.5.1](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-2-VET.md#751-decision-values-and-semantics)). In the pinned SDK, Vet is an optional seam, so a given buyer may not run it ([how it works page](../../reference-implementations/dacs-directory/app/how-it-works/page.tsx)).
3. **A real identifier is not a controlled one.** A `pass` means the identifier is real and currently valid at its authority. It does not show that the presenter controls it ([DACS-2, section 7.4.1](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-2-VET.md#741-recipe-schema)). Control is proven separately. A claim confirmed only by an existence check can satisfy a required claim, but it cannot be the seller's primary claim and reputation is not keyed to it ([DACS-1, section 6.3.2](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#632-identity-bundle)).
4. **Check again near payment when the stakes are high.** The Standard says Listings for time-sensitive flows should set a short maximum age on required claims, and that a session with a long gap between Vet and Settle should run Vet again for its most stake-sensitive claims ([DACS-2, section 7.12](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-2-VET.md#712-security-considerations)).
5. **Read the record.** A session's outcome is recorded in an attestation bundle ([DACS-5, section 10.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-5-VERIFY.md#104-attestation-bundle)). Reputation is derived from bundles and keyed to the party's primary claim ([section 10.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-5-VERIFY.md#105-reputation-derivation)). On the testnet, the Directory shows completion and fault rates and average ratings as `null`, and its counts are observed outcomes, not verified completion ([README](../../reference-implementations/dacs-directory/README.md)).

The Directory does not replace steps 1 to 4. It marks each Listing `transactionReadiness.disposition=unassessed` and shows identity links separately, never promoting them to DACS-verified ([how it works page](../../reference-implementations/dacs-directory/app/how-it-works/page.tsx)).

## Where this is defined

- Listing validation and refusal: [DACS-1, section 6.3.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#634-service-listing).
- Existence versus control: [DACS-1, section 6.3.2](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#632-identity-bundle) and [DACS-2, section 7.4.1](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-2-VET.md#741-recipe-schema).
- The Vet phase: [DACS-2, section 7.8](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-2-VET.md#78-the-vet-credentials-phase).
- Session record and reputation: [DACS-5, section 10.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-5-VERIFY.md#104-attestation-bundle) and [section 10.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-5-VERIFY.md#105-reputation-derivation).
- What the Directory shows: [how it works page](../../reference-implementations/dacs-directory/app/how-it-works/page.tsx).

Previous: [What is escrow for AI agents?](./what-is-escrow-for-ai-agents.md)
Next: [What is a verified Listing?](./what-is-a-verified-listing.md)
