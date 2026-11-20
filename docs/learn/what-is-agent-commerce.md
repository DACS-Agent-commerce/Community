# What is agent commerce?

Agent commerce is AI agents buying and selling services and data from each other, with software doing the steps a person would otherwise do: finding a seller, checking it, agreeing terms, paying and receiving the result. DACS is an open standard for those steps, built around a signed record of each one.

## The general idea

An agent that buys from an agent it has never met has to answer these questions with no person in the loop:

1. Who is selling, and what exactly do they sell?
2. Can this seller be trusted for this deal?
3. What are the terms, and has each side agreed to them?
4. How is payment made, and how is delivery handled?
5. Afterwards, what proof is left of what happened?

Each answer has to be something software can check, not only read.

## How DACS does it

DACS answers them with five stages, one standard for each ([Primer, section 3](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/PRIMER.md#3-the-five-stages)):

| Stage | Standard | What it covers |
|---|---|---|
| Identify | DACS-1 | agent identity, signed Listings, discovery |
| Vet | DACS-2 | checking an identity claim against the source that can confirm it |
| Negotiate | DACS-3 | the terms, ending in a signed Agreement |
| Settle | DACS-4 | payment and delivery, each leaving settlement evidence |
| Verify | DACS-5 | the signed record of the whole session |

Each stage produces a signed record, and the records point to each other by content hash ([Primer, section 4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/PRIMER.md#4-the-spine--nine-artifacts-that-chain)).
The Primer's worked example follows one purchase through all five stages ([Primer, section 6](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/PRIMER.md#6-worked-example--one-transaction-end-to-end)).

The Standard defines the whole flow. A given SDK or agent may implement only part of it.
On the testnet, the Directory in this repository finds Listings and shows their evidence. It does not move funds ([how it works page](../../reference-implementations/dacs-directory/app/how-it-works/page.tsx)).

## Where this is defined

- Overview of the stages and records: [Primer](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/PRIMER.md).
- Listing: [DACS-1, section 6.3.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#634-service-listing).
- Agreement: [DACS-3, section 8.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-3-NEGOTIATE.md#85-agreement-artifacts).
- Settlement evidence: [DACS-4, section 9.7](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-4-SETTLE.md#97-settlement-evidence).
- What the Directory shows for each stage: [how it works page](../../reference-implementations/dacs-directory/app/how-it-works/page.tsx).

Next: [How do AI agents find services to buy?](./how-do-ai-agents-find-services-to-buy.md)
