import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '@kynesyslabs/dacs/canonical';
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from '@kynesyslabs/dacs/crypto';

const root=mkdtempSync(join(tmpdir(),'directory-freshness-'));
process.env.DACS_DIRECTORY_DATA=root;
const store=await import('../src/catalog/store.js');
const {indexRegistration}=await import('../src/catalog/indexer.js');
const {activeCatalogListings}=await import('../src/catalog/discovery.js');
const seed=new Uint8Array(32).fill(31); // deterministic public TEST ONLY key
const key=privateKeyFromSeed(seed);
const claim='did:demos:agent:'+Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString('hex');
const listingScope={listingId:'freshness',listingVersion:1,agentId:claim,serviceId:'freshness',name:'fixture',
 description:'public synthetic',claimRequirements:[],supportedNegotiation:['negotiate-fixed-price'],
 supportedPaymentRails:['pay-dem'],supportedDelivery:['deliver-attested-payload']};
async function signed(scope:Record<string,unknown>, domain:string) {
 return {...scope,signature:{algorithm:'ed25519',signer:claim,value:Buffer.from(await ed25519Sign(Buffer.from(domain+contentHash(scope)),key)).toString('hex')}};
}
const listing=await signed(listingScope,'dacs-listing:v1:');
const marker=await signed({listingId:'freshness',listingVersion:1,listingContentHash:contentHash(listingScope),revokedAt:1},'dacs-revocation:v1:');
const anchor='stor-'+'a'.repeat(40);
const registration={primaryClaim:claim,displayName:'fixture',listingAnchors:[anchor]};
const originalFetch=globalThis.fetch;
let prefix=0;
const rehearsalRows:Record<string,unknown>[]=[];
let rehearsalProgress:unknown;
let markerReads=0;
function freshState() { store.saveScanState({lastSeenTxId:0,listings:{},deals:{}}); }
async function indexed(records:Map<string,unknown>, prior?:Parameters<typeof indexRegistration>[1], anchors=registration.listingAnchors, checks?:Map<string,import("../src/catalog/types.js").ListingSummary>, subject=claim) {
 globalThis.fetch=async input=> {
  const locator=String(input).split('/').at(-1)!;
  if(anchors.includes(locator))return Response.json({success:true,owner:'0x'+claim.slice(-64),data:listing});
  markerReads++;
  if(!records.has(locator))return new Response('',{status:503});
  const value=records.get(locator);if(value instanceof Error)throw value;
  return Response.json({success:true,data:value});
 };
 try {return await indexRegistration({...registration,primaryClaim:subject,listingAnchors:anchors},prior,async()=>({}),undefined,undefined,checks);}
 finally {globalThis.fetch=originalFetch;}
}
function candidates(count:number) {
 const refs=Array.from({length:count},()=> 'stor-'+(++prefix).toString(16).padStart(40,'0'));
 store.admitRevocationCandidates(contentHash(listingScope),refs.map(locator=>({locator,owner:'0x'+claim.slice(-64)})));
 return refs;
}
// Reject/clear prior candidates between cases by successfully reading invalid public bytes.
async function drain() { for(let i=0;i<8;i++) await indexed(new Map(store.nextRevocationCandidates(contentHash(listingScope),null,1000).map(r=>[r,{}]))); }

test.after(()=>{
 if(process.env.S310_FIXTURE_OUTPUT) writeFileSync(process.env.S310_FIXTURE_OUTPUT,JSON.stringify({rows:rehearsalRows,scanProgress:rehearsalProgress}));
 globalThis.fetch=originalFetch;rmSync(root,{recursive:true,force:true});
});

test('unread marker never yields active; discovery excludes it; previous verification time stays old',async()=>{
 await drain();freshState();
 const before=await indexed(new Map());assert.equal(before.listings[0]?.status,'active');
 rehearsalRows.push({name:'complete',listing:before.listings[0]});
 const refs=candidates(1);const after=await indexed(new Map(),before);
 assert.equal(after.listings[0]?.status,'unverified');
 rehearsalRows.push({name:'unread',listing:after.listings[0]});
 assert.equal(after.listings[0]?.revocationCheck,'incomplete');
 assert.equal(after.listings[0]?.lastVerifiedAt,before.listings[0]?.lastVerifiedAt);
 assert.equal(activeCatalogListings({catalogVersion:'1',generatedAt:1,sellers:[after]}).length,0);
 await indexed(new Map([[refs[0]!,{}]]));
});

test('complete positive advances verification; unknown before first complete check is null',async()=>{
 await drain();freshState();const refs=candidates(1);
 const unknown=await indexed(new Map());assert.equal(unknown.listings[0]?.lastVerifiedAt,null);
 const valid=await indexed(new Map([[refs[0]!,{}]]),unknown);
 assert.equal(valid.listings[0]?.status,'active');assert.equal(valid.listings[0]?.revocationCheck,'complete');
 assert.equal(typeof valid.listings[0]?.lastVerifiedAt,'number');
});

