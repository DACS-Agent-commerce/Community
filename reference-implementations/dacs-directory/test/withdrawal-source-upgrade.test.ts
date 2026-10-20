import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { contentHash } from '../src/catalog/canonical.js';
const directory = mkdtempSync(join(tmpdir(), 'review-upgrade-hold-'));
process.env.DACS_DIRECTORY_DATA = directory;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/reviewbot-listing-anchor.json', import.meta.url), 'utf8'));
const claim = fixture.data.agentId;
const hash = contentHash(fixture.data);
const db = new Database(join(directory, 'directory.sqlite'));
db.exec(`CREATE TABLE kv_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE revocation_candidates (listing_hash TEXT NOT NULL, locator TEXT NOT NULL, owner TEXT,
content_hash TEXT, seq INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(listing_hash,locator));`);
const put = db.prepare('INSERT INTO kv_state VALUES (?, ?, 0)');
for (const [key, value] of Object.entries({
 'schema-version': 1, 'sr2-anchor-schema-version': 2, 'revocation-read-schema-version': 1,
 'withdrawal-carriage-schema-version': 2,
 'withdrawal-sources': [{domain:'https://seller.example',seller:claim,hashes:[hash],incomplete:[hash],index:{generatedAt:123,hash:'a'.repeat(64)}}],
 'scan-state': {schemaVersion:10,lastSeenTxId:0,listings:{},deals:{}},
 'catalog': {catalogVersion:'1',generatedAt:1,sellers:[{primaryClaim:claim,listings:[{contentHash:hash,status:'active'},{contentHash:'b'.repeat(64),status:'active'}]}]},
 'registrations': [{primaryClaim:claim,displayName:'Service',listingAnchors:[fixture.storageAddress],deals:[]}],
 'domains': ['seller.example']
})) put.run(key, JSON.stringify(value));
db.close();
const store = await import('../src/catalog/store.js');
const {indexRegistration} = await import('../src/catalog/indexer.js');
const {reindexAll} = await import('../src/catalog/reindexCore.js');
const {activeOffer} = await import('../src/catalog/discovery.js');
test.after(() => rmSync(directory,{recursive:true,force:true}));
test('v2 authenticated incomplete source survives upgrade when discovery is unavailable', async () => {
 const original = globalThis.fetch;
 globalThis.fetch = async (_input, init) => init?.body ? Response.json({result:200,response:[]}) : Response.json(fixture);
 try {
  assert.equal(store.hasIncompleteWellKnownWithdrawal(claim,hash),true,'source-only holds survive import');
  assert.deepEqual(store.loadCatalog().sellers[0].listings.map(l=>l.contentHash),['b'.repeat(64)],'only affected active cached rows are withheld');
  const reg = store.loadRegistrations()[0];
  const immediate = await indexRegistration(reg, undefined, async()=>{throw new Error('offline')});
  assert.equal(immediate.listings.some(activeOffer),false,'index-now cannot bypass the source-only upgrade hold');
  await reindexAll({ nodeDeployment: async () => ({ ok: true as const }), log:()=>{},resolveIdentities:async()=>{throw new Error('offline')},
   crawlWellKnown:async()=>({agents:[],errors:[{domain:'seller.example',error:'transport offline'}]})});
  const listings = store.loadCatalog().sellers.flatMap(s=>s.listings);
  assert.equal(listings.some(activeOffer),false,'upgrade plus failed discovery must not turn a prior authenticated incomplete check into an active offer');
  assert.equal(store.hasIncompleteWellKnownWithdrawal(claim,hash),true);
  const restarted = spawnSync(process.execPath, ['--import','tsx','--input-type=module','-e',
    `const s=await import('./src/catalog/store.ts'); if(!s.hasIncompleteWellKnownWithdrawal(${JSON.stringify(claim)},${JSON.stringify(hash)})) process.exit(1); if(s.loadCatalog().sellers.some(seller=>seller.listings.some(l=>l.status==='active'))) process.exit(2);`], {encoding:'utf8'});
  assert.equal(restarted.status,0,restarted.stderr);
  // Failed and unsigned recrawls, missing hashes, and other domains/sellers do not clear it.
  store.recordWellKnownWithdrawalCheck('https://seller.example');
  store.recordWellKnownWithdrawalCheck('https://other.example',claim,[hash],[],{generatedAt:124,hash:'c'.repeat(64)});
  store.recordWellKnownWithdrawalCheck('https://seller.example','did:demos:agent:'+'d'.repeat(64),[hash],[],{generatedAt:124,hash:'c'.repeat(64)});
  store.finishWithdrawalCarriageReplay();
  assert.equal(store.hasIncompleteWellKnownWithdrawal(claim,hash),true);
  store.recordWellKnownWithdrawalCheck('https://seller.example',claim,[],[],{generatedAt:124,hash:'c'.repeat(64)});
  assert.equal(store.hasIncompleteWellKnownWithdrawal(claim,hash),true,'omitting a previously consulted hash cannot claim absence');
  store.recordWellKnownWithdrawalCheck('https://seller.example',claim,[hash],[],{generatedAt:125,hash:'d'.repeat(64)});
  const recovered = await indexRegistration(reg, undefined, async()=>{throw new Error('offline')});
  assert.equal(recovered.listings.some(activeOffer),true,'a successful source-specific check restores active admission');
 } finally { globalThis.fetch = original; }
});
