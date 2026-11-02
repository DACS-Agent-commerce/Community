import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {onPinnedChain} from './fixtures/pinned-node.js';
import {PINNED_DEMOS_CHAIN_IDENTITY} from '../src/catalog/nodeDeployment.js';
import {contentHash} from '@kynesyslabs/dacs/canonical';
import {ed25519Sign,privateKeyFromSeed,publicKeyFromSeed,rawPublicKey} from '@kynesyslabs/dacs/crypto';
const root=mkdtempSync(join(tmpdir(),'directory-progress-'));
process.env.DACS_DIRECTORY_DATA=root;
const store=await import('../src/catalog/store.js');
const {indexRegistration}=await import('../src/catalog/indexer.js');
const {seedScanState}=await import('./fixtures/chain-state.js');
const seed=new Uint8Array(32).fill(31); // deterministic public TEST ONLY key
const key=privateKeyFromSeed(seed);
const claim='did:demos:agent:'+Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString('hex');
const anchor='stor-'+'a'.repeat(40);
let seq=0;
async function fixture(){
 const scope={listingId:'freshness-'+(++seq),listingVersion:1,agentId:claim,serviceId:'freshness',name:'fixture',description:'public synthetic',claimRequirements:[],supportedNegotiation:['negotiate-fixed-price'],supportedPaymentRails:['pay-dem'],supportedDelivery:['deliver-attested-payload']};
 async function sign(body:Record<string,unknown>,domain:string){return {...body,signature:{algorithm:'ed25519',signer:claim,value:Buffer.from(await ed25519Sign(Buffer.from(domain+contentHash(body)),key)).toString(domain==='dacs-revocation:v1:'?'base64url':'hex')}};}
 const listing=await sign(scope,'dacs-listing:v1:');
 const marker=await sign({listingId:scope.listingId,listingVersion:1,listingContentHash:contentHash(scope),revokedAt:1},'dacs-revocation:v1:');
 const hash=contentHash(scope);
 const refs=(count:number)=>Array.from({length:count},()=> 'stor-'+(++seq).toString(16).padStart(40,'0'));
 const candidate=(count:number)=>{const r=refs(count);store.admitRevocationCandidates(hash,r.map(locator=>({locator,owner:'0x'+'c'.repeat(64)})));return r;};
 async function index(records:Map<string,unknown>,prior?:Parameters<typeof indexRegistration>[1]){
  const old=globalThis.fetch;
  globalThis.fetch=async input=>{const locator=String(input).split('/').at(-1)!;
   if(locator===anchor)return Response.json({success:true,owner:'0x'+claim.slice(-64),data:listing});
   if(!records.has(locator))return new Response('',{status:503});
   return Response.json({success:true,owner:'0x'+claim.slice(-64),data:records.get(locator)});
  };
  try{return await indexRegistration({primaryClaim:claim,displayName:'fixture',listingAnchors:[anchor]},prior,async()=>({}));}finally{globalThis.fetch=old;}
 }
 return {scope,listing,marker,hash,candidate,index};
}
test.after(()=>rmSync(root,{recursive:true,force:true}));
test('unread raw candidate exposes incomplete coverage without granting withdrawal authority',async()=>{
 const f=await fixture();const before=await f.index(new Map());assert.equal(before.listings[0]?.revocationCoverage,'complete');
 f.candidate(1);const after=await f.index(new Map(),before);
 assert.equal(after.listings[0]?.status,'active');assert.equal(after.listings[0]?.revocationCoverage,'incomplete');
 assert.equal(after.listings[0]?.lastVerifiedAt,before.listings[0]?.lastVerifiedAt);
});
test('first incomplete check has unknown prior verification time',async()=>{
 const f=await fixture();f.candidate(1);const after=await f.index(new Map());
 assert.equal(after.listings[0]?.revocationCoverage,'incomplete');assert.equal(after.listings[0]?.lastVerifiedAt,null);
});
test('complete positive records verification time',async()=>{
 const f=await fixture();const row=(await f.index(new Map())).listings[0]!;
 assert.equal(row.status,'active');assert.equal(row.revocationCoverage,'complete');assert.equal(typeof row.lastVerifiedAt,'number');
});
test('candidate overflow remains incomplete until remaining candidates are checked',async()=>{
 const f=await fixture();const refs=f.candidate(17);const records=new Map(refs.map(r=>[r,{}]));
 const first=await f.index(records);assert.equal(first.listings[0]?.revocationCoverage,'incomplete');
 const next=await f.index(records,first);assert.equal(next.listings[0]?.revocationCoverage,'complete');
});
test('verified revocation remains complete through later marker read failures under RB-3',async()=>{
 const f=await fixture();const [ref]=f.candidate(1);const revoked=await f.index(new Map([[ref!,f.marker]]));
 assert.equal(revoked.listings[0]?.status,'revoked');assert.equal(revoked.listings[0]?.revocationCoverage,'complete');
 assert.ok(revoked.listings[0]?.revocation);
 const retained=await f.index(new Map(),revoked);assert.equal(retained.listings[0]?.status,'revoked');assert.equal(retained.listings[0]?.revocationCoverage,'complete');
});
test('catalog progress is committed with catalog, not mutable working scanner state',async()=>{
 const {reindexAll}=await import('../src/catalog/reindexCore.js');const {catalogScanProgress}=await import('../src/catalog/freshness.js');
 seedScanState({schemaVersion:10,chainIdentity:PINNED_DEMOS_CHAIN_IDENTITY,lastSeenTxId:0,listings:{},deals:{}});store.saveRegistrations([]);
 const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({result:200,response:[{id:5},{id:4},{id:3},{id:2},{id:1}]});
 try{
  await reindexAll({resolveIdentities:async()=>({}),nodeDeployment:onPinnedChain,log:()=>{}});
  const c=store.loadCatalog();assert.equal(c.scanProgress?.cursor,3);assert.equal(c.scanProgress?.tip,5);assert.equal(c.scanProgress?.lag,2);assert.equal(c.scanProgress?.fromTx,0);
  assert.ok(c.scanProgress!.lastSuccessfulFullScanAt!>0);
  store.saveScanState({...store.loadScanState(),lastSeenTxId:999});assert.equal(catalogScanProgress(store.loadCatalog()).cursor,3);
  globalThis.fetch=async()=>{throw new Error('synthetic unavailable node');};await assert.rejects(reindexAll({nodeDeployment:onPinnedChain,log:()=>{}}));
  assert.deepEqual(store.loadCatalog().scanProgress,c.scanProgress);
 }finally{globalThis.fetch=old;}
});
test('legacy catalog reports unknown progress instead of fabricated zero',async()=>{
 const {catalogScanProgress}=await import('../src/catalog/freshness.js');
 assert.deepEqual(Object.values(catalogScanProgress({catalogVersion:'1',generatedAt:123,sellers:[]})),[null,null,null,null,null,null]);
});
test('listing API publishes committed progress and retains existing withdrawal carriage',async()=>{
 const progress={cursor:3,tip:5,lag:2,cursorAdvancedAt:1,lastSuccessfulFullScanAt:2,fromTx:0};
 store.saveCatalog({catalogVersion:'1',generatedAt:3,sellers:[],scanProgress:progress});
 const {GET}=await import('../app/api/dacs/listings/route.js');const {NextRequest}=await import('next/server');
 const response=await GET(new NextRequest('https://fixture.test/api/dacs/listings?limit=200'));const body=await response.json();
 assert.equal(response.status,200);assert.deepEqual(body.scanProgress,progress);assert.deepEqual(body.listings,[]);
});
test('schema adds coverage fields while retaining upstream active/revoked status vocabulary',async()=>{
 const {listingSummarySchema}=await import('../src/catalog/contracts.js');
 assert.deepEqual(listingSummarySchema.properties.status.enum,['active','revoked']);
 assert.deepEqual(listingSummarySchema.properties.revocationCoverage.enum,['complete','incomplete']);
});