test('more than sixteen candidates remain incomplete even when all examined markers are rejected',async()=>{
 await drain();freshState();const refs=candidates(17);
 const first=await indexed(new Map(refs.map(ref=>[ref,{}])));
 assert.equal(first.listings[0]?.status,'unverified');assert.equal(first.listings[0]?.revocationCheck,'incomplete');
 rehearsalRows.push({name:'unexamined',listing:first.listings[0]});
 const second=await indexed(new Map(refs.map(ref=>[ref,{}])),first);
 assert.equal(second.listings[0]?.status,'active');
});

test('previously verified revocation becoming unreadable never returns to active',async()=>{
 await drain();freshState();const [ref]=candidates(1);
 const revoked=await indexed(new Map([[ref!,marker]]));assert.equal(revoked.listings[0]?.status,'revoked');
 rehearsalRows.push({name:'revoked',listing:revoked.listings[0]});
 store.saveScanState({lastSeenTxId:0,listings:{},deals:{},verifiedRevocations:{[contentHash(listingScope)]:[ref!]}});
 const unknown=await indexed(new Map(),revoked);assert.equal(unknown.listings[0]?.status,'unverified');
 assert.equal(unknown.listings[0]?.lastVerifiedAt,revoked.listings[0]?.lastVerifiedAt);
});

test('throwing marker reader is incomplete, never absence',async()=>{
 await drain();freshState();const {findValidListingRevocation,verifyListing}=await import('../src/catalog/listingVerification.js');
 const verified=await verifyListing(listing);assert.ok(verified);
 const progress:{unread:string[],rejected:string[]}={unread:[],rejected:[]};
 assert.equal(await findValidListingRevocation(['throw'],verified,1,async()=>{throw new Error('synthetic');},undefined,progress),null);
 assert.deepEqual(progress.unread,['throw']);
});

test('catalog progress is snapshot-bound; legacy missing progress is unknown',async()=>{
 const {catalogScanProgress}=await import('../src/catalog/freshness.js');
 const {reindexAll}=await import('../src/catalog/reindexCore.js');
 await drain();freshState();store.saveRegistrations([]);
 globalThis.fetch=async()=>Response.json({result:200,response:[{id:5},{id:4},{id:3},{id:2},{id:1}]});
 try {
  await reindexAll({resolveIdentities:async()=>({}),log:()=>{}});
  const first=store.loadCatalog();rehearsalProgress=first.scanProgress;assert.equal(first.scanProgress?.cursor,3);assert.equal(first.scanProgress?.tip,5);
  assert.equal(first.scanProgress?.lag,2);assert.equal(first.scanProgress?.fromTx,0);
  assert.ok(first.scanProgress!.lastSuccessfulFullScanAt!>0);
  const verifiedAt=first.scanProgress!.lastSuccessfulFullScanAt;
  globalThis.fetch=async()=>{throw new Error('synthetic node failure');};
  await assert.rejects(reindexAll({log:()=>{}}));
  assert.equal(store.loadCatalog().scanProgress?.lastSuccessfulFullScanAt,verifiedAt);
  store.saveScanState({...store.loadScanState(),lastSeenTxId:999});
  assert.equal(catalogScanProgress(store.loadCatalog()).cursor,3);
  assert.equal(catalogScanProgress({catalogVersion:'1',generatedAt:123,sellers:[]}).lastSuccessfulFullScanAt,null);
 } finally {globalThis.fetch=originalFetch;}
});

test('real listing route returns persisted progress and excludes incomplete/revoked rows',async()=>{
 await drain();freshState();const refs=candidates(1);
 const seller=await indexed(new Map());assert.equal(seller.listings[0]?.status,'unverified');
 const progress={cursor:50,tip:52,lag:2,cursorAdvancedAt:100,lastSuccessfulFullScanAt:200,fromTx:48};
 store.saveCatalog({catalogVersion:'1',generatedAt:200,sellers:[seller],scanProgress:progress});
 store.saveScanState({lastSeenTxId:999,listings:{},deals:{}});
 const {NextRequest}=await import('next/server');
 const {GET}=await import('../app/api/dacs/listings/route.js');
 const response=await GET(new NextRequest('https://fixture.example/api/dacs/listings?limit=1'));
 const body=await response.json();assert.deepEqual(body.scanProgress,progress);
 assert.equal(body.total,0);assert.deepEqual(body.listings,[]);assert.equal(body.cursor,undefined);
 const {listingSummarySchema,scanProgressSchema}=await import('../src/catalog/contracts.js');
 assert.ok(listingSummarySchema.properties.status.enum.includes('unverified'));
 assert.ok(scanProgressSchema.required.includes('lastSuccessfulFullScanAt'));
 await indexed(new Map([[refs[0]!,{}]]));
});

test('failed atomic publication leaves prior catalog and successful scan snapshot intact',async()=>{
 const before=store.loadCatalog();const scanBefore=store.loadScanState();const run=store.beginScanRun(0);
 const cycle:any={catalogVersion:'1',generatedAt:999,sellers:[]};cycle.circular=cycle;
 assert.throws(()=>store.commitCatalogScan(cycle,{lastSeenTxId:9999,listings:{},deals:{}},run,
  {toTx:9999,txs:1,artifacts:0,rejected:0}));
 assert.deepEqual(store.loadCatalog(),before);assert.deepEqual(store.loadScanState(),scanBefore);
 store.finishScanRun(run,{toTx:0,txs:0,artifacts:0,rejected:0,error:'synthetic publication fault'});
});


