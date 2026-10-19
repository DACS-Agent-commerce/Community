import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { contentHash, sha256Hex } from '../src/catalog/canonical.js';
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from '@kynesyslabs/dacs/crypto';
const directory = mkdtempSync(join(tmpdir(), 'review-unsigned-withdrawal-'));
process.env.DACS_DIRECTORY_DATA = directory;
const { crawlDomain } = await import('../src/catalog/wellknown.js');
const { reindexAll } = await import('../src/catalog/reindexCore.js');
const { findValidListingRevocation, verifyListing } = await import('../src/catalog/listingVerification.js');
const store = await import('../src/catalog/store.js');
const { activeOffer } = await import('../src/catalog/discovery.js');
test.after(() => rmSync(directory, { recursive: true, force: true }));
const at = (n: number) => `stor-${String(n).padStart(40, '0')}`;

for (const domainBound of [false, true]) test(`unsigned tombstone full reindex (endpoint present: ${domainBound})`, async (t) => {
  const seed = new Uint8Array(32).fill(domainBound ? 42 : 41);
  const key = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString('hex');
  const claim = `did:demos:agent:${key}`;
  const sign = (raw: Record<string, unknown>, prefix: string) => ({ algorithm: 'ed25519', signer: claim,
    value: Buffer.from(ed25519Sign(Buffer.from(prefix + contentHash(raw)), privateKeyFromSeed(seed))).toString('base64url') });
  const identityScope = { bundleVersion: '1', presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
  const identity = { ...identityScope, presentation: { kind: 'per-claim', signatures: [{ ref: claim,
    signature: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`), privateKeyFromSeed(seed))).toString('hex') }] } };
  const scope = { dacsVersion: '1', listingVersion: 1, listingId: 'svc', requiredCapabilities: ['SR-2'],
    seller: { displayName: 'Service', identity, ...(domainBound ? { publicEndpoint: 'https://seller.example/a2a' } : {}) },
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
  const crawl = () => crawlDomain('seller.example', { validateUrl: async () => ({} as never), fetchJson: async (url) => {
    const raw = docs[new URL(url).pathname]; return raw ? { raw, body: JSON.parse(raw) } : null;
  } });
  const complete = await crawl(); assert.ok(!('error' in complete));
  let crawled = complete;
  const oldFetch = globalThis.fetch;
  let readable = false;
  globalThis.fetch = async (input, init) => {
    if (init?.body) return Response.json({ result: 200, response: [] });
    const isMarker = new URL(String(input)).pathname.endsWith(at(2));
    if (isMarker && !readable) return Response.json({ success: false, errorCode: 'NOT_FOUND' }, { status: 404 });
    return Response.json({ success: true, owner: `0x${key}`, data: isMarker ? marker : listing });
  };
  try {
    const reg = { primaryClaim: claim, displayName: 'Service', listingAnchors: [at(1)], deals: [] };
    store.saveRegistrations([reg]); store.saveDomains([]);
    const run = () => reindexAll({ log: () => {}, resolveIdentities: async () => { throw new Error('offline'); },
      crawlWellKnown: async () => ({ agents: [crawled], errors: [] }) });
    await run();
    assert.equal(store.loadCatalog().sellers[0].listings.some(activeOffer), true, 'positive control: executable listing is active before discovery');
    const unowned = structuredClone(complete);
    unowned.domain = 'https://attacker.example';
    unowned.incompleteWithdrawalHashes = [verified.contentHash];
    crawled = unowned; store.saveDomains(['attacker.example']);
    await run();
    assert.equal(store.loadCatalog().sellers[0].listings.some(activeOffer), true, 'a different domain cannot authorize pending or incomplete unsigned hints');
    assert.equal(store.hasPendingRevocationCandidates(verified.contentHash), false);
    assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, verified.contentHash), false);
    process.env.DACS_WITHDRAWAL_SOURCE_PINS = JSON.stringify({ 'https://seller.example': claim });
    await run();
    assert.equal(store.loadCatalog().sellers[0].listings.some(activeOffer), true,
      'pinning the seller domain does not authorize an attacker domain for the same seller');
    assert.equal(store.hasPendingRevocationCandidates(verified.contentHash), false);
    assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, verified.contentHash), false);
    crawled = complete;
    store.saveDomains(['seller.example']);
    await run();
    assert.equal(store.loadCatalog().sellers[0].listings.some(activeOffer), false,
      'an operator-pinned source keeps an unread withdrawal indeterminate');
    assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, verified.contentHash), true);
    assert.equal(store.hasPendingRevocationCandidates(verified.contentHash), true);
    if (domainBound) {
      const incomplete = structuredClone(complete);
      incomplete.revocations = [];
      incomplete.incompleteWithdrawalHashes = [verified.contentHash];
      crawled = incomplete;
      await run();
      assert.equal(store.loadCatalog().sellers[0].listings.some(activeOffer), false,
        'a pinned source retains its incomplete check when a binding is malformed');
      assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, verified.contentHash), true);
      crawled = complete;
      await run();
      assert.equal(store.loadCatalog().sellers[0].listings.some(activeOffer), false,
        'source provenance is independent of the optional endpoint');
      assert.equal(store.hasPendingRevocationCandidates(verified.contentHash), true);
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        `const s=await import('./src/catalog/store.ts'); if(!s.hasPendingRevocationCandidates(${JSON.stringify(verified.contentHash)})) process.exit(1); if(s.loadCatalog().sellers[0].listings.length) process.exit(2)`], { encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
    }
    readable = true;
    const now = Date.now(); t.mock.method(Date, 'now', () => now + 2000);
    await run();
    const indexed = store.loadCatalog().sellers[0];
    assert.equal(indexed.listings.length, 1, `expected indexed listing: ${JSON.stringify(indexed)}`);
    assert.equal(indexed.listings.some(activeOffer), false, `unsigned but integrity-consistent revoked record was ignored: ${JSON.stringify(indexed.listings.map(l => l.status))}`);
  } finally { globalThis.fetch = oldFetch; delete process.env.DACS_WITHDRAWAL_SOURCE_PINS; }

});
