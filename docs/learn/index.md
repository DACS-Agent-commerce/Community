# Learn: how agent commerce works with DACS

Short pages in plain words. Each one answers a single question. The first paragraph is the answer, then comes the general idea, then how DACS does it, then a link to the Standard section or the code it relies on.

DACS (Demos Agent Commerce Standards) is an open standard that lets AI agents find, vet, agree terms with and pay sellers of services and data, with signed delivery evidence. It is testnet only for now. It is not related to other software or packages called DACS ([AGENTS.md](../../AGENTS.md)).

## Pages

1. [What is agent commerce?](./what-is-agent-commerce.md)
2. [How do AI agents find services to buy?](./how-do-ai-agents-find-services-to-buy.md)
3. [How do AI agents pay each other safely?](./how-do-ai-agents-pay-each-other-safely.md)
4. [What is escrow for AI agents?](./what-is-escrow-for-ai-agents.md)
5. [How can an agent check a seller before paying?](./how-can-an-agent-check-a-seller-before-paying.md)
6. [What is a verified Listing?](./what-is-a-verified-listing.md)
7. [How do I sell a service to AI agents?](./how-do-i-sell-a-service-to-ai-agents.md)
8. [How do I prove where my data came from?](./how-do-i-prove-where-my-data-came-from.md)
9. [What is an agent-readable directory?](./what-is-an-agent-readable-directory.md)
10. [How do agent payment protocols compare?](./how-do-agent-payment-protocols-compare.md)
11. [What does an agent agree to before paying?](./what-does-an-agent-agree-to-before-paying.md)
12. [How do I check what happened in a deal?](./how-do-i-check-what-happened-in-a-deal.md)

## Words used on these pages

These words mean the same thing on every page. Listing, Agreement, Rail, Settlement evidence and Anchored below are plain-language summaries of entries in the [Standard's glossary](https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/spec/GLOSSARY.md). Escrow, Standard and Directory are terms defined here for this repository.

- **Listing:** a signed, anchored description published by one party of what it offers or needs.
- **Agreement:** the signed final terms between a buyer and a seller.
- **Rail:** one way to pay, defined by a network, an asset and a settlement method.
- **Settlement evidence:** the record that every payment and delivery step produces.
- **Escrow:** a hold on a payment until a condition is met.
- **Anchored:** stored so that any party can retrieve the content and check it.
- **Standard:** the [DACS-Standard](https://github.com/DACS-Agent-commerce/DACS-Standard/tree/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20) repository, which holds the specification.
- **Directory:** the catalog app in [`reference-implementations/dacs-directory`](../../reference-implementations/dacs-directory).
