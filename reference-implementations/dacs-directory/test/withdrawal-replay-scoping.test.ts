import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
const directory = mkdtempSync(join(tmpdir(), 'review-global-upgrade-'));
process.env.DACS_DIRECTORY_DATA = directory;
const seller = `did:demos:agent:${'a'.repeat(64)}`;
const unrelated = `did:demos:agent:${'b'.repeat(64)}`;
const hash = 'c'.repeat(64);
const unrelatedHash = 'd'.repeat(64);
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
    'registrations': [], 'domains': ['seller.example']
}))
    put.run(key, JSON.stringify(value));
db.prepare("INSERT INTO revocation_candidates VALUES (?,?,NULL,NULL,1,'pending')")
    .run(hash, `stor-${'e'.repeat(40)}`);
db.close();
const store = await import('../src/catalog/store.js');
test.after(() => rmSync(directory, { recursive: true, force: true }));
test('successful chain replay cannot let one legacy source block unrelated sellers globally', () => {
    assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), true);
    assert.equal(store.hasIncompleteWellKnownWithdrawal(unrelated, unrelatedHash), false, 'migration only quarantines affected hashes');
    assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, unrelatedHash), false, 'other hashes of the affected seller remain available');
    assert.equal(store.hasIncompleteWellKnownWithdrawal(unrelated, hash), true, 'an ambiguous candidate retains its hash hold without seller metadata');
    store.finishWithdrawalCarriageReplay();
    assert.equal(store.hasIncompleteWellKnownWithdrawal(unrelated, unrelatedHash), false);
    assert.equal(store.hasIncompleteWellKnownWithdrawal(unrelated, hash), false, 'chain replay releases the ambiguous hash hold');
    assert.equal(store.hasIncompleteWellKnownWithdrawal(seller, hash), true);
    // Databases already migrated by v4 retained only a global flag. It must also
    // clear after replay, including when a legacy source survives a restart.
    const persisted = new Database(join(directory, 'directory.sqlite'));
    persisted.prepare("INSERT OR REPLACE INTO kv_state VALUES ('withdrawal-carriage-replay-required','true',0)").run();
    persisted.close();
    const restarted = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        `const s=await import('./src/catalog/store.ts');
   if(!s.hasIncompleteWellKnownWithdrawal(${JSON.stringify(unrelated)},${JSON.stringify(unrelatedHash)})) process.exit(1);
   s.finishWithdrawalCarriageReplay();
   if(s.hasIncompleteWellKnownWithdrawal(${JSON.stringify(unrelated)},${JSON.stringify(unrelatedHash)})) process.exit(2);
   if(!s.hasIncompleteWellKnownWithdrawal(${JSON.stringify(seller)},${JSON.stringify(hash)})) process.exit(3);`], { encoding: 'utf8' });
    assert.equal(restarted.status, 0, restarted.stderr);
});
