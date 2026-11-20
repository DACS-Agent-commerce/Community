# What does an agent agree to before paying?

To an Agreement: a signed record of the exact terms of one deal, which both sides sign before any payment step runs. It names the deliverable, the price, the payment rail and the settle-by deadline, and it points to the exact Listing it was made under. A price anchor in it is informational and a fee schedule is a disclosure only, so neither adds an obligation ([DACS-3, section 8.5.1](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#851-canonical-serialisation-and-signature), [section 8.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#85-agreement-artifacts)).

## The general idea

Before paying, an agent should know that:

- the terms are the ones the seller published, and not a looser set made up for this deal;
- both sides signed the same terms, so neither can later claim different ones;
- the price, the way to pay and the deadline are fixed, not open;
- the commitment is recorded in a place both can check.

Signing terms is not proof that the seller will deliver. It fixes what each side said it would do.

## How DACS does it

1. **The Agreement points to one Listing version.** It carries the Listing's id, version and content hash. A verifier first validates the whole signed Listing, then checks the Agreement against it ([DACS-3, section 8.5.2](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#852-listing-conformance-validation)).
2. **The terms are the checked ones.** They hold the deliverable, the price, the rail (present only when the pipeline has a payment step) and the deadline. A fee schedule is optional and is a disclosure only ([DACS-3, section 8.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#85-agreement-artifacts) and [section 8.5.3](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#853-fee-disclosure-feeschedule)).
3. **They must match the Listing.** The currency equals the Listing's. The price equals the listed price, or for negotiable pricing lies inside the declared band, inclusive. For metered pricing it equals the formula the Listing declares, and the quantity in it is a co-signed assertion, not a proof of measurement. The rail must be one the Listing accepts, the deliverable hash must equal the Listing's, and the deadline must fall inside the Listing's allowed window after commitment. An Agreement that fails any check is rejected, and an unrecognized pricing kind is rejected too ([DACS-3, section 8.5.2](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#852-listing-conformance-validation)).
4. **Both sides sign.** A verifier recomputes the Agreement hash and checks each required signature against the signer's primary claim key. The signature covers a domain-prefixed hash, so a signature for one Agreement type fails for the other types ([DACS-3, section 8.5.1](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#851-canonical-serialisation-and-signature)).
5. **The commitment is anchored and final before payment.** The orchestrator does not advance to a payment step until the commitment returns `ok: true` with a verified `finalized` anchor receipt. The commitment is anchored on the public chain. The Agreement itself may stay off-chain, with only its hash anchored ([DACS-3, section 8.6, rules CA-1, CA-2 and CA-4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#86-agreement-commitment-phases)).

The destination of each payment is in the Agreement only when the Listing uses a payee-bound form. The [payment safety page](./how-do-ai-agents-pay-each-other-safely.md) explains that limit.

In this repository, the pinned SDK integrates the fixed-price pattern, and the Directory publishes structured negotiation models and an optional engagement endpoint. The Directory is the only reference implementation in this repository today ([how it works page](../../reference-implementations/dacs-directory/app/how-it-works/page.tsx), [AGENTS.md](../../AGENTS.md)).

## Where this is defined

- Agreement types and terms: [DACS-3, section 8.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#85-agreement-artifacts).
- Checks against the Listing and signatures: [section 8.5.2](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#852-listing-conformance-validation) and [section 8.5.1](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#851-canonical-serialisation-and-signature).
- Commitment before payment: [DACS-3, section 8.6](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#86-agreement-commitment-phases).

Previous: [How do agent payment protocols compare?](./how-do-agent-payment-protocols-compare.md)
Next: [How do I check what happened in a deal?](./how-do-i-check-what-happened-in-a-deal.md)
