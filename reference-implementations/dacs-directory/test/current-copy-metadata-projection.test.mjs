// Isolate the current-copy writer from upstream admission. These inputs model a broken caller
// contract; separate real-indexer tests prove that malformed copies are already refused there.
// Read the actual constructor rather than duplicating its projection logic or exporting a test hook.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileFunction, createContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
const file=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/catalog/indexer.ts');
const app=path.dirname(path.dirname(path.dirname(file)));
const ts=(await import(pathToFileURL(path.join(app,'node_modules/typescript/lib/typescript.js')).href)).default;
const source=fs.readFileSync(file,'utf8');
const parsed=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const matches=[];
function visit(node){
 if(ts.isObjectLiteralExpression(node)){
  const props=new Map(node.properties.filter(ts.isPropertyAssignment).map(p=>[p.name.getText(parsed),p.initializer.getText(parsed)]));
  if(props.get('outcome')?.includes('authoritative')&&props.has('anchoredByRole')&&props.has('verifiedAt'))matches.push(node);
 }
 ts.forEachChild(node,visit);
}
visit(parsed);assert.equal(matches.length,1,'select exactly the current-copy DealRecord constructor');
const names=['authoritative','resolvedDeal','refsVerified','sellerOutcome','cancellationNeutral','ratings','settlementTxIds','now','selectedLocator','agreementRail','agreementPrice','artifactAnchorTime'];
const emitted=ts.transpileModule('const projected = '+matches[0].getText(parsed)+';', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const construct=compileFunction(emitted+'\nreturn projected;',names,{parsingContext:createContext({})});
const outcomes=[['completed','completed','completed'],['empty','',''],['other-string','future-outcome','future-outcome'],['seven',7,undefined],['zero',0,undefined],['false',false,undefined],['true',true,undefined],['null',null,undefined],['missing',undefined,undefined],['empty-array',[],undefined],['string-array',['completed'],undefined],['object',{},undefined]];
const roles=[['buyer','buyer','buyer'],['seller','seller','seller'],['orchestrator','orchestrator','orchestrator'],['missing',undefined,undefined],['null',null,undefined],['number',7,undefined],['false',false,undefined],['array',['buyer'],undefined],['object',{},undefined],['other','provider',undefined],['padded','seller ',undefined],['case','Seller',undefined],['empty','',undefined]];
function run(label,authoritative,wantedOutcome,wantedRole){
 test('current-copy metadata projection: '+label,()=>{
  const result=construct(authoritative,{jobId:'projection-contract',buyerBundleRef:'fixture-buyer',sellerBundleRef:'fixture-seller',owners:{buyer:'fixture-buyer',seller:'fixture-seller'}},false,'indeterminate',false,[],[],123,'fixture-copy',()=>null,()=>null,()=>undefined);
  const persisted=JSON.parse(JSON.stringify(result));
  assert.equal(result.outcome,wantedOutcome);
  assert.equal(result.anchoredByRole,wantedRole);
  assert.equal(persisted.outcome,wantedOutcome);
  assert.equal(persisted.anchoredByRole,wantedRole);
 });
}
for(const [on,outcome,wantedOutcome] of outcomes)for(const [rn,role,wantedRole] of roles)run(on+'/'+rn,{bundle:{outcome,anchoredByRole:role},signaturesVerified:false},wantedOutcome,wantedRole);
run('no-authoritative-copy',null,undefined,undefined);
