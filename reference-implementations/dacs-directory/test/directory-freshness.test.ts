import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {contentHash} from '@kynesyslabs/dacs/canonical';
import {ed25519Sign,privateKeyFromSeed,publicKeyFromSeed,rawPublicKey} from '@kynesyslabs/dacs/crypto';
const root=mkdtempSync(join(tmpdir(),'directory-progress-'));
process.env.DACS_DIRECTORY_DATA=root;
const store=await import('../src/catalog/store.js');
const {indexRegistration}=await import('../src/catalog/indexer.js');
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
 const candidate=(count:number)=>{const r=refs(count);store.admitRevocationCandidates(hash,r.map(locator=>({locator,owner:'0x'+claim.slice(-64)})));return r;};
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
 const f=await fixture();const before=await f.index(new Map());assert.equal(before.listings[0]?.revocationCheck,'complete');
 f.candidate(1);const after=await f.index(new Map(),before);
 assert.equal(after.listings[0]?.status,'active');assert.equal(after.listings[0]?.revocationCheck,'incomplete');
 assert.equal(after.listings[0]?.lastVerifiedAt,before.listings[0]?.lastVerifiedAt);
});
test('first incomplete check has unknown prior verification time',async()=>{
 const f=await fixture();f.candidate(1);const after=await f.index(new Map());
 assert.equal(after.listings[0]?.revocationCheck,'incomplete');assert.equal(after.listings[0]?.lastVerifiedAt,null);
});
test('complete positive records verification time',async()=>{
 const f=await fixture();const row=(await f.index(new Map())).listings[0]!;
 assert.equal(row.status,'active');assert.equal(row.revocationCheck,'complete');assert.equal(typeof row.lastVerifiedAt,'number');
});
test('candidate overflow remains incomplete until remaining candidates are checked',async()=>{
 const f=await fixture();const refs=f.candidate(17);const records=new Map(refs.map(r=>[r,{}]));
 const first=await f.index(records);assert.equal(first.listings[0]?.revocationCheck,'incomplete');
 const next=await f.index(records,first);assert.equal(next.listings[0]?.revocationCheck,'complete');
});
test('verified revocation remains complete through later marker read failures under RB-3',async()=>{
 const f=await fixture();const [ref]=f.candidate(1);const revoked=await f.index(new Map([[ref!,f.marker]]));
 assert.equal(revoked.listings[0]?.status,'revoked');assert.equal(revoked.listings[0]?.revocationCheck,'complete');
 assert.ok(revoked.listings[0]?.revocation);
 const retained=await f.index(new Map(),revoked);assert.equal(retained.listings[0]?.status,'revoked');assert.equal(retained.listings[0]?.revocationCheck,'complete');
});
test('catalog progress is committed with catalog, not mutable working scanner state',async()=>{
 const {reindexAll}=await import('../src/catalog/reindexCore.js');const {catalogScanProgress}=await import('../src/catalog/freshness.js');
 store.saveScanState({lastSeenTxId:0,listings:{},deals:{}});store.saveRegistrations([]);
 const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({result:200,response:[{id:5},{id:4},{id:3},{id:2},{id:1}]});
 try{
  await reindexAll({resolveIdentities:async()=>({}),log:()=>{}});
  const c=store.loadCatalog();assert.equal(c.scanProgress?.cursor,3);assert.equal(c.scanProgress?.tip,5);assert.equal(c.scanProgress?.lag,2);assert.equal(c.scanProgress?.fromTx,0);
  assert.ok(c.scanProgress!.lastSuccessfulFullScanAt!>0);
  store.saveScanState({...store.loadScanState(),lastSeenTxId:999});assert.equal(catalogScanProgress(store.loadCatalog()).cursor,3);
  globalThis.fetch=async()=>{throw new Error('synthetic unavailable node');};await assert.rejects(reindexAll({log:()=>{}}));
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
 assert.deepEqual(listingSummarySchema.properties.revocationCheck.enum,['complete','incomplete']);
});