test('historical overflow is queued before the cap and remains incomplete until examined',async()=>{
 await drain();freshState();
 const refs=Array.from({length:17},()=> 'stor-'+(++prefix).toString(16).padStart(40,'0'));
 store.saveScanState({lastSeenTxId:0,listings:{},deals:{},verifiedRevocations:{[contentHash(listingScope)]:refs}});
 const records=new Map<string,unknown>(refs.map(ref=>[ref,{}]));records.set(refs[16]!,marker);
 markerReads=0;const first=await indexed(records);
 assert.equal(markerReads,16);assert.equal(first.listings[0]?.status,'unverified');
 const second=await indexed(records,first);assert.equal(second.listings[0]?.status,'revoked');
});

test('duplicate anchors cannot reset the cap for an identical listing',async()=>{
 await drain();freshState();const refs=candidates(17);
 markerReads=0;
 const seller=await indexed(new Map(refs.map(ref=>[ref,{}])),undefined,[anchor,'stor-'+'b'.repeat(40)]);
 assert.equal(markerReads,16);assert.equal(seller.listings.length,1);
 assert.equal(seller.listings[0]?.status,'unverified');
});

test('publication failure through reindexAll keeps catalog progress stable while recording failed run',async()=>{
 const {reindexAll}=await import('../src/catalog/reindexCore.js');
 const Database=(await import('better-sqlite3')).default;
 const db=new Database(join(root,'directory.sqlite'));
 await drain();freshState();store.saveRegistrations([]);
 const before=store.loadCatalog();
 db.exec("CREATE TRIGGER fail_catalog BEFORE UPDATE ON kv_state WHEN NEW.key='catalog' BEGIN SELECT RAISE(FAIL,'synthetic publication'); END;");
 globalThis.fetch=async()=>Response.json({result:200,response:[{id:8},{id:7},{id:6},{id:5},{id:4},{id:3},{id:2},{id:1}]});
 try {
  await assert.rejects(reindexAll({log:()=>{},resolveIdentities:async()=>({})}));
  assert.deepEqual(store.loadCatalog(),before);
  assert.equal(store.indexerDiagnostics().lastRun?.status,'failed');
 } finally {globalThis.fetch=originalFetch;db.exec('DROP TRIGGER fail_catalog');db.close();}
});

test('seller and service pages label unknown history and suppress engagement and Offer metadata',async()=>{
 const React=await import('react');Object.assign(globalThis,{React});
 const {createRequire}=await import('node:module');
 const {renderToStaticMarkup}=createRequire(import.meta.url)('react-dom/server') as {renderToStaticMarkup:(e:React.ReactElement)=>string};
 const {default:Seller}=await import('../app/seller/[claim]/page.js');
 const {default:Service}=await import('../app/service/[seller]/[listingId]/[version]/page.js');
 await drain();freshState();const refs=candidates(1);const unknown=await indexed(new Map());
 unknown.listings[0]!.publicEndpoint='https://example.test/engage';
 unknown.listings[0]!.pricing.priceHint='1';
 store.saveCatalog({catalogVersion:'1',generatedAt:1,sellers:[unknown]});
 const sellerHtml=renderToStaticMarkup(await Seller({params:Promise.resolve({claim})}));
 assert.ok(sellerHtml.includes('not purchasable'));
 const serviceParams={seller:claim,listingId:'freshness',version:'1'};
 const html=renderToStaticMarkup(await Service({params:Promise.resolve(serviceParams)}));
 assert.ok(html.includes('unverified'));assert.ok(!html.includes('Begin with agent'));
 assert.ok(!html.includes('"@type":"Offer"'));
 const active=await indexed(new Map([[refs[0]!,{}]]));
 active.listings[0]!.publicEndpoint='https://example.test/engage';active.listings[0]!.pricing.priceHint='1';
 store.saveCatalog({catalogVersion:'1',generatedAt:1,sellers:[active]});
 const positive=renderToStaticMarkup(await Service({params:Promise.resolve(serviceParams)}));
 assert.ok(positive.includes('Begin with agent'));assert.ok(positive.includes('"@type":"Offer"'));
});


test('the whole pass shares marker budget across duplicate canonical seller registrations',async()=>{
 await drain();freshState();const refs=candidates(17);const records=new Map(refs.map(ref=>[ref,{}]));
 const checks=new Map<string,import('../src/catalog/types.js').ListingSummary>();
 markerReads=0;
 const first=await indexed(records,undefined,[anchor],checks);
 const second=await indexed(records,undefined,[anchor],checks,claim.replace(/^did:/,'DID:'));
 assert.equal(markerReads,16);
 assert.equal(first.listings[0]?.status,'unverified');assert.equal(second.listings[0]?.status,'unverified');
});
