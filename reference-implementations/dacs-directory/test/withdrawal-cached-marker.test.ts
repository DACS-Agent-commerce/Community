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

for (const change of ['scope', 'signature'] as const) {
  for (const response of ['repaired', 'missing', 'unavailable', 'malformed', 'rejected', 'unbound', 'cached-valid'] as const) {
    test(`cached ${change} rejection requires a current marker read (${response})`, async () => {
      const listingId = `cached-${change}-${response}`;
      const domain = `${listingId}.example`;
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

      const stale = response === 'cached-valid' ? marker : change === 'scope' ? { ...marker, revokedAt: 2 }
        : { ...marker, signature: { ...marker.signature, value: Buffer.alloc(64).toString('base64url') } };
      store.recordArtifact({ locator: at(2), kind: 'listing-revocation', profile: 'dacs-v0.1', owner: `0x${key}`,
        observedAt: 1, contentHash: contentHash(stale), data: stale });
      let markerReads = 0;
      let recovered = response === 'repaired' || response === 'unbound';
      const oldFetch = globalThis.fetch;
      globalThis.fetch = async input => {
        if (!String(input).endsWith(at(2))) return Response.json({ success: true, owner: `0x${key}`, data: listing });
        markerReads++;
        if (recovered) return Response.json({ success: true, owner: `0x${key}`, data: marker });
        if (response === 'missing') return Response.json({ success: false, errorCode: 'NOT_FOUND' }, { status: 404 });
        if (response === 'unavailable' || response === 'cached-valid') return Response.json({ success: false }, { status: 503 });
        if (response === 'malformed') return new Response('{');
        return Response.json({ success: true, owner: `0x${key}`, data: stale });
      };
      try {
        const reg = { primaryClaim: claim, displayName: 'Service', listingAnchors: [at(1)], deals: [] };
        const index = () => indexRegistration(reg, undefined, async () => { throw new Error('offline'); });
        if (response === 'unbound') {
          store.admitRevocationCandidates(verified.contentHash, [{ locator: at(2), owner: `0x${key}` }]);
        } else await ingestWellKnownRevocations(await crawl(123, true));
        const indexed = await index();
        assert.equal(markerReads, response === 'cached-valid' ? 0 : 1,
          'every cached rejection needs a current read; verified cached markers survive outages');
        if (response === 'repaired' || response === 'unbound' || response === 'cached-valid') {
          assert.deepEqual(indexed.listings.map(value => value.status), ['revoked']);
          assert.deepEqual(indexed.listings[0].revocation, binding);
          recovered = false;
          assert.equal((await index()).listings[0].status, 'revoked', 'verified marker survives later invalid bytes');
          globalThis.fetch = async input => String(input).endsWith(at(1))
            ? Response.json({ success: true, owner: `0x${key}`, data: listing })
            : Response.json({ success: false }, { status: 503 });
          assert.equal((await index()).listings[0].status, 'revoked', 'retained verification survives a later outage');
        } else if (response === 'rejected') {
          assert.deepEqual(indexed.listings.map(value => value.status), ['active'], 'a current conclusive rejection releases the binding');
          assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, verified.contentHash), false);
        } else {
          assert.equal(indexed.listings.some(activeOffer), false, 'incomplete reads must preserve the hold');
          assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, verified.contentHash), true);
          await ingestWellKnownRevocations(await crawl(124, false));
          const { spawnSync } = await import('node:child_process');
          const restart = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
            import assert from 'node:assert/strict';
            const store = await import('./src/catalog/store.ts');
            assert.equal(store.hasIncompleteWellKnownWithdrawal(${JSON.stringify(claim)}, ${JSON.stringify(verified.contentHash)}), true);
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
          try { assert.equal((await index()).listings[0].status, 'revoked', 'repair is discovered after restart and retry'); }
          finally { Date.now = originalNow; }
        }
      } finally { globalThis.fetch = oldFetch; }
    });
  }
}
