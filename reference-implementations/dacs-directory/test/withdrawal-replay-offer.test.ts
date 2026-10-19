import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { contentHash } from '../src/catalog/canonical.js';
const directory = mkdtempSync(join(tmpdir(), 'review-global-offer-'));
process.env.DACS_DIRECTORY_DATA = directory;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/reviewbot-listing-anchor.json', import.meta.url), 'utf8'));
const unrelated = fixture.data.agentId;
const seller = `did:demos:agent:${'a'.repeat(64)}`;
const hash = 'c'.repeat(64);
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
    'registrations': [{ primaryClaim: unrelated, displayName: 'Other service', listingAnchors: [fixture.storageAddress], deals: [] }],
    'domains': []
}))
    put.run(key, JSON.stringify(value));
db.prepare("INSERT INTO revocation_candidates VALUES (?,?,NULL,NULL,1,'pending')")
    .run(hash, `stor-${'e'.repeat(40)}`);
db.close();
const store = await import('../src/catalog/store.js');
const { indexRegistration } = await import('../src/catalog/indexer.js');
const { activeOffer } = await import('../src/catalog/discovery.js');
test.after(() => rmSync(directory, { recursive: true, force: true }));
test('a legacy source for seller A cannot suppress seller B after chain replay', async () => {
    assert.notEqual(unrelated, seller);
    store.finishWithdrawalCarriageReplay();
    const original = globalThis.fetch;
    globalThis.fetch = async (_input, init) => init?.body ? Response.json({ result: 200, response: [] }) : Response.json(fixture);
    try {
        const indexed = await indexRegistration(store.loadRegistrations()[0], undefined, async () => { throw new Error('offline'); });
        assert.equal(indexed.listings.some(activeOffer), true, 'unrelated signed listing should remain executable');
    }
    finally {
        globalThis.fetch = original;
    }
});
