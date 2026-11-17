import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
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
 assert.equal(ids.filter(id=>id==='/schemas/listing-summary.v2.schema.json').length,1);
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
// marker, and its anchor joins the candidate queue under the seller, which holds the Listing until
// a read returns a marker there. The node reports the transaction, so a forged value, another
// key's CREATE or an address that does not derive from its inputs holds nothing.
async function unreadCreatePass(opts:{from?:string;to?:(derived:string)=>string;nonceText?:boolean;forge?:boolean;emptyRead?:boolean;objectRead?:boolean;invalidRead?:boolean;unindexed?:boolean;marker?:(f:Awaited<ReturnType<typeof fixture>>)=>Record<string,unknown>}){
 const f=await fixture();const {deriveStorageAddress}=await import('../src/catalog/chain.js');
 const owner='0x'+claim.slice(-64);const from=opts.from??owner;const nonce=100+(++seq);const programName='dacs1-revoked:fixture'; // a fresh nonce gives each case its own address
 const derived=deriveStorageAddress(from,programName,nonce,'');const markerRef=opts.to?opts.to(derived):derived;
 const carriedMarker=opts.forge?{...f.marker,signature:{...(f.marker.signature as Record<string,unknown>),value:'A'.repeat(86)}}:opts.marker?.(f)??f.marker;
 const content=JSON.stringify({type:'storageProgram',from,to:markerRef,amount:0,nonce:opts.nonceText?String(nonce):nonce,timestamp:1,
  data:['storageProgram',{operation:'CREATE_STORAGE_PROGRAM',storageAddress:markerRef,programName,encoding:'json',
  data:carriedMarker,acl:{mode:'public'},salt:'',storageLocation:'onchain'}]});
 const tx={id:3,to:markerRef,status:'confirmed',type:'storageProgram',blockNumber:3,hash:'ab'.repeat(32),content};
 seedScanState({schemaVersion:10,chainIdentity:PINNED_DEMOS_CHAIN_IDENTITY,lastSeenTxId:0,listings:{},deals:{}});
 store.saveRegistrations(opts.unindexed?[]:[{primaryClaim:claim,displayName:'fixture',listingAnchors:[anchor]}]);
 const old=globalThis.fetch;let recovered=false;let reads=0;
 globalThis.fetch=async(input,init)=>{
  if(init?.method==='POST') return Response.json({result:200,response:[{id:5},{id:4},tx,{id:2},{id:1}]});
  const locator=String(input).split('/').at(-1);
  if(locator===markerRef)reads++;
  if(locator===anchor) return Response.json({success:true,owner,programName:'dacs1:listing:fixture',data:f.listing});
  if(locator===markerRef && recovered) return Response.json({success:true,owner:from,programName,data:carriedMarker});
  if(locator===markerRef && opts.emptyRead) return Response.json({success:true,owner:from,programName,data:null});
  if(locator===markerRef && opts.objectRead) return Response.json({success:true,owner:from,programName,data:{}});
  if(locator===markerRef && opts.invalidRead) return new Response('{malformed JSON');
  return new Response('',{status:503});
 };
 const {reindexAll}=await import('../src/catalog/reindexCore.js');
 const opts2={nodeDeployment:onPinnedChain,resolveIdentities:async()=>({}),log:()=>{}};
 const row=()=>store.loadCatalog().sellers.flatMap(s=>s.listings).find(l=>l.contentHash===f.hash);
 const firstFetch=globalThis.fetch;
 const due=()=>{const db=new Database(join(root,'directory.sqlite'));
  // Test-only: make the artifact and candidate retries due now instead of after their backoff.
  try{db.prepare("UPDATE artifacts SET next_retry_at=0 WHERE locator=? AND status='retry'").run(markerRef);
   db.prepare("UPDATE revocation_candidate_retries SET retry_after=0 WHERE locator=?").run(markerRef);}finally{db.close();}};
 const run=async(cursor?:number,readable?:boolean)=>{
  due();
  if(cursor!==undefined)store.saveScanState({...store.loadScanState(),lastSeenTxId:cursor});
  if(readable!==undefined)recovered=readable;
  const previous=globalThis.fetch;globalThis.fetch=firstFetch;
  try{await reindexAll(opts2);return row();}finally{globalThis.fetch=previous;}
 };
 try{
  await reindexAll(opts2);const first=row();
  return {first,hash:f.hash,markerRef,reads:()=>reads,again:()=>run(10),recover:()=>run(10,true),replay:()=>run(0),
   recoverAfterFailure:()=>run(undefined,true),fail:async()=>{
    const previous=globalThis.fetch;
    globalThis.fetch=async()=>Response.json({result:503,response:null});
    try{await assert.rejects(reindexAll(opts2),/chain scan/);}finally{globalThis.fetch=previous;}
   }};
 }finally{globalThis.fetch=old;}
}
test('owner-created marker that cannot be read holds the listing, then revokes it once read',async()=>{
 const pass=await unreadCreatePass({});
 assert.equal(pass.first,undefined,'held, not published active');
 const after=await pass.recover();
 assert.equal(after?.status,'revoked');assert.ok(after?.revocation);
});
test('a storage reply that succeeds without the carried marker still holds the listing',async()=>{
 const pass=await unreadCreatePass({emptyRead:true});
 assert.equal(pass.first,undefined,'a reply with no marker has not settled it');
 const after=await pass.recover();
 assert.equal(after?.status,'revoked');
});
const candidateRows=(hash:string)=>{const db=new Database(join(root,'directory.sqlite'));
 try{return db.prepare("SELECT locator, owner, state, carried FROM revocation_candidates WHERE listing_hash=? ORDER BY seq").all(hash) as Array<{locator:string;owner:string|null;state:string;carried:number}>;}finally{db.close();}};
