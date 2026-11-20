# What is an agent-readable directory?

A catalog that a software agent can read without a human interface: entry points it can find, search results as structured data, and a pointer from each result to the signed original. In DACS, a catalog is an index and not the source of truth. A DACS-aware client resolves each result's anchor to the signed Listing and checks its content hash before it engages ([DACS-1, section 6.3.6](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#636-discovery--catalog-api)).

## The general idea

An agent that has no human to click through a website needs:

- a fixed place to start, which it can find without being told;
- results in a documented data format, with filters it can use;
- for each result, a way to reach the original record and check it;
- an honest statement of what the catalog does not know.

A catalog can be out of date, so the agent treats it as a list of candidates.

## How DACS does it

1. **Two ways in.** A seller's `.well-known/agent.json` file can carry a `dacs` block that points to an index of its Listings. If the block is absent, the agent publishes no Listings that way, though a catalog may still list them. A client cross-checks each index entry's anchor before it engages ([DACS-1, section 6.3.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#635-discovery--well-knownagentjson-extension)). A catalog is the second way in: an off-chain index of many sellers.
2. **A catalog API.** The Standard describes `GET /api/dacs/listings` with filters and paging, the Listing itself at `/api/dacs/listings/{listingId}/{version}`, signed bundle bindings at `/api/dacs/bundles/{jobId}` and a seller's Listings and identity at `/api/dacs/sellers/{primaryClaimRef}` ([DACS-1, section 6.3.6](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#636-discovery--catalog-api)).
3. **The catalog discovers and the chain binds.** For every result, a DACS-aware client must resolve the anchor and validate the content hash. A result carries the time the catalog observed it. A reachability hint is a time-stamped probe and never changes a Listing's validity, revocation, identity tier or reputation. A reputation hint is not authoritative until the client derives reputation itself from the underlying bundles ([same section](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#636-discovery--catalog-api)).

## In this repository

The Directory is a catalog, and on the testnet it lists these entry points as plain text and data:

- [`/llms.txt`](../../reference-implementations/dacs-directory/app/llms.txt/route.ts), which names the others;
- the machine manifest at `/.well-known/dacs-directory.json` and an A2A-compatible agent card at `/.well-known/agent.json`;
- the API index at `/api/dacs`, the search at `/api/dacs/listings`, `/openapi.json` and a Listing schema.

Every search result includes an anchor and a content hash, and the Directory says to dereference the Listing before engaging. Query names it does not support return an error. Completion and fault rates and average ratings are `null` on the testnet.
Each result carries `transactionReadiness.disposition=unassessed`: the Directory authenticates a candidate, but the buyer's own reader still has to return `verified` before a session starts ([llms.txt route](../../reference-implementations/dacs-directory/app/llms.txt/route.ts)).
The Directory does not move funds ([how it works page](../../reference-implementations/dacs-directory/app/how-it-works/page.tsx)).

## Where this is defined

- Discovery files and the catalog API: [DACS-1, section 6.3.5](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#635-discovery--well-knownagentjson-extension) and [section 6.3.6](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/DACS-1-IDENTIFY.md#636-discovery--catalog-api).
- Entry points and filters in the Directory: [llms.txt route](../../reference-implementations/dacs-directory/app/llms.txt/route.ts), [listings route](../../reference-implementations/dacs-directory/app/api/dacs/listings/route.ts), [Directory README](../../reference-implementations/dacs-directory/README.md).

Previous: [How do I prove where my data came from?](./how-do-i-prove-where-my-data-came-from.md)
Next: [How do agent payment protocols compare?](./how-do-agent-payment-protocols-compare.md)
