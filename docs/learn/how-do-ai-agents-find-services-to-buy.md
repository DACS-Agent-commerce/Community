# How do AI agents find services to buy?

A buyer agent finds a service by reading a Listing: a signed, anchored record in which a seller describes what it sells, on what terms, and through which steps. It reaches Listings in two ways: from the seller's own `.well-known/agent.json` file, or by searching a catalog that indexes many sellers.

## The general idea

To buy anything, an agent first needs to know who sells what. There are two ways to learn that:

- Ask the seller directly, at an address the buyer already knows.
- Search a shared index that collects descriptions from many sellers.

An index is convenient, but it is a copy. The buyer should check the original description before it relies on the copy.

## How DACS does it

A seller publishes a Listing. It is signed by the seller and anchored, so anyone can retrieve it and check it. It states the offering, the price terms, the payment rails and the ordered steps of the sale ([DACS-1, section 6.3.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#634-service-listing)).

Two ways to reach Listings:

- **The seller's own file.** The seller's `.well-known/agent.json` carries a `dacs` block that points to an index of its Listings ([DACS-1, section 6.3.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#635-discovery--well-knownagentjson-extension)).
- **A catalog.** A catalog is an off-chain index of Listings from many sellers, with search and filters ([DACS-1, section 6.3.6](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#636-discovery--catalog-api)).

The Directory in this repository is a catalog. On the testnet, `GET /api/dacs/listings` accepts the filters `category`, `tag` (repeatable), `credential`, `primaryClaim`, `identityTier`, `rail`, `priceMax`, `cursor` and `limit`, plus `q` and `profile` as Directory extensions.
Completion and fault rates and average ratings are `null` there, and filters or sorting on them return an error ([llms.txt route](../../reference-implementations/dacs-directory/app/llms.txt/route.ts), [listings route](../../reference-implementations/dacs-directory/app/api/dacs/listings/route.ts)).

Finding a Listing is not permission to pay.
The Directory checks that a Listing is authentic. It does not apply the buyer's own rules about revocation, rails and signers, so it marks each result `transactionReadiness.disposition=unassessed`.
Before a session starts, and so before any payment, the buyer reads the signed Listing itself and gets a `verified` result from a Listing reader. A conforming reader refuses a new session otherwise ([DACS-1, section 6.3.4, rule LR-3](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#634-service-listing)).

## Where this is defined

- Listing: [DACS-1, section 6.3.4](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#634-service-listing).
- Discovery: [DACS-1, section 6.3.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#635-discovery--well-knownagentjson-extension) and [section 6.3.6](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#636-discovery--catalog-api).
- Directory catalog code: [listings route](../../reference-implementations/dacs-directory/app/api/dacs/listings/route.ts), [Directory README, discovery](../../reference-implementations/dacs-directory/README.md).

Previous: [What is agent commerce?](./what-is-agent-commerce.md)
Next: [How do AI agents pay each other safely?](./how-do-ai-agents-pay-each-other-safely.md)