test('unclassified seller marker 503 keeps coverage incomplete through backoff and recovers to revoked', async()=>{
 const f=await fixture(); const markerRef='stor-'+'d'.repeat(40);
 seedScanState({schemaVersion:10,chainIdentity:PINNED_DEMOS_CHAIN_IDENTITY,lastSeenTxId:0,listings:{},deals:{}});
 store.saveRegistrations([{primaryClaim:claim,displayName:'fixture',listingAnchors:[anchor]}]);
 const db=new Database(join(root,'directory.sqlite'));
 const old=globalThis.fetch; let recovered=false;
 globalThis.fetch=async(input,init)=>{
  if(init?.method==='POST') return Response.json({result:200,response:[{id:5},{id:4},{id:3,to:markerRef},{id:2},{id:1}]});
  const locator=String(input).split('/').at(-1);
  if(locator===anchor) return Response.json({success:true,owner:'0x'+claim.slice(-64),programName:'dacs1:listing:fixture',data:f.listing});
  if(locator===markerRef && recovered) return Response.json({success:true,owner:'0x'+claim.slice(-64),programName:'dacs1-revoked:fixture',data:f.marker});
  return new Response('',{status:503});
 };
 try {
  const {reindexAll}=await import('../src/catalog/reindexCore.js');
  const opts={nodeDeployment:onPinnedChain,resolveIdentities:async()=>({}),log:()=>{}};
  await reindexAll(opts);
  const first=store.loadCatalog();const row=first.sellers.flatMap(s=>s.listings).find(l=>l.contentHash===f.hash)!;
  assert.equal(first.scanProgress?.cursor,3);assert.equal(row.status,'active');assert.equal(row.revocationCoverage,'incomplete');assert.equal(row.lastVerifiedAt,null);
  // It remains unresolved even when not due or exhausted; use the real persisted queue.
  db.prepare("UPDATE artifacts SET status='dead-letter',next_retry_at=NULL WHERE locator=?").run(markerRef);
  assert.equal((await f.index(new Map())).listings[0]?.revocationCoverage,'incomplete');
  // Test-only requeue: production does not automatically retry exhausted/dead-letter rows.
  // Move the overlap past the marker so recovery must come from the due retry queue.
  store.saveScanState({...store.loadScanState(),lastSeenTxId:10});
  db.prepare("UPDATE artifacts SET status='retry',next_retry_at=0 WHERE locator=?").run(markerRef);
  recovered=true;await reindexAll(opts);
  const after=store.loadCatalog().sellers.flatMap(s=>s.listings).find(l=>l.contentHash===f.hash)!;
  assert.equal(after.status,'revoked');assert.equal(after.revocationCoverage,'complete');assert.ok(after.lastVerifiedAt!>0);
 }finally{globalThis.fetch=old;db.close();}
});
test('empty scan publishes unknown tip and lag even with a saved nonzero cursor',async()=>{
 const {reindexAll}=await import('../src/catalog/reindexCore.js');
 seedScanState({schemaVersion:10,chainIdentity:PINNED_DEMOS_CHAIN_IDENTITY,lastSeenTxId:77,listings:{},deals:{}});store.saveRegistrations([]);
 const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({result:200,response:[]});
 try{await reindexAll({nodeDeployment:onPinnedChain,log:()=>{}});const progress=store.loadCatalog().scanProgress!;
 assert.equal(progress.cursor,77);assert.equal(progress.tip,null);assert.equal(progress.lag,null);
 }finally{globalThis.fetch=old;}
});
test('failed pass rolls back cursor; recovery records the published advance and saves scan state once',async()=>{
 const {reindexAll}=await import('../src/catalog/reindexCore.js');
 seedScanState({schemaVersion:10,chainIdentity:PINNED_DEMOS_CHAIN_IDENTITY,lastSeenTxId:0,listings:{},deals:{}});store.saveRegistrations([]);
 const db=new Database(join(root,'directory.sqlite'));const old=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({result:200,response:[{id:5},{id:4},{id:3},{id:2},{id:1}]});
 let fail=true; const opts={nodeDeployment:onPinnedChain,log:(line:string)=>{if(fail && line.startsWith('chain scan:')) throw new Error('synthetic post-scan failure');}};
 try{
  await assert.rejects(reindexAll(opts),/synthetic post-scan failure/);assert.equal(store.loadScanState().lastSeenTxId,0);
  db.exec("CREATE TABLE scan_saves(n INTEGER); INSERT INTO scan_saves VALUES(0); CREATE TRIGGER count_scan_saves AFTER UPDATE ON kv_state WHEN NEW.key='scan-state' BEGIN UPDATE scan_saves SET n=n+1; END");
  const before=Date.now();fail=false;await reindexAll(opts);
  const progress=store.loadCatalog().scanProgress!;assert.equal(progress.cursor,3);assert.ok(progress.cursorAdvancedAt!>=before);
  assert.equal((db.prepare('SELECT n FROM scan_saves').get() as {n:number}).n,1);
 }finally{globalThis.fetch=old;db.close();}
});

