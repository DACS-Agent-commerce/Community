import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { contentHash } from '../src/catalog/canonical.js';
const directory = mkdtempSync(join(tmpdir(), 'review-legacy-rollback-'));
process.env.DACS_DIRECTORY_DATA = directory;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/reviewbot-listing-anchor.json', import.meta.url), 'utf8'));
const seller = fixture.data.agentId;
const hash = contentHash(fixture.data);
const db = new Database(join(directory, 'directory.sqlite'));
db.exec(`CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE revocation_candidates (listing_hash TEXT NOT NULL, locator TEXT NOT NULL, owner TEXT,
content_hash TEXT, seq INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(listing_hash,locator));`);
const put = db.prepare('INSERT INTO kv_state VALUES (?, ?, 0)');
for (const [key, value] of Object.entries({
    'schema-version': 1, 'sr2-anchor-schema-version': 2, 'revocation-read-schema-version': 1,
    'withdrawal-carriage-schema-version': 2,
    'withdrawal-sources': [{ domain: 'https://seller.example', seller, hashes: [hash], incomplete: [hash], index: { generatedAt: 200, hash: 'a'.repeat(64) } }],
    'scan-state': { schemaVersion: 10, lastSeenTxId: 0, listings: {}, deals: {} },
    'catalog': { catalogVersion: '1', generatedAt: 1, sellers: [] },
    'registrations': [{ primaryClaim: seller, displayName: 'Service', listingAnchors: [fixture.storageAddress], deals: [] }],
    'domains': ['seller.example']
}))
    put.run(key, JSON.stringify(value));
db.close();
const store = await import('../src/catalog/store.js');
const { indexRegistration } = await import('../src/catalog/indexer.js');
const { activeOffer } = await import('../src/catalog/discovery.js');
test.after(() => rmSync(directory, { recursive: true, force: true }));
test('an older authenticated index cannot release a migrated incomplete check', async () => {
    assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), true);
    for (const provenance of ['publisher-signature', 'operator-pin'] as const) {
        for (const generatedAt of [100, 200]) {
            const accepted = store.recordWellKnownWithdrawalCheck('https://seller.example', seller, [hash], [], { generatedAt, hash: 'b'.repeat(64) }, [], provenance);
            assert.equal(accepted, false, `${provenance}: rollback and same-time index substitution must be rejected`);
        }
    }
    assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), true);
    const original = globalThis.fetch;
    globalThis.fetch = async (_input, init) => init?.body ? Response.json({ result: 200, response: [] }) : Response.json(fixture);
    try {
        const indexed = await indexRegistration(store.loadRegistrations()[0], undefined, async () => { throw new Error('offline'); });
        assert.equal(indexed.listings.some(activeOffer), false, 'older active index must not republish offer');
        assert.equal(store.recordWellKnownWithdrawalCheck('https://seller.example', seller, [hash], [], { generatedAt: 201, hash: 'c'.repeat(64) }, [], 'publisher-signature'), true, 'a newer authenticated index can reconcile the source');
        assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), false);
        const recovered = await indexRegistration(store.loadRegistrations()[0], undefined, async () => { throw new Error('offline'); });
        assert.equal(recovered.listings.some(activeOffer), true, 'positive control: current authenticated checks restore the valid offer');
    }
    finally {
        globalThis.fetch = original;
    }
});
