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
 async function sign(body:Record<string,unknown>,domain:string){return {...body,signature:{algorithm:'ed25519',signer:claim,value:Buffer.from(ed25519Sign(Buffer.from(domain+contentHash(body)),key)).toString(domain==='dacs-revocation:v1:'?'base64url':'hex')}};}
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
test('unread raw candidate does not grant withdrawal authority',async()=>{
 const f=await fixture();const before=await f.index(new Map());
 f.candidate(1);const after=await f.index(new Map(),before);
 assert.equal(after.listings[0]?.status,'active');
});
test('verified revocation stays revoked through later marker read failures under RB-3',async()=>{
 const f=await fixture();const [ref]=f.candidate(1);const revoked=await f.index(new Map([[ref!,f.marker]]));
 assert.equal(revoked.listings[0]?.status,'revoked');assert.ok(revoked.listings[0]?.revocation);
 const retained=await f.index(new Map(),revoked);assert.equal(retained.listings[0]?.status,'revoked');
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
test('schema keeps the upstream active/revoked status vocabulary and publishes no coverage flag',async()=>{
 const {listingSummarySchema}=await import('../src/catalog/contracts.js');
 assert.deepEqual(listingSummarySchema.properties.status.enum,['active','revoked']);
 assert.ok(!('revocationCoverage' in listingSummarySchema.properties));assert.ok(!('lastVerifiedAt' in listingSummarySchema.properties));
});

test('unclassified seller marker 503 keeps the listing active through backoff and recovers to revoked', async()=>{
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
  assert.equal(first.scanProgress?.cursor,3);assert.equal(row.status,'active');
  // It remains unresolved even when not due or exhausted; use the real persisted queue.
  db.prepare("UPDATE artifacts SET status='dead-letter',next_retry_at=NULL WHERE locator=?").run(markerRef);
  assert.equal((await f.index(new Map())).listings[0]?.status,'active');
  // Test-only requeue: production does not automatically retry exhausted/dead-letter rows.
  // Move the overlap past the marker so recovery must come from the due retry queue.
  store.saveScanState({...store.loadScanState(),lastSeenTxId:10});
  db.prepare("UPDATE artifacts SET status='retry',next_retry_at=0 WHERE locator=?").run(markerRef);
  recovered=true;await reindexAll(opts);
  const after=store.loadCatalog().sellers.flatMap(s=>s.listings).find(l=>l.contentHash===f.hash)!;
  assert.equal(after.status,'revoked');assert.ok(after.revocation);
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

test('retained revoked binding survives an unrelated unresolved storage read',async()=>{
 const f=await fixture();const [ref]=f.candidate(1);
 const prior=await f.index(new Map([[ref!,f.marker]]));
 assert.equal(prior.listings[0]?.status,'revoked');
 const gap='stor-'+'e'.repeat(40);
 store.recordArtifactFailure(gap,'unknown','STORAGE_RPC_UNAVAILABLE','synthetic unresolved storage',1);
 const current=await f.index(new Map(),prior);
 assert.equal(current.listings[0]?.status,'revoked');assert.ok(current.listings[0]?.revocation);
 assert.ok(!('revocationCoverage' in current.listings[0]!),'no coverage flag is published');
});

test('a saved catalog from an earlier build serves no retired coverage fields',async()=>{
 const f=await fixture();const seller=await f.index(new Map());
 const listings=seller.listings.map(l=>({...l,revocationCoverage:'complete',lastVerifiedAt:123}));
 store.saveCatalog({catalogVersion:'1',generatedAt:4,sellers:[{...seller,listings}]});
 const {GET}=await import('../app/api/dacs/listings/route.js');const {NextRequest}=await import('next/server');
 const response=await GET(new NextRequest('https://fixture.test/api/dacs/listings?limit=200'));const body=await response.json();
 assert.equal(response.status,200);assert.ok(body.listings.length>0);
 for(const row of [...body.listings,...store.loadStoredCatalog().sellers.flatMap(s=>s.listings)]){
  assert.ok(!('revocationCoverage' in row));assert.ok(!('lastVerifiedAt' in row));
 }
});

// A storage read can fail for a marker the seller really created. The confirmed CREATE carries the
// marker, and the Listing is held only while that carried value passes RB-4 against it and the
// anchor stays unreadable. The node reports the transaction, so a forged value (not even kept),
// another key's CREATE or an address that does not derive from its inputs holds nothing.
async function unreadCreatePass(opts:{from?:string;to?:(derived:string)=>string;nonceText?:boolean;forge?:boolean}){
 const f=await fixture();const {deriveStorageAddress}=await import('../src/catalog/chain.js');
 const owner='0x'+claim.slice(-64);const from=opts.from??owner;const nonce=100+(++seq);const programName='dacs1-revoked:fixture'; // a fresh nonce gives each case its own address
 const derived=deriveStorageAddress(from,programName,nonce,'');const markerRef=opts.to?opts.to(derived):derived;
 const content=JSON.stringify({type:'storageProgram',from,to:markerRef,amount:0,nonce:opts.nonceText?String(nonce):nonce,timestamp:1,
  data:['storageProgram',{operation:'CREATE_STORAGE_PROGRAM',storageAddress:markerRef,programName,encoding:'json',
  data:opts.forge?{...f.marker,signature:{...(f.marker.signature as Record<string,unknown>),value:'A'.repeat(86)}}:f.marker,acl:{mode:'public'},salt:'',storageLocation:'onchain'}]});
 const tx={id:3,to:markerRef,status:'confirmed',type:'storageProgram',blockNumber:3,hash:'ab'.repeat(32),content};
 seedScanState({schemaVersion:10,chainIdentity:PINNED_DEMOS_CHAIN_IDENTITY,lastSeenTxId:0,listings:{},deals:{}});
 store.saveRegistrations([{primaryClaim:claim,displayName:'fixture',listingAnchors:[anchor]}]);
 const old=globalThis.fetch;let recovered=false;
 globalThis.fetch=async(input,init)=>{
  if(init?.method==='POST') return Response.json({result:200,response:[{id:5},{id:4},tx,{id:2},{id:1}]});
  const locator=String(input).split('/').at(-1);
  if(locator===anchor) return Response.json({success:true,owner,programName:'dacs1:listing:fixture',data:f.listing});
  if(locator===markerRef && recovered) return Response.json({success:true,owner:from,programName,data:f.marker});
  return new Response('',{status:503});
 };
 const {reindexAll}=await import('../src/catalog/reindexCore.js');
 const opts2={nodeDeployment:onPinnedChain,resolveIdentities:async()=>({}),log:()=>{}};
 const row=()=>store.loadCatalog().sellers.flatMap(s=>s.listings).find(l=>l.contentHash===f.hash);
 try{
  await reindexAll(opts2);const first=row();
  return {first,hash:f.hash,recover:async()=>{
   const db=new Database(join(root,'directory.sqlite'));
   // Test-only: make the artifact and candidate retries due now instead of after their backoff.
   try{db.prepare("UPDATE artifacts SET status='retry',next_retry_at=0 WHERE locator=?").run(markerRef);
    db.prepare("DELETE FROM revocation_candidate_retries WHERE locator=?").run(markerRef);}finally{db.close();}
   store.saveScanState({...store.loadScanState(),lastSeenTxId:10});recovered=true;
   globalThis.fetch=async(input,init)=>{
    if(init?.method==='POST') return Response.json({result:200,response:[{id:5},{id:4},tx,{id:2},{id:1}]});
    const locator=String(input).split('/').at(-1);
    if(locator===anchor) return Response.json({success:true,owner,programName:'dacs1:listing:fixture',data:f.listing});
    if(locator===markerRef) return Response.json({success:true,owner:from,programName,data:f.marker});
    return new Response('',{status:503});
   };
   try{await reindexAll(opts2);return row();}finally{globalThis.fetch=old;}
  }};
 }finally{if(!recovered)globalThis.fetch=old;}
}
test('owner-created marker that cannot be read holds the listing, then revokes it once read',async()=>{
 const pass=await unreadCreatePass({});
 assert.equal(pass.first,undefined,'held, not published active');
 const after=await pass.recover();
 assert.equal(after?.status,'revoked');assert.ok(after?.revocation);
});
test('a CREATE whose nonce the node reports as text still holds the listing',async()=>{
 const pass=await unreadCreatePass({nonceText:true});
 assert.equal(pass.first,undefined);
});
test('a carried marker with a forged signature does not hold the listing and is not kept',async()=>{
 const pass=await unreadCreatePass({forge:true});
 assert.equal(pass.first?.status,'active');
 assert.deepEqual(store.unreadRevocationMarkers(pass.hash,claim),{entries:[],overflow:false},'forged entries cannot fill the seller\'s set');
});
test('only a marker its declared signer signed passes the carried-marker signature check',async()=>{
 const f=await fixture();const {selfSignedListingRevocation}=await import('../src/catalog/listingVerification.js');
 const sig=f.marker.signature as Record<string,unknown>;
 assert.equal(await selfSignedListingRevocation(f.marker),true);
 assert.equal(await selfSignedListingRevocation({...f.marker,signature:{...sig,value:'A'.repeat(86)}}),false);
 assert.equal(await selfSignedListingRevocation({...f.marker,revokedAt:Number((f.marker as Record<string,unknown>).revokedAt)+1}),false);
 assert.equal(await selfSignedListingRevocation({...f.marker,signature:{...sig,signer:'did:demos:agent:'+'e'.repeat(64)}}),false);
});
test('unreadable marker created by another key neither holds the listing nor joins its queue',async()=>{
 const pass=await unreadCreatePass({from:'0x'+'e'.repeat(64)});
 assert.equal(pass.first?.status,'active');
 const db=new Database(join(root,'directory.sqlite'));
 try{assert.equal((db.prepare('SELECT count(*) AS n FROM revocation_candidates WHERE listing_hash=?').get(pass.hash) as {n:number}).n,0);}finally{db.close();}
});
test('unreadable marker whose address does not derive from its sender does not hold the listing',async()=>{
 const pass=await unreadCreatePass({to:()=> 'stor-'+'f'.repeat(40)});
 assert.equal(pass.first?.status,'active');
});
test('carried markers are kept per signer: another key cannot displace the seller, a chain reset clears them',async()=>{
 const f=await fixture();const other='did:demos:agent:'+'e'.repeat(64);
 const entry=(n:number,signer:string)=>({locator:'stor-'+n.toString(16).padStart(40,'0'),marker:{...f.marker,signature:{...(f.marker.signature as Record<string,unknown>),signer}}});
 store.recordUnreadRevocationMarkers(f.hash,[...Array.from({length:20},(_,i)=>entry(1000+i,other)),entry(2000,claim)]);
 assert.equal(store.unreadRevocationMarkers(f.hash,other).overflow,true);
 assert.deepEqual(store.unreadRevocationMarkers(f.hash,claim),{entries:[entry(2000,claim)],overflow:false});
 store.clearChainDerivedArtifacts();
 assert.deepEqual(store.unreadRevocationMarkers(f.hash,claim),{entries:[],overflow:false});
});
test('an overflowing set of the seller\'s own carried markers holds the listing',async()=>{
 const f=await fixture();
 assert.equal((await f.index(new Map())).listings[0]?.status,'active');
 store.recordUnreadRevocationMarkers(f.hash,Array.from({length:17},(_,i)=>({locator:'stor-'+(3000+i).toString(16).padStart(40,'0'),marker:{...f.marker,listingContentHash:'0'.repeat(64)}})));
 assert.equal(store.unreadRevocationMarkers(f.hash,claim).overflow,true);
 assert.equal((await f.index(new Map())).listings.length,0,'held: an entry was dropped at the bound');
});
