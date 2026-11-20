# What is a verified Listing?

A verified Listing is a Listing that a reader has checked step by step and found sound. Among other checks, the signature is valid, it has not been withdrawn, the seller's identity bundle is well formed and, when it has a payment step, every payment rail it names resolves in the rail registry. `verified` is one of four results the Standard defines, and a conforming reader refuses a new session on the other three.

## The general idea

A signed offer helps a buyer only if the buyer can tell:

- who signed it, and that it is unchanged since;
- that the seller has not withdrawn it;
- that the payment methods it names exist, not just that it names them;
- "unknown" apart from "yes" and from "no".

## How DACS does it

A Listing is the publisher's signed, anchored statement of terms ([DACS-1, section 6.1](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#61-abstract)). The `seller` field names the Listing publisher, who is not always the seller of the Agreement: in a procurement Listing the publisher is the buyer ([DACS-1, section 6.3.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#634-service-listing)).

A reader ends with exactly one of these results:

| Result | Meaning | New session |
|---|---|---|
| `verified` | every step passed, revocation is `absent`, and rails are `verified` or not applicable | allowed |
| `rejected` | a step failed | refused |
| `revoked` | a valid withdrawal of this version by its publisher was found | refused |
| `indeterminate` | a check could not be completed | refused |

The reader runs the steps in a fixed order and halts on the first failure: schema, major version, validity window, signature, revocation, seller identity bundle, pipeline phases, accepted rails, and a signer the publisher controls. The one exception is an `indeterminate` rail result: it is kept while the signer check still runs, and if the signer check fails the Listing is `rejected` ([DACS-1, section 6.3.4, validation order and rules LR-2 and LR-3](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#634-service-listing)). Three details:

- **Rails.** The rail step applies only when the pipeline has a payment step. If any advertised rail definition is unavailable or cannot be authenticated, the whole Listing is `indeterminate` (unless the signer check then fails, which makes it `rejected`), even when that rail is unused. It stays so until every advertised rail resolves, and the publisher can drop the unresolvable one only with a new signed version (rule LRR-5).
- **Revocation.** The result is `absent` only when every consulted record is consistent, active and carries no revocation binding. A transport failure, a stale record or an integrity mismatch gives `indeterminate`, not `absent` (rule RB-6).
- **Pinning.** The reader pins the Listing id, version and content hash into the session record (rule LR-1). A new version replaces the old one for new sessions, and a session past its Agreement commitment stays on its pinned version.

`verified` does not say everything:

- It says nothing about whether the seller can be reached now. A reachability probe is separate evidence and never changes the signature check or the revocation result.
- It does not vet the seller's identity claims. That is Vet ([previous page](./how-can-an-agent-check-a-seller-before-paying.md)).
- For rails it establishes discovery eligibility only. At session start the orchestrator still selects one complete rail reference and pins its definition (rule LRR-6).

On the testnet, the Directory checks a Listing's shape, its signature and the seller's identity presentation ([listing verification code](../../reference-implementations/dacs-directory/src/catalog/listingVerification.ts)). It then marks the Listing `transactionReadiness.disposition=unassessed`: it does not apply a buyer's revocation, rail-authority, payload-capability or signer-control policy, so a Directory result is not the Standard's `verified` ([how it works page](../../reference-implementations/dacs-directory/app/how-it-works/page.tsx)).

## Where this is defined

- Listing, validation order, results, revocation, versions: [DACS-1, section 6.3.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#634-service-listing).
- Publisher and reader duties: the same section, rules LP-1 to LP-6 and LR-1 to LR-3.
- What the Directory checks: [listing verification code](../../reference-implementations/dacs-directory/src/catalog/listingVerification.ts) and the [Directory README](../../reference-implementations/dacs-directory/README.md).

Previous: [How can an agent check a seller before paying?](./how-can-an-agent-check-a-seller-before-paying.md)
Next: [How do I sell a service to AI agents?](./how-do-i-sell-a-service-to-ai-agents.md)
