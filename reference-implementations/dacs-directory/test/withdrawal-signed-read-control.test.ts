import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { contentHash, sha256Hex } from '../src/catalog/canonical.js';
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from '@kynesyslabs/dacs/crypto';
const directory = mkdtempSync(join(tmpdir(), 'review-unsigned-withdrawal-'));
process.env.DACS_DIRECTORY_DATA = directory;
const { crawlDomain, wellKnownWithdrawalMessage } = await import('../src/catalog/wellknown.js');
const { ingestWellKnownRevocations } = await import('../src/catalog/reindexCore.js');
const { indexRegistration } = await import('../src/catalog/indexer.js');
const { revocationLogicalAddress, verifyListing } = await import('../src/catalog/listingVerification.js');
const store = await import('../src/catalog/store.js');
const { activeOffer } = await import('../src/catalog/discovery.js');
test.after(() => rmSync(directory, { recursive: true, force: true }));
const at = (n: number) => `stor-${String(n).padStart(40, '0')}`;

for (const [index, revokedAt] of [1, 1784073600000.5, -1, -1.5].entries()) test(`authenticated readable tombstone stays revoked with revokedAt ${revokedAt}`, async () => {
  const listingId = `svc-${index}`;
  const seed = new Uint8Array(32).fill(41);
  const key = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString('hex');
  const claim = `did:demos:agent:${key}`;
  const sign = (raw: Record<string, unknown>, prefix: string) => ({ algorithm: 'ed25519', signer: claim,
    value: Buffer.from(ed25519Sign(Buffer.from(prefix + contentHash(raw)), privateKeyFromSeed(seed))).toString('base64url') });
  const identityScope = { bundleVersion: '1', presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
  const identity = { ...identityScope, presentation: { kind: 'per-claim', signatures: [{ ref: claim,
    signature: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`), privateKeyFromSeed(seed))).toString('base64url') }] } };
  const scope = { dacsVersion: '1', listingVersion: 1, listingId, requiredCapabilities: ['SR-2'],
    seller: { displayName: 'Service', identity },
    offering: { title: 'Service', description: 'Service', category: 'services.other', tags: [],
      deliverable: { kind: 'attested-payload', payloadFormat: 'application/json', verificationMethod: { kind: 'self-signed' } } },
    buyerRequirement: { requirementVersion: '1', required: [] },
    pipeline: [{ kind: 'negotiate-fixed-price' }, { kind: 'commit-agreement' }, { kind: 'deliver-attested-payload' }],
    pricing: { kind: 'fixed', price: { amount: '1', currency: 'DEM' } },
    terms: {}, validity: { notBefore: 1 } };
  const listing = { ...scope, signature: sign(scope, 'dacs-listing:v1:') };
  const verified = await verifyListing(listing); assert.ok(verified); assert.equal(verified.profile, 'dacs-v0.1');
  const markerScope = { listingId, listingVersion: 1, listingContentHash: verified.contentHash, revokedAt };
  const marker = { ...markerScope, signature: sign(markerScope, 'dacs-revocation:v1:') };
  // Build the publisher's binding independently of the verifier under test.
  const binding = { sellerPrimaryClaim: claim, listingId, listingVersion: 1, listingContentHash: verified.contentHash,
    logicalAddress: revocationLogicalAddress(claim, listingId, 1), markerAnchor: { kind: 'storage-program', locator: at(2) },
    markerContentHash: contentHash(markerScope) };
  const indexRaw = JSON.stringify({ indexVersion: '1', generatedAt: 123 + index, seller: claim, listings: [{ listingId, version: 1,
    contentHash: verified.contentHash, anchor: { kind: 'storage-program', locator: at(1) },
    summary: { title: 'Service', category: 'services.other', tags: [] }, status: 'revoked', revocation: binding }] });
  const docs: Record<string, string> = { '/.well-known/agent.json': JSON.stringify({ dacs: { dacsVersion: '1',
    listings: { indexUrl: 'https://seller.example/.well-known/dacs/listings.json', indexHash: `sha256-${sha256Hex(indexRaw)}` } } }),
    '/.well-known/dacs/listings.json': indexRaw };
  const card = JSON.parse(docs['/.well-known/agent.json']);
  card.dacs.listings.publisherSignature = Buffer.from(ed25519Sign(
    Buffer.from(wellKnownWithdrawalMessage('seller.example', sha256Hex(indexRaw))), privateKeyFromSeed(seed))).toString('base64url');
  docs['/.well-known/agent.json'] = JSON.stringify(card);
  const crawled = await crawlDomain('seller.example', { validateUrl: async () => ({} as never), fetchJson: async (url) => {
    const raw = docs[new URL(url).pathname]; return raw ? { raw, body: JSON.parse(raw) } : null;
  } });
  assert.ok(!('error' in crawled));
  assert.equal(crawled.withdrawalAuthenticated, true, 'positive control: index has a valid seller signature');
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const isMarker = new URL(String(input)).pathname.endsWith(at(2));
    return Response.json({ success: true, owner: `0x${key}`, data: isMarker ? marker : listing });
  };
  try {
    await ingestWellKnownRevocations(crawled);
    const reg = { primaryClaim: claim, displayName: 'Service', listingAnchors: [at(1)], deals: [] };
    for (let pass = 0; pass < 2; pass++) {
      const indexed = await indexRegistration(reg, undefined, async () => { throw new Error('offline'); });
      assert.equal(indexed.listings.length, 1);
      assert.equal(indexed.listings[0].status, 'revoked', `indexing pass ${pass}`);
      assert.equal(indexed.listings.some(activeOffer), false);
    }
  } finally { globalThis.fetch = oldFetch; }
  assert.equal(store.hasPendingRevocationCandidates(verified.contentHash), true);
});