const candidateAttempts=(hash:string,locator:string)=>{const db=new Database(join(root,'directory.sqlite'));
 try{return (db.prepare("SELECT attempts FROM revocation_candidate_retries WHERE listing_hash=? AND locator=?")
  .get(hash,locator) as {attempts:number}|undefined)?.attempts;}finally{db.close();}};
const sellerOwner='0x'+claim.slice(-64);
test('a storage reply with an object that is not a marker still holds the listing, pass after pass',async()=>{
 const pass=await unreadCreatePass({objectRead:true});
 assert.equal(pass.first,undefined,'an empty object has not settled the carried marker');
 const diagnostic=store.indexerDiagnostics({deadLetterLocator:pass.markerRef}).deadLetterDiagnostics.items[0];
 assert.equal(diagnostic?.code,'STORAGE_WITHDRAWAL_MARKER_ABSENT');
 assert.equal(diagnostic.attempts,1,'stable scan failures dead-letter on their first attempt');
 assert.ok(!store.loadRetryableArtifacts(Date.now()+60_000).includes(pass.markerRef));
 assert.deepEqual(candidateRows(pass.hash),[{locator:pass.markerRef,owner:sellerOwner,state:'pending',carried:1}]);
 assert.equal(candidateAttempts(pass.hash,pass.markerRef),1);
 assert.equal(await pass.again(),undefined,'the indexer reads {} too, and the candidate stays unread');
 assert.equal(candidateRows(pass.hash)[0]?.state,'pending');
 assert.equal(candidateAttempts(pass.hash,pass.markerRef),2,'the separate withdrawal candidate keeps retrying');
 assert.equal(store.indexerDiagnostics({deadLetterLocator:pass.markerRef}).deadLetterDiagnostics.items[0]?.attempts,1,
  'the candidate retry does not revive the exhausted artifact retry');
 assert.equal((await pass.recover())?.status,'revoked');
});

