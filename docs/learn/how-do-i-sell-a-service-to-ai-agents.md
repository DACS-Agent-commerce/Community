# How do I sell a service to AI agents?

By publishing a signed, anchored Listing that states what you sell, on what terms, through which payment rails and in what order of steps, and by keeping it findable and checkable. A conforming publisher marks a Listing active only after its anchor is finalized and, if it has payment steps, its rails have been resolved. The Directory in this repository does not publish for you, and it is testnet only.

## The general idea

A buyer agent can only deal with a seller it can find, check and hold to stated terms. So a seller needs to:

- say who it is, in a form the buyer can check;
- publish terms that software can read and that do not change under the buyer;
- say how it wants to be paid and how it will deliver;
- stay reachable, and be able to withdraw an offer.

## How DACS does it

1. **Present an identity bundle.** It is an ordered set of the claims you hold, with a presentation signature and a primary claim ([DACS-1, section 6.3.2](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#632-identity-bundle)). Reputation keys to that primary claim ([DACS-5, section 10.1](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-5-VERIFY.md#101-abstract)).
2. **Write the Listing.** It holds the offering and its deliverable, the requirement on the counterparty, the ordered pipeline, pricing, the accepted rails, terms and a validity window. The accepted rails are required when the pipeline has a payment step. The pipeline fixes the order of payment and delivery, as the [payment page](./how-do-ai-agents-pay-each-other-safely.md) describes ([DACS-1, section 6.3.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#634-service-listing)).
3. **Sign it and number the version.** Sign with a key referenced by a claim in your identity bundle. Each version number for a Listing id goes up by one, and none is skipped. A new version replaces the old one for new sessions, and a session already past its Agreement commitment stays on its pinned version (rules LP-2 and LP-3, and the versioning rules in the same section).
4. **Resolve your rails.** For a Listing with payment steps, obtain a `verified` rail result at publication time. Your own list of accepted rails is not proof (rule LP-6).
5. **Anchor it and wait for finality.** Obtain a finalized anchor receipt and check that the address resolves to the expected content hash before you mark the Listing active or put it in an index. A submitted, broadcast, merely accepted or merely index-visible Listing does not meet this (rule LP-1).
6. **Make it findable.** To be found through your own domain, publish a `dacs` block in your `.well-known/agent.json` that points to an index of your Listings, and keep its index hash current. Clients check each index entry against its anchor, because the index is a convenience and not a source of truth ([DACS-1, section 6.3.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#635-discovery--well-knownagentjson-extension)). A catalog can list you instead or as well ([section 6.3.6](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#636-discovery--catalog-api)).
7. **Stay reachable.** A publisher should keep a working engagement surface for each active Listing and withdraw or mark a Listing unavailable when none remains. A probe never changes the Listing's signature check or revocation result (rule LP-5 and the reachability rules).
8. **Withdraw by version.** To withdraw a version, anchor a signed revocation marker and publish its binding on every discovery surface that carries that version. A session already past its Agreement commitment is not invalidated by revocation (rules RB-1 to RB-3, and the rule that revocation does not invalidate a session past commitment).

When a buyer starts a session, the rest follows the pipeline: terms end in a signed Agreement ([DACS-3, section 8.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#85-agreement-artifacts)), and payment and delivery leave evidence ([DACS-4, section 9.7](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#97-settlement-evidence)).

**In this repository.** The Directory's browser publisher is unavailable. Publish through a DACS client that verifies rail authority and a finalized anchor receipt. For an existing Listing, send its pointers to `POST /api/dacs/register`. The Directory then verifies the chain artifacts itself, and submitting pointers does not confirm publication or make a Listing active ([register page](../../reference-implementations/dacs-directory/app/register/page.tsx)). No DACS package is on npm yet. The Directory's setup builds the pinned SDK from source ([AGENTS.md](../../AGENTS.md)).

## Where this is defined

- Identity bundle: [DACS-1, section 6.3.2](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#632-identity-bundle).
- Listing, publisher rules (LP-1 to LP-6), revocation: [DACS-1, section 6.3.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#634-service-listing).
- Discovery: [DACS-1, section 6.3.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#635-discovery--well-knownagentjson-extension) and [section 6.3.6](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#636-discovery--catalog-api).
- Submitting pointers to the Directory: [register page](../../reference-implementations/dacs-directory/app/register/page.tsx).

Previous: [What is a verified Listing?](./what-is-a-verified-listing.md)
Next: [How do I prove where my data came from?](./how-do-i-prove-where-my-data-came-from.md)
