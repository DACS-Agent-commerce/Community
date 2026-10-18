import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { contentHash } from '../src/catalog/canonical.js';
const directory = mkdtempSync(join(tmpdir(), 'review-unrelated-hold-'));
process.env.DACS_DIRECTORY_DATA = directory;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/reviewbot-listing-anchor.json', import.meta.url), 'utf8'));
const seller = fixture.data.agentId, hash = contentHash(fixture.data);
const legacySeller = 'did:demos:agent:' + 'b'.repeat(64), legacyHash = 'c'.repeat(64);
const db = new Database(join(directory, 'directory.sqlite'));
db.exec(`CREATE TABLE kv_state (key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE revocation_candidates (listing_hash TEXT NOT NULL,locator TEXT NOT NULL,owner TEXT,content_hash TEXT,seq INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(listing_hash,locator));`);
const put = db.prepare('INSERT INTO kv_state VALUES (?,?,0)');
for (const [key, value] of Object.entries({
    'schema-version': 1, 'sr2-anchor-schema-version': 2, 'revocation-read-schema-version': 1, 'withdrawal-carriage-schema-version': 2,
    'withdrawal-sources': [{ domain: 'https://legacy.example', seller: legacySeller, hashes: [legacyHash], incomplete: [legacyHash], index: { generatedAt: 1, hash: 'd'.repeat(64) } }],
    'scan-state': { schemaVersion: 10, lastSeenTxId: 0, listings: {}, deals: {} },
    'catalog': { catalogVersion: '1', generatedAt: 1, sellers: [] },
    'registrations': [{ primaryClaim: seller, displayName: 'Healthy seller', listingAnchors: [fixture.storageAddress], deals: [] }],
    'domains': ['legacy.example']
}))
    put.run(key, JSON.stringify(value));
db.prepare('INSERT INTO revocation_candidates VALUES (?,?,NULL,NULL,1,\'pending\')').run(legacyHash, 'stor-' + 'e'.repeat(40));
db.close();
const store = await import('../src/catalog/store.js');
const { reindexAll } = await import('../src/catalog/reindexCore.js');
const { activeOffer } = await import('../src/catalog/discovery.js');
test.after(() => rmSync(directory, { recursive: true, force: true }));
test('completed replay releases unrelated seller while preserving legacy seller quarantine', async () => {
    const original = globalThis.fetch;
    try {
        globalThis.fetch = async () => { throw new Error('chain unavailable'); };
        await assert.rejects(reindexAll({ log: () => { }, crawlWellKnown: async () => { throw new Error('crawl must follow chain replay'); } }), /chain scan failed/);
        assert.equal(store.loadScanState().schemaVersion, 0, 'an incomplete chain replay must be retried from genesis');
        assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, legacyHash), true, 'failed chain replay retains ambiguous hash holds');
        globalThis.fetch = async (_input, init) => init?.body ? Response.json({ result: 200, response: [] }) : Response.json(fixture);
        await reindexAll({ log: () => { }, resolveIdentities: async () => { throw new Error('offline'); },
            crawlWellKnown: async () => ({ agents: [{ domain: 'https://legacy.example', seller: legacySeller, listingAnchors: [], contentHashes: {}, revocations: [], bundleBindings: [], withdrawalAuthenticated: false, withdrawalHashes: [legacyHash], incompleteWithdrawalHashes: [legacyHash], withdrawalIndex: { generatedAt: 2, hash: 'f'.repeat(64) } }], errors: [] }) });
        const rows = store.loadCatalog().sellers.find(s => s.primaryClaim === seller)?.listings ?? [];
        assert.equal(rows.some(activeOffer), true, `unrelated seller withheld: incomplete=${store.hasIncompleteWellKnownWithdrawal(seller, hash)} rows=${JSON.stringify(rows)}`);
        assert.equal(store.hasIncompleteWellKnownWithdrawal(legacySeller, legacyHash), true, 'legacy source quarantine survives successful chain replay');
        assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, legacyHash), false, 'successful chain replay releases only the ambiguous hash hold');
    }
    finally {
        globalThis.fetch = original;
    }
});