test('failed and malformed marker reads keep five artifact attempts and independent withdrawal holds',async()=>{
 for(const invalidRead of [false,true]){
  const pass=await unreadCreatePass({invalidRead});
  assert.equal(pass.first,undefined);
  for(let attempt=1;attempt<5;attempt++){
   assert.equal(store.indexerDiagnostics({deadLetterLocator:pass.markerRef}).deadLetterDiagnostics.returned,0,
    `attempt ${attempt} is still retryable`);
   assert.ok(store.loadRetryableArtifacts(Date.now()+3_600_000).includes(pass.markerRef));
   assert.equal(await pass.again(),undefined);
  }
  const diagnostic=store.indexerDiagnostics({deadLetterLocator:pass.markerRef}).deadLetterDiagnostics.items[0];
  assert.equal(diagnostic?.code,invalidRead?'STORAGE_INVALID_RESPONSE':'STORAGE_RPC_UNAVAILABLE');
  assert.equal(diagnostic.attempts,5);
  assert.equal(candidateRows(pass.hash)[0]?.state,'pending');
  assert.equal((await pass.recover())?.status,'revoked');
 }
});

for(const [reply,options] of [['object',{objectRead:true}],['null',{emptyRead:true}]] as const){
 test(`a settled carried withdrawal leaves no exhausted storage diagnostic at its anchor (${reply})`,async()=>{
  const pass=await unreadCreatePass(options);
  assert.equal(pass.first,undefined);
  assert.equal(await pass.again(),undefined);
  assert.equal(store.indexerDiagnostics({deadLetterLocator:pass.markerRef}).deadLetterDiagnostics.returned,1);
  assert.equal((await pass.recover())?.status,'revoked');

  const {GET}=await import('../app/api/dacs/status/route.js');
  const {NextRequest}=await import('next/server');
  const old=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({result:200,response:[{id:10}]});
  try{
   const response=await GET(new NextRequest(`https://fixture.test/api/dacs/status?locator=${pass.markerRef}`));
   assert.equal(response.status,200);
   const body=await response.json();
   assert.equal(body.indexer.deadLetterDiagnostics.returned,0,'a current marker read closes the exhausted diagnostic');
  }finally{globalThis.fetch=old;}
  assert.equal((await pass.again())?.status,'revoked');
  assert.equal(store.indexerDiagnostics({deadLetterLocator:pass.markerRef}).deadLetterDiagnostics.returned,0);
 });
}

for(const [name,options] of [['forged',{forge:true,objectRead:true}],['unindexed',{unindexed:true,objectRead:true}]] as const){
 test(`a ${name} carried marker keeps its read diagnostic until a chain replay observes it`,async()=>{
  const pass=await unreadCreatePass(options);
  assert.equal(candidateRows(pass.hash).length,name==='forged'?0:1);
  assert.equal(store.indexerDiagnostics({deadLetterLocator:pass.markerRef}).deadLetterDiagnostics.items[0]?.code,'STORAGE_WITHDRAWAL_MARKER_ABSENT');
  await pass.recover();
  const diagnostic=store.indexerDiagnostics({deadLetterLocator:pass.markerRef}).deadLetterDiagnostics.items[0];
  assert.equal(diagnostic?.code,'STORAGE_WITHDRAWAL_MARKER_ABSENT');
  assert.equal(diagnostic.attempts,1);
  assert.doesNotMatch(diagnostic.message,/remains unresolved|Verification runs separately|read clears/);
  await pass.again();
  assert.equal(store.indexerDiagnostics({deadLetterLocator:pass.markerRef}).deadLetterDiagnostics.returned,1);
  await pass.replay();
  assert.equal(store.indexerDiagnostics().lastRun?.from_tx,0);
  assert.equal(store.indexerDiagnostics({deadLetterLocator:pass.markerRef}).deadLetterDiagnostics.returned,0);
 });
}

test('a failed pass forces a replay that can recover an unvisited carried marker',async()=>{
 const pass=await unreadCreatePass({objectRead:true,unindexed:true});
 assert.equal(store.indexerDiagnostics({deadLetterLocator:pass.markerRef}).deadLetterDiagnostics.returned,1);
 await pass.fail();
 assert.equal(store.indexerDiagnostics().lastRun?.status,'failed');
 await pass.recoverAfterFailure();
 assert.equal(store.indexerDiagnostics().lastRun?.from_tx,0);
 assert.equal(store.indexerDiagnostics({deadLetterLocator:pass.markerRef}).deadLetterDiagnostics.returned,0);
});

