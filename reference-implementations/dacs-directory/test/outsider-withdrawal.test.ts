import assert from 'node:assert/strict';
import { onPinnedChain } from './fixtures/pinned-node.js';
import test from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = mkdtempSync(join(tmpdir(), 'dacs-outsider-markers-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
process.env.DACS_DIRECTORY_DATA = scratch;
process.env.DACS_SCAN_FINALITY_DEPTH = '0';
const { contentHash } = await import('../src/catalog/canonical.js');
const { reindexAll } = await import('../src/catalog/reindexCore.js');
const store = await import('../src/catalog/store.js');
const listing = JSON.parse(readFileSync(new URL('./fixtures/reviewbot-listing-anchor.json', import.meta.url), 'utf8'));
const hash = contentHash(listing.data);
const attacker = `0x${'a'.repeat(64)}`;
const markerAddresses = Array.from({length: 17}, (_, i) => `stor-${(i + 700).toString(16).padStart(40, '0')}`);
const hidden = new Set<string>();
const fakeMarker = { listingId: listing.data.serviceId, listingVersion: 1,
  listingContentHash: hash, revokedAt: 1,
  signature: { algorithm: 'ed25519', signer: `did:demos:agent:${attacker.slice(2)}`, value: 'bogus' } };
let discover = true;
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (init?.body) {
    const call = JSON.parse(String(init.body)).params[0];
    const response = discover && call.message === 'getTransactions' && call.data.start === 'latest'
      ? [{ id: 1, status: 'confirmed', type: 'transfer', content: JSON.stringify({ memo: markerAddresses }) }] : [];
    return Response.json({ result: 200, response });
  }
  if (path.endsWith(listing.storageAddress)) return Response.json(listing);
  if (markerAddresses.some(at => path.endsWith(at))) {
    if (![...hidden].some(at => path.endsWith(at))) return Response.json({ success: true, owner: attacker, programName: 'outsider', data: fakeMarker });
    return Response.json({ success: false, errorCode: 'PERMISSION_DENIED' }, { status: 403 });
  }
  throw new Error(`unexpected read ${path}`);
};
store.saveRegistrations([{ primaryClaim: listing.data.agentId, displayName: 'ReviewBot', listingAnchors: [listing.storageAddress] }]);
const run = () => reindexAll({ nodeDeployment: onPinnedChain, log: () => {}, resolveIdentities: async () => { throw new Error('no authentication'); } });
await run();
const pass1 = store.loadCatalog().sellers.flatMap(s => s.listings).map(l => l.status);
const pendingAfterFirst = store.nextRevocationCandidates(hash, null, 32);
pendingAfterFirst.forEach((at: string) => hidden.add(at));
discover = false;
await run();
const pass2 = store.loadCatalog().sellers.flatMap(s => s.listings).map(l => l.status);
test('17 bogus outsider markers followed by an ACL change cannot suppress a verified offer', () => {
  assert.equal(pendingAfterFirst.length, 1, "the attack hides an unexamined marker between passes");
  assert.deepEqual(pass1, ['active']);
  assert.deepEqual(pass2, ['active']);
  assert.equal(store.hasIncompleteWellKnownWithdrawal(listing.data.agentId, hash), false);
});
