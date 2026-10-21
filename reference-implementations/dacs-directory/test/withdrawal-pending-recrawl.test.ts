import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { contentHash, sha256Hex } from '../src/catalog/canonical.js';
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from '@kynesyslabs/dacs/crypto';
const directory = mkdtempSync(join(tmpdir(), 'dacs-pending-withdrawal-'));
process.env.DACS_DIRECTORY_DATA = directory;
const { crawlDomain, wellKnownWithdrawalMessage } = await import('../src/catalog/wellknown.js');
const { ingestWellKnownRevocations } = await import('../src/catalog/reindexCore.js');
const { indexRegistration } = await import('../src/catalog/indexer.js');
const { findValidListingRevocation, verifyListing } = await import('../src/catalog/listingVerification.js');
const store = await import('../src/catalog/store.js');
const { activeOffer } = await import('../src/catalog/discovery.js');
test.after(() => rmSync(directory, { recursive: true, force: true }));
const at = (n: number) => `stor-${String(n).padStart(40, '0')}`;

for (const resolution of ['revoked', 'rejected', 'replaced'] as const) test(`newer signed active recrawls preserve pending withdrawal through restart (${resolution})`, async () => {
  const listingId = `svc-${resolution}`;
  const domain = `seller-${resolution}.example`;
  const seed = new Uint8Array(32).fill(41);
  const key = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString('hex');
  const claim = `did:demos:agent:${key}`;
  const sign = (raw: Record<string, unknown>, prefix: string) => ({ algorithm: 'ed25519', signer: claim,
    value: Buffer.from(ed25519Sign(Buffer.from(prefix + contentHash(raw)), privateKeyFromSeed(seed))).toString('base64url') });
  const identityScope = { bundleVersion: '1', presentedBy: claim, presentedAt: 1, claims: [{ ref: claim }] };
  const identity = { ...identityScope, presentation: { kind: 'per-claim', signatures: [{ ref: claim,
    signature: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-presentation:v1:${contentHash(identityScope)}`), privateKeyFromSeed(seed))).toString('hex') }] } };
  const scope = { dacsVersion: '1', listingVersion: 1, listingId, requiredCapabilities: ['SR-2'],
    seller: { displayName: 'Service', identity },
    offering: { title: 'Service', description: 'Service', category: 'services.other', tags: [],
      deliverable: { kind: 'attested-payload', payloadFormat: 'application/json' } },
    buyerRequirement: { requirementVersion: '1', required: [] },
    pipeline: [{ kind: 'negotiate-fixed-price' }, { kind: 'commit-agreement' }, { kind: 'deliver-attested-payload' }],
    pricing: { kind: 'fixed', price: { amount: '1', currency: 'DEM' } },
    terms: {}, validity: { notBefore: 1 } };
  const listing = { ...scope, signature: sign(scope, 'dacs-listing:v1:') };
  const verified = await verifyListing(listing); assert.ok(verified); assert.equal(verified.profile, 'dacs-v0.1');
  const markerScope = { listingId, listingVersion: 1, listingContentHash: verified.contentHash, revokedAt: 1 };
  const marker = { ...markerScope, signature: sign(markerScope, 'dacs-revocation:v1:') };
  const binding = await findValidListingRevocation([at(2)], verified, 1, async () => marker); assert.ok(binding);
  async function crawl(generatedAt: number, revoked: boolean) {
    const indexRaw = JSON.stringify({ indexVersion: '1', generatedAt, seller: claim, listings: [{ listingId, version: 1,
      contentHash: verified!.contentHash, anchor: { kind: 'storage-program', locator: at(1) },
      summary: { title: 'Service', category: 'services.other', tags: [] }, status: revoked ? 'revoked' : 'active',
      ...(revoked ? { revocation: binding } : {}) }] });
    const card = { dacs: { dacsVersion: '1', listings: {
      indexUrl: `https://${domain}/.well-known/dacs/listings.json`, indexHash: `sha256-${sha256Hex(indexRaw)}`,
      publisherSignature: Buffer.from(ed25519Sign(Buffer.from(wellKnownWithdrawalMessage(domain, sha256Hex(indexRaw))),
        privateKeyFromSeed(seed))).toString('base64url'),
    } } };
    const crawled = await crawlDomain(domain, { validateUrl: async () => ({} as never), fetchJson: async (url) => {
      const raw = new URL(url).pathname === '/.well-known/agent.json' ? JSON.stringify(card) : indexRaw;
      return { raw, body: JSON.parse(raw) };
    } });
    assert.ok(!('error' in crawled));
    assert.equal(crawled.withdrawalAuthenticated, true);
    return crawled;
  }
  const oldFetch = globalThis.fetch;
  let recovered = false;
  globalThis.fetch = async (input) => {
    const isMarker = new URL(String(input)).pathname.endsWith(at(2));
    return isMarker && !recovered ? Response.json({ success: false }, { status: 503 })
      : Response.json({ success: true, owner: `0x${key}`, data: isMarker ? (resolution === 'revoked' ? marker : { ...marker, revokedAt: 2 }) : listing });
  };
  try {
    const reg = { primaryClaim: claim, displayName: 'Service', listingAnchors: [at(1)], deals: [] };
    const index = () => indexRegistration(reg, undefined, async () => { throw new Error('offline'); });
    await ingestWellKnownRevocations(await crawl(123, true));
    assert.equal((await index()).listings.some(activeOffer), false, 'initial unread binding withholds offer');
    for (const generatedAt of [124, 125, 125]) {
      await ingestWellKnownRevocations(await crawl(generatedAt, false));
      assert.equal((await index()).listings.some(activeOffer), false, 'newer or repeated active advertisement cannot clear unread binding');
    }
    const { spawnSync } = await import('node:child_process');
    const restart = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const store = await import('./src/catalog/store.ts');
      assert.equal(store.boundWellKnownRevocations(${JSON.stringify(claim)}, ${JSON.stringify(verified.contentHash)}, ${JSON.stringify(listingId)}, 1).length, 1);
      const { indexRegistration } = await import('./src/catalog/indexer.ts');
      globalThis.fetch = async input => String(input).endsWith(${JSON.stringify(at(1))})
        ? Response.json({success:true, owner:${JSON.stringify(`0x${key}`)}, data:${JSON.stringify(listing)}})
        : Response.json({success:false}, {status:503});
      const indexed = await indexRegistration(${JSON.stringify(reg)}, undefined, async () => {throw new Error('offline')});
      assert.equal(indexed.listings.length, 0);
    `], { encoding: 'utf8', env: process.env });
    assert.equal(restart.status, 0, restart.stderr);
    recovered = true;
    const originalNow = Date.now;
    Date.now = () => originalNow() + 120_000;
    try {
      const indexed = await index();
      assert.equal(indexed.listings.length, 1);
      assert.equal(indexed.listings[0].status, resolution === 'revoked' ? 'revoked' : 'active', 'only successful marker adjudication resolves the hold');
      if (resolution === 'revoked') {
        assert.deepEqual(indexed.listings[0].revocation, binding);
        recovered = false;
        await ingestWellKnownRevocations(await crawl(126, false));
        assert.equal((await index()).listings[0].status, 'revoked', 'a later outage and active advertisement retain verified revocation');
      } else {
        assert.equal(store.boundWellKnownRevocations(claim, verified.contentHash, listingId, 1).length, 0);
        if (resolution === 'replaced') {
          // The same locator can later hold the correctly signed marker. A
          // fresh authenticated binding must re-read rather than trust rejection.
          globalThis.fetch = async input => Response.json({ success: true, owner: `0x${key}`,
            data: String(input).endsWith(at(2)) ? marker : listing });
          await ingestWellKnownRevocations(await crawl(126, true));
          assert.equal((await index()).listings[0].status, 'revoked');
        }
      }
    } finally { Date.now = originalNow; }
  } finally { globalThis.fetch = oldFetch; }
});

test('each authenticated source and marker retains its own unresolved hold', () => {
  const seller = `did:demos:agent:${'7'.repeat(64)}`;
  const hash = 'e'.repeat(64);
  const first = { sellerPrimaryClaim: seller, listingId: 'multiple', listingVersion: 1, listingContentHash: hash,
    logicalAddress: `dacs1-revoked:${seller.replaceAll(':', '%3A')}:multiple:v1`,
    markerAnchor: { kind: 'storage-program' as const, locator: at(31) }, markerContentHash: 'a'.repeat(64) };
  const second = { ...first, markerAnchor: { ...first.markerAnchor, locator: at(32) } };
  const third = { ...first, markerAnchor: { ...first.markerAnchor, locator: at(33) } };
  const index = (generatedAt: number) => ({ generatedAt, hash: String(generatedAt).repeat(64).slice(0, 64) });
  store.recordWellKnownWithdrawalCheck('https://first.example', seller, [hash], [], index(1), [first, second]);
  store.recordWellKnownWithdrawalCheck('https://second.example', seller, [hash], [], index(1), [third], 'operator-pin');
  for (const domain of ['https://first.example', 'https://second.example']) {
    store.recordWellKnownWithdrawalCheck(domain, seller, [hash], [], index(2), []);
  }
  assert.equal(store.boundWellKnownRevocations(seller, hash, 'multiple', 1).length, 3);
  store.admitWellKnownRevocationCandidates(hash, [at(31), at(32), at(33)]);
  store.recordRevocationProgress(hash, { rejected: [at(31)], unread: [at(32), at(33)] }, [first, second, third], store.wellKnownWithdrawalRevision());
  assert.equal(store.boundWellKnownRevocations(seller, hash, 'multiple', 1).length, 2);
  assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), true);
  store.recordRevocationProgress(hash, { rejected: [at(32)], unread: [] }, [second, third], store.wellKnownWithdrawalRevision());
  assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), true, 'other authenticated source is still unresolved');
  store.recordRevocationProgress(hash, { rejected: [at(33)], unread: [] }, [third], store.wellKnownWithdrawalRevision());
  assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), false, 'only conclusive rejection of every marker releases the listing');
});


for (const sameScope of [false, true]) test(`a slow rejection cannot clear a newer marker advertisement (same scope: ${sameScope})`, () => {
  const seller = `did:demos:agent:${'8'.repeat(64)}`;
  const hash = (sameScope ? 'c' : 'd').repeat(64);
  const binding = { sellerPrimaryClaim: seller, listingId: 'slow', listingVersion: 1, listingContentHash: hash,
    logicalAddress: `dacs1-revoked:${seller.replaceAll(':', '%3A')}:slow:v1`,
    markerAnchor: { kind: 'storage-program' as const, locator: at(sameScope ? 41 : 40) }, markerContentHash: 'a'.repeat(64) };
  const newer = { ...binding, markerContentHash: (sameScope ? 'a' : 'b').repeat(64) };
  const domain = `https://slow-${sameScope}.example`;
  store.recordWellKnownWithdrawalCheck(domain, seller, [hash], [], { generatedAt: 1, hash: 'a'.repeat(64) }, [binding]);
  store.admitWellKnownRevocationCandidates(hash, [binding.markerAnchor.locator]);
  const revision = store.wellKnownWithdrawalRevision();
  const snapshot = store.boundWellKnownRevocations(seller, hash, 'slow', 1);
  store.recordWellKnownWithdrawalCheck(domain, seller, [hash], [], { generatedAt: 2, hash: 'b'.repeat(64) }, [newer]);
  store.recordRevocationProgress(hash, { rejected: [binding.markerAnchor.locator], unread: [] }, snapshot, revision);
  assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), true);
  assert.ok(store.boundWellKnownRevocations(seller, hash, 'slow', 1).some(value => value.markerContentHash === newer.markerContentHash));
  store.admitWellKnownRevocationCandidates(hash, [binding.markerAnchor.locator]);
  assert.equal(store.hasPendingRevocationCandidates(hash), true, 'new advertisement must get its own marker read');
  const current = store.boundWellKnownRevocations(seller, hash, 'slow', 1);
  store.recordRevocationProgress(hash, { rejected: [binding.markerAnchor.locator], unread: [] }, current, store.wellKnownWithdrawalRevision());
  assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), false, 'a current conclusive rejection resolves the hold');
});
