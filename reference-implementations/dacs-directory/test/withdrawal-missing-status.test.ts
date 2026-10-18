import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { contentHash, sha256Hex } from '../src/catalog/canonical.js';
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from '@kynesyslabs/dacs/crypto';
const directory = mkdtempSync(join(tmpdir(), 'dacs-withdrawal-status-'));
process.env.DACS_DIRECTORY_DATA = directory;
const { crawlDomain, wellKnownWithdrawalMessage } = await import('../src/catalog/wellknown.js');
const { verifyListing } = await import('../src/catalog/listingVerification.js');
const store = await import('../src/catalog/store.js');
const { activeOffer } = await import('../src/catalog/discovery.js');
test.after(() => rmSync(directory, { recursive: true, force: true }));
const at = (n: number) => `stor-${String(n).padStart(40, '0')}`;

test('a newer signed index without status cannot clear an authenticated incomplete withdrawal', async () => {
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
  store.saveRegistrations([{ primaryClaim: claim, displayName: 'Service', listingAnchors: [at(1)] }]);
  store.saveDomains(['seller.example']);
  const { reindexAll } = await import('../src/catalog/reindexCore.js');
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => init?.body ? Response.json({ result: 200, response: [] })
    : Response.json({ success: true, owner: `0x${key}`, data: listing });
  try {
    for (const [n, status, expectedActive] of [[1, 'revoked', false], [2, undefined, false], [3, 'invalid', false], [4, 'active', true]] as const) {
      const raw = JSON.stringify({ indexVersion: '1', generatedAt: n, seller: claim, listings: [{
        listingId: 'svc', version: 1, contentHash: verified.contentHash,
        anchor: { kind: 'storage-program', locator: at(1) }, ...(status ? { status } : {}),
      }] });
      const card = JSON.stringify({ dacs: { dacsVersion: '1', listings: {
        indexUrl: 'https://seller.example/listings.json', indexHash: `sha256-${sha256Hex(raw)}`,
        publisherSignature: Buffer.from(ed25519Sign(Buffer.from(wellKnownWithdrawalMessage('seller.example', sha256Hex(raw))), privateKeyFromSeed(seed))).toString('base64url'),
      } } });
      const agent = await crawlDomain('seller.example', { validateUrl: async () => ({} as never), fetchJson: async url => {
        const body = url.endsWith('agent.json') ? card : raw; return { raw: body, body: JSON.parse(body) };
      } });
      assert.ok(!('error' in agent)); assert.equal(agent.withdrawalAuthenticated, true);
      await reindexAll({ log: () => {}, resolveIdentities: async () => { throw new Error('offline'); },
        crawlWellKnown: async () => ({ agents: [agent], errors: [] }) });
      assert.equal(store.loadCatalog().sellers.flatMap(s => s.listings).some(activeOffer), expectedActive, `status=${status}`);
      assert.equal(store.hasIncompleteWellKnownWithdrawal(claim, verified.contentHash), !expectedActive, `status=${status}`);
    }
  } finally { globalThis.fetch = original; }
});
