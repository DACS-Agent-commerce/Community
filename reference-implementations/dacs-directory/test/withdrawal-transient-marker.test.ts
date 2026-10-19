import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { contentHash, sha256Hex } from '../src/catalog/canonical.js';
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from '@kynesyslabs/dacs/crypto';
const directory = mkdtempSync(join(tmpdir(), 'review-unsigned-withdrawal-'));
process.env.DACS_DIRECTORY_DATA = directory;
const { crawlDomain } = await import('../src/catalog/wellknown.js');
const { ingestWellKnownRevocations } = await import('../src/catalog/reindexCore.js');
const { indexRegistration } = await import('../src/catalog/indexer.js');
const { findValidListingRevocation, verifyListing } = await import('../src/catalog/listingVerification.js');
const store = await import('../src/catalog/store.js');
const { activeOffer } = await import('../src/catalog/discovery.js');
test.after(() => rmSync(directory, { recursive: true, force: true }));
const at = (n: number) => `stor-${String(n).padStart(40, '0')}`;

test('a standard unsigned tombstone must not leave the listing active', async () => {
  const seed = new Uint8Array(32).fill(41);
  const key = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString('hex');
  const claim = `did:demos:agent:${key}`;
  const sign = (raw: Record<string, unknown>, prefix: string) => ({ algorithm: 'ed25519', signer: claim,
    value: Buffer.from(ed25519Sign(Buffer.from(prefix + contentHash(raw)), privateKeyFromSeed(seed))).toString('base64url') });
  const identityScope = { bundleVersion: '1', presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
  const identity = { ...identityScope, presentation: { kind: 'per-claim', signatures: [{ ref: claim,
    signature: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`), privateKeyFromSeed(seed))).toString('hex') }] } };
  const scope = { dacsVersion: '1', listingVersion: 1, listingId: 'svc', requiredCapabilities: ['SR-2'],
    seller: { displayName: 'Service', identity },
    offering: { title: 'Service', description: 'Service', category: 'services.other', tags: [],
      deliverable: { kind: 'attested-payload', payloadFormat: 'application/json' } },
    buyerRequirement: { requirementVersion: '1', required: [] },
    pipeline: [{ kind: 'negotiate-fixed-price' }, { kind: 'commit-agreement' }, { kind: 'deliver-attested-payload' }],
    pricing: { kind: 'fixed', price: { amount: '1', currency: 'DEM' } },
    terms: {}, validity: { notBefore: 1 } };
  const listing = { ...scope, signature: sign(scope, 'dacs-listing:v1:') };
  const verified = await verifyListing(listing); assert.ok(verified); assert.equal(verified.profile, 'dacs-v0.1');
  const markerScope = { listingId: 'svc', listingVersion: 1, listingContentHash: verified.contentHash, revokedAt: 1 };
  const marker = { ...markerScope, signature: sign(markerScope, 'dacs-revocation:v1:') };
  const binding = await findValidListingRevocation([at(2)], verified, 1, async () => marker); assert.ok(binding);
  const indexRaw = JSON.stringify({ indexVersion: '1', generatedAt: 123, seller: claim, listings: [{ listingId: 'svc', version: 1,
    contentHash: verified.contentHash, anchor: { kind: 'storage-program', locator: at(1) },
    summary: { title: 'Service', category: 'services.other', tags: [] }, status: 'revoked', revocation: binding }] });
  const docs: Record<string, string> = { '/.well-known/agent.json': JSON.stringify({ dacs: { dacsVersion: '1',
    listings: { indexUrl: 'https://seller.example/.well-known/dacs/listings.json', indexHash: `sha256-${sha256Hex(indexRaw)}` } } }),
    '/.well-known/dacs/listings.json': indexRaw };
  const crawled = await crawlDomain('seller.example', { validateUrl: async () => ({} as never), fetchJson: async (url) => {
    const raw = docs[new URL(url).pathname]; return raw ? { raw, body: JSON.parse(raw) } : null;
  } });
  assert.ok(!('error' in crawled));
  const oldFetch = globalThis.fetch;
  let markerReads = 0;
  globalThis.fetch = async (input) => {
    const isMarker = new URL(String(input)).pathname.endsWith(at(2));
    if (isMarker && ++markerReads === 1) return Response.json({ success: false }, { status: 503 });
    return Response.json({ success: true, owner: `0x${key}`, data: isMarker ? marker : listing });
  };
  try {
    await ingestWellKnownRevocations(crawled);
    const reg = { primaryClaim: claim, displayName: 'Service', listingAnchors: [at(1)], deals: [] };
    const indexed = await indexRegistration(reg, undefined, async () => { throw new Error('offline'); });
    assert.equal(indexed.listings.some(activeOffer), false, `unsigned but integrity-consistent revoked record was ignored: ${JSON.stringify(indexed.listings.map(l => l.status))}`);
  } finally { globalThis.fetch = oldFetch; }
  assert.equal(store.hasPendingRevocationCandidates(verified.contentHash), true);
  assert.ok(markerReads >= 2, 'transient unsigned marker is retried within the read budget');
});