test('OpenAPI requires scanProgress and defines the listing schema identity once',async()=>{
 const {catalogStatusSchema,openApiDocument}=await import('../src/catalog/contracts.js');
 assert.ok(catalogStatusSchema.required.includes('scanProgress'));
 const spec=openApiDocument('https://fixture.test') as any;
 const page=spec.paths['/api/dacs/listings'].get.responses['200'].content['application/json'].schema;
 assert.ok(page.required.includes('scanProgress'));
 assert.equal(page.properties.listings.items.$ref,'#/components/schemas/ListingSummary');
 const ids:string[]=[];function walk(v:any){if(!v||typeof v!=='object')return;if(typeof v.$id==='string')ids.push(v.$id);Object.values(v).forEach(walk);}walk(spec);
 assert.equal(ids.filter(id=>id==='/schemas/listing-summary.schema.json').length,1);
});

test('retained revoked binding does not hide an unresolved storage coverage gap',async()=>{
 const f=await fixture();const [ref]=f.candidate(1);
 const prior=await f.index(new Map([[ref!,f.marker]]));
 assert.equal(prior.listings[0]?.status,'revoked');assert.equal(prior.listings[0]?.revocationCoverage,'complete');
 const gap='stor-'+'e'.repeat(40);
 store.recordArtifactFailure(gap,'unknown','STORAGE_RPC_UNAVAILABLE','synthetic unresolved storage',1);
 const current=await f.index(new Map(),prior);
 assert.equal(current.listings[0]?.status,'revoked');assert.ok(current.listings[0]?.revocation);
 assert.equal(current.listings[0]?.revocationCoverage,'incomplete');
 assert.equal(current.listings[0]?.lastVerifiedAt,prior.listings[0]?.lastVerifiedAt);
});
