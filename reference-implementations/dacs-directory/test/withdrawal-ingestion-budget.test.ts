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

for (const mode of ['duplicates', 'continuation'] as const) test(`unsigned discovery read budget: ${mode}`, async () => {
  const seed = new Uint8Array(32).fill(mode === 'duplicates' ? 41 : 42);
  const key = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString('hex');
  const claim = `did:demos:agent:${key}`;
  const sign = (raw: Record<string, unknown>, prefix: string) => ({ algorithm: 'ed25519', signer: claim,
    value: Buffer.from(ed25519Sign(Buffer.from(prefix + contentHash(raw)), privateKeyFromSeed(seed))).toString('base64url') });
  const identityScope = { bundleVersion: '1', presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
  const identity = { ...identityScope, presentation: { kind: 'per-claim', signatures: [{ ref: claim,
    signature: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`), privateKeyFromSeed(seed))).toString('base64url') }] } };
  const scope = { dacsVersion: '1', listingVersion: 1, listingId: 'svc', requiredCapabilities: ['SR-2'],
    seller: { displayName: 'Service', identity },
    offering: { title: 'Service', description: 'Service', category: 'services.other', tags: [],
      deliverable: { kind: 'attested-payload', payloadFormat: 'application/json', verificationMethod: { kind: 'self-signed' } } },
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
  const repeated = JSON.parse(indexRaw);
  repeated.listings = Array.from({length: 200}, (_, i) => {
    const entry = structuredClone(repeated.listings[0]);
    if (mode === 'continuation') entry.revocation.markerAnchor.locator = at(1000 + i);
    return entry;
  });
  const repeatedRaw = JSON.stringify(repeated);
  const docs: Record<string, string> = { '/.well-known/agent.json': JSON.stringify({ dacs: { dacsVersion: '1',
    listings: { indexUrl: 'https://seller.example/.well-known/dacs/listings.json', indexHash: `sha256-${sha256Hex(repeatedRaw)}` } } }),
    '/.well-known/dacs/listings.json': repeatedRaw };
  const crawled = await crawlDomain('seller.example', { validateUrl: async () => ({} as never), fetchJson: async (url) => {
    const raw = docs[new URL(url).pathname]; return raw ? { raw, body: JSON.parse(raw) } : null;
  } });
  assert.ok(!('error' in crawled));
  const oldFetch = globalThis.fetch;
  let markerReads = 0, listingReads = 0;
  const markers = new Set<string>();
  globalThis.fetch = async (input) => {
    const locator = new URL(String(input)).pathname.split('/').pop()!;
    if (locator !== at(1)) {
      markers.add(locator);
      markerReads++; return Response.json({ success: false, errorCode: 'NOT_FOUND' }, { status: 404 });
    }
    listingReads++; return Response.json({ success: true, owner: `0x${key}`, data: listing });
  };
  try {
    await ingestWellKnownRevocations(crawled);
    const limit = 32;
    assert.ok(listingReads + markerReads <= limit);
    assert.equal(listingReads, 1, 'listing is read once for all bindings');
    if (mode === 'duplicates') {
      assert.equal(crawled.listingAnchors.length, 1);
      assert.equal(crawled.revocations.length, 1);
      assert.equal(markerReads, 1, '200 duplicate entries require one marker read');
    } else {
      assert.equal(markers.size, limit - 1);
      const { spawnSync } = await import('node:child_process');
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        `const s=await import('./src/catalog/store.ts'); if(s.loadWithdrawalCursor(${JSON.stringify(crawled.domain)},${JSON.stringify(claim)},${JSON.stringify(crawled.withdrawalIndex!.hash)})!==${limit-1}) process.exit(1)`], { encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      for (let pass = 0; pass < 6; pass++) {
        listingReads = 0; markerReads = 0;
        await ingestWellKnownRevocations(crawled);
        assert.ok(listingReads + markerReads <= limit, 'each continuation obeys the budget');
      }
      assert.equal(markers.size, 200, 'continuation eventually examines every unique marker');
      assert.equal(store.hasPendingRevocationCandidates(verified.contentHash), false,
        'unread unsigned hints never acquire seller authority');
    }
  } finally { globalThis.fetch = oldFetch; }
});