test('carried marker lifecycle matrix preserves listing outcomes across diagnostic recovery paths',async()=>{
 const trace:Array<{scenario:string;step:string;listingStatus:string;storageReadable:boolean;markerReads:number;codes:string[];attempts:number[];listingRejections:string[];fromTx:number|null}>=[];
 const cases:Array<{name:string;options:Parameters<typeof unreadCreatePass>[0];retries:number}>=[
  {name:'object',options:{objectRead:true},retries:2},
  {name:'null',options:{emptyRead:true},retries:2},
  {name:'forged',options:{forge:true,objectRead:true},retries:2},
  {name:'unindexed',options:{unindexed:true,objectRead:true},retries:2},
  {name:'rpc',options:{},retries:4},
  {name:'malformed',options:{invalidRead:true},retries:4},
 ];
 const reset=()=>{store.clearChainDerivedArtifacts();store.saveCatalog({catalogVersion:'1',generatedAt:0,sellers:[]});};
 const snapshot=(scenario:string,step:string,pass:Awaited<ReturnType<typeof unreadCreatePass>>,storageReadable:boolean)=>{
  const diagnostics=store.indexerDiagnostics({deadLetterLocator:pass.markerRef});
  const row=store.loadCatalog().sellers.flatMap(s=>s.listings).find(l=>l.contentHash===pass.hash);
  trace.push({scenario,step,listingStatus:row?.status??'absent',storageReadable,markerReads:pass.reads(),
   codes:diagnostics.deadLetterDiagnostics.items.map(i=>i.code),attempts:diagnostics.deadLetterDiagnostics.items.map(i=>i.attempts),
   listingRejections:diagnostics.listingRejectionDiagnostics.items.map(i=>i.code),fromTx:diagnostics.lastRun?.from_tx??null});
 };
 for(const item of cases){
  reset();const pass=await unreadCreatePass(item.options);snapshot(item.name,'initial',pass,false);
  for(let i=1;i<=item.retries;i++){await pass.again();snapshot(item.name,`ordinary-${i}`,pass,false);}
  const recovered=await pass.recover();snapshot(item.name,'readable',pass,true);
  assert.equal(recovered?.status,item.options.unindexed?undefined:item.options.forge?'active':'revoked');
  await pass.again();snapshot(item.name,'ordinary-readable',pass,true);
  await pass.replay();snapshot(item.name,'replay',pass,true);
 }
 for(const item of cases.filter(i=>['object','forged','unindexed'].includes(i.name))){
  reset();const pass=await unreadCreatePass(item.options);const name=`failed-${item.name}`;
  snapshot(name,'initial',pass,false);await pass.again();snapshot(name,'ordinary',pass,false);
  await pass.fail();snapshot(name,'failed',pass,false);
  const after=await pass.recoverAfterFailure();snapshot(name,'replayed-readable',pass,true);
  assert.equal(store.indexerDiagnostics().lastRun?.from_tx,0);
  assert.equal(after?.status,item.options.unindexed?undefined:item.options.forge?'active':'revoked');
  await pass.again();snapshot(name,'ordinary-readable',pass,true);
 }
 reset();const repeated=await unreadCreatePass({objectRead:true});snapshot('repeated-replay','initial',repeated,false);
 for(let i=1;i<=4;i++){await repeated.replay();snapshot('repeated-replay',`replay-${i}`,repeated,false);}
 assert.equal((await repeated.recover())?.status,'revoked');snapshot('repeated-replay','readable',repeated,true);
 await repeated.replay();snapshot('repeated-replay','replay-readable',repeated,true);
 assert.equal(trace.length,62);
 if(process.env.DACS_TEST_MATRIX_OUTPUT)writeFileSync(process.env.DACS_TEST_MATRIX_OUTPUT,JSON.stringify(trace,null,2)+'\n');
});
test('a carried marker over the artifact size bound is not queued',async()=>{
 const big=(f:Awaited<ReturnType<typeof fixture>>)=>{
  const {signature:_,...scope}=f.marker as Record<string,unknown>;const body={...scope,reason:'x'.repeat(300_000)};
  return {...body,signature:{algorithm:'ed25519',signer:claim,value:Buffer.from(ed25519Sign(Buffer.from('dacs-revocation:v1:'+contentHash(body)),key)).toString('base64url')}};
 };
 const {selfSignedListingRevocation}=await import('../src/catalog/listingVerification.js');
 assert.equal(await selfSignedListingRevocation(big(await fixture())),true,'the oversized marker is genuinely signed');
 const pass=await unreadCreatePass({marker:big});
 assert.deepEqual(candidateRows(pass.hash),[]);
});
test('a carried marker verified from a stored observation revokes the listing',async()=>{
 const f=await fixture();const locator='stor-'+(7100).toString(16).padStart(40,'0');
 const db=new Database(join(root,'directory.sqlite'));
 try{db.prepare("INSERT INTO artifacts(locator,kind,profile,owner,observed_at,status,data_json) VALUES (?,'listing-revocation','dacs-v0.1',?,1,'observed',?)")
  .run(locator,sellerOwner,JSON.stringify(f.marker));}finally{db.close();}
 store.admitRevocationCandidates(f.hash,[{locator,owner:sellerOwner,carried:true}]);
 store.recordArtifactFailure(locator,'listing-revocation','STORAGE_WITHDRAWAL_MARKER_ABSENT','earlier marker-less read',1);
 assert.equal((await f.index(new Map())).listings[0]?.status,'revoked');
 assert.equal(store.indexerDiagnostics({deadLetterLocator:locator}).deadLetterDiagnostics.returned,1,
  'cached marker bytes are not a current storage read and cannot close its diagnostic');
});
test('a current rejected marker read closes its storage diagnostic without authenticating a withdrawal',async()=>{
 const f=await fixture();const locator='stor-'+(7150).toString(16).padStart(40,'0');
 store.admitRevocationCandidates(f.hash,[{locator,owner:sellerOwner,carried:true}]);
 store.recordArtifactFailure(locator,'unknown','STORAGE_WITHDRAWAL_MARKER_ABSENT','earlier marker-less read',1);
 const invalid={...f.marker,signature:{...(f.marker.signature as Record<string,unknown>),value:'A'.repeat(86)}};
 assert.equal((await f.index(new Map([[locator,invalid]]))).listings[0]?.status,'active');
 assert.equal(candidateRows(f.hash)[0]?.state,'rejected','the signature still decides the withdrawal');
 assert.equal(store.indexerDiagnostics({deadLetterLocator:locator}).deadLetterDiagnostics.returned,0);
});
test('a CREATE whose nonce the node reports as text still holds the listing',async()=>{
 const pass=await unreadCreatePass({nonceText:true});
 assert.equal(pass.first,undefined);
});
test('a carried marker with a forged signature does not hold the listing and is not queued',async()=>{
 const pass=await unreadCreatePass({forge:true});
 assert.equal(pass.first?.status,'active');
 assert.deepEqual(candidateRows(pass.hash),[]);
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
 assert.deepEqual(candidateRows(pass.hash),[]);
});
test('unreadable marker whose address does not derive from its sender does not hold the listing',async()=>{
 const pass=await unreadCreatePass({to:()=> 'stor-'+'f'.repeat(40)});
 assert.equal(pass.first?.status,'active');
});
test('another key\'s carried candidate cannot hold the listing, and a non-marker reply settles it',async()=>{
 const f=await fixture();const locator='stor-'+(7200).toString(16).padStart(40,'0');const other='0x'+'e'.repeat(64);
 store.admitRevocationCandidates(f.hash,[{locator,owner:other,carried:true}]);
 assert.equal((await f.index(new Map())).listings[0]?.status,'active','unread, but not the owner\'s');
 const db=new Database(join(root,'directory.sqlite'));
 try{db.prepare('DELETE FROM revocation_candidate_retries').run();}finally{db.close();}
 assert.equal((await f.index(new Map([[locator,{}]]))).listings[0]?.status,'active');
 assert.equal(candidateRows(f.hash)[0]?.state,'rejected');
});
test('a non-marker reply, {} included, stays unread for the owner\'s 17th carried candidate',async()=>{
 const f=await fixture();
 assert.equal((await f.index(new Map())).listings[0]?.status,'active');
 const wrong={...f.marker,listingId:'another-listing'};
 const refs=Array.from({length:17},(_,i)=>'stor-'+(3000+i).toString(16).padStart(40,'0'));
 store.admitRevocationCandidates(f.hash,refs.map(locator=>({locator,owner:sellerOwner,carried:true})));
 assert.equal((await f.index(new Map())).listings.length,0,'held while the carried markers are unread');
 // The first 16 anchors read as markers for another Listing and fail RB-4; the 17th replies {}.
 const read=new Map<string,unknown>([...refs.slice(0,16).map((r):[string,unknown]=>[r,wrong]),[refs[16]!,{}]]);
 for(let pass=0;pass<3;pass++){
  const db=new Database(join(root,'directory.sqlite'));
  try{db.prepare('DELETE FROM revocation_candidate_retries').run();}finally{db.close();}
  assert.equal((await f.index(read)).listings.length,0,`pass ${pass}: still held`);
 }
 const rows=candidateRows(f.hash);
 assert.deepEqual(rows.filter(r=>r.state==='rejected').map(r=>r.locator).sort(),refs.slice(0,16).sort());
 assert.deepEqual(rows.filter(r=>r.state==='pending').map(r=>r.locator),[refs[16]]);
 // A marker read at the 17th anchor settles it.
 const db=new Database(join(root,'directory.sqlite'));
 try{db.prepare('DELETE FROM revocation_candidate_retries').run();}finally{db.close();}
 assert.equal((await f.index(new Map([...read,[refs[16]!,wrong]]))).listings[0]?.status,'active');
});
test('a cached rejected observation does not settle a carried marker whose anchor is unreadable now',async()=>{
 const f=await fixture();const locator='stor-'+(7000).toString(16).padStart(40,'0');
 const db=new Database(join(root,'directory.sqlite'));
 try{db.prepare("INSERT INTO artifacts(locator,kind,profile,owner,observed_at,status,data_json) VALUES (?,'listing-revocation','dacs-v0.1',?,1,'observed',?)")
  .run(locator,sellerOwner,JSON.stringify({...f.marker,signature:{...(f.marker.signature as Record<string,unknown>),value:'A'.repeat(86)}}));}finally{db.close();}
 store.admitRevocationCandidates(f.hash,[{locator,owner:sellerOwner,carried:true}]);
 assert.equal((await f.index(new Map())).listings.length,0,'held: the anchor did not read in this pass');
 assert.equal(candidateRows(f.hash)[0]?.state,'pending');
});
test('a chain reset clears carried candidates',async()=>{
 const f=await fixture();
 store.admitRevocationCandidates(f.hash,[{locator:'stor-'+(7300).toString(16).padStart(40,'0'),owner:sellerOwner,carried:true}]);
 store.clearChainDerivedArtifacts();
 assert.deepEqual(candidateRows(f.hash),[]);
});
test('carried candidates are found by the key that carried them, as storage owner or signing key',async()=>{
 const f=await fixture();const locator='stor-'+(7400).toString(16).padStart(40,'0');const other='0x'+'9'.repeat(64);
 store.admitRevocationCandidates(f.hash,[{locator,owner:sellerOwner,carried:true}]);
 assert.equal(store.isOwnerCarriedRevocationCandidate(f.hash,locator,other,claim),true,'the signing key, as a claim, matches');
 assert.equal(store.isOwnerCarriedRevocationCandidate(f.hash,locator,null,other),false);
 assert.equal(store.hasPendingCarriedRevocationCandidate(f.hash,claim),true);
 assert.equal(store.hasPendingCarriedRevocationCandidate(f.hash,other),false);
 store.recordRevocationProgress(f.hash,{unread:[],rejected:[locator]});
 assert.equal(store.hasPendingCarriedRevocationCandidate(f.hash,claim),false,'a settled candidate holds nothing');
});
