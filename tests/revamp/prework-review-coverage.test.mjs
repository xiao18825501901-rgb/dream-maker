import test from 'node:test';import assert from 'node:assert/strict';
import {checkPreworkReviewCoverage} from '../../dist/server/prework/closeout.js';
import {requiredPreworkReviewCoverage} from '../../dist/server/prework/runtime.js';
import {hash} from '../../dist/server/security.js';
const c={requirements:[{requirementId:'R1'}]};
const packet={sourceHistory:[{files:[{path:'main.mjs'}]}],rawTests:[{data:{stdout:JSON.stringify({cases:[{id:'C1',requirementIds:['R1'],ok:true,status:'EXECUTED'}]})}}]};
const coverage=()=>[{requirementId:'R1',artifactPaths:['main.mjs'],caseIds:['C1'],acceptanceIds:['A1']}];
test('PW requires exact original source/test/acceptance references in review',()=>assert.equal(checkPreworkReviewCoverage(c,coverage(),packet,[{id:'A1',requirementIds:['R1']}]).length,1));

test('PW rejects omitted executed cases despite claiming every acceptance ID',()=>{
 const p=structuredClone(packet);p.rawTests[0].data.stdout=JSON.stringify({cases:[
  {id:'C1',requirementIds:['R1'],acceptanceIds:['A1'],ok:true,status:'EXECUTED'},
  {id:'C2',requirementIds:['R1'],acceptanceIds:['A2'],ok:true,status:'EXECUTED'}]});
 const rows=coverage();rows[0].acceptanceIds.push('A2');
 const acceptance=[{id:'A1',requirementIds:['R1']},{id:'A2',requirementIds:['R1']}];
 assert.throws(()=>checkPreworkReviewCoverage(c,rows,p,acceptance),{code:'PREWORK_REVIEW_COVERAGE_REQUIRED'});
 rows[0].caseIds.push('C2');assert.equal(checkPreworkReviewCoverage(c,rows,p,acceptance).length,1);
});

test('PW rejects verifier acceptance references outside the approved requirement',()=>{
 const p=structuredClone(packet);p.rawTests[0].data.stdout=JSON.stringify({cases:[{id:'C1',requirementIds:['R1'],acceptanceIds:['A2'],ok:true,status:'EXECUTED'}]});
 assert.throws(()=>checkPreworkReviewCoverage(c,coverage(),p,[{id:'A1',requirementIds:['R1']}]),{code:'PREWORK_REVIEW_COVERAGE_REQUIRED'});
});

test('PW accepts one executed case legitimately covering multiple approved requirements',()=>{
 const contract={requirements:[{requirementId:'R1'},{requirementId:'R2'}]},p=structuredClone(packet);
 p.rawTests[0].data.stdout=JSON.stringify({cases:[{id:'C1',requirementIds:['R1','R2'],acceptanceIds:['A1','A2'],ok:true,status:'EXECUTED'}]});
 const rows=[coverage()[0],{requirementId:'R2',artifactPaths:['main.mjs'],caseIds:['C1'],acceptanceIds:['A2']}];
 assert.equal(checkPreworkReviewCoverage(contract,rows,p,[{id:'A1',requirementIds:['R1']},{id:'A2',requirementIds:['R2']}]).length,2);
});
test('PW uses the original evidence-pool decoder instead of treating dataRef as missing tests',()=>{
 const pooled=structuredClone(packet),data=pooled.rawTests[0].data,key=hash(data);
 pooled.rawTestDataEncoding='CONTENT_POOL_V1';pooled.rawTestDataPool={[key]:data};pooled.rawTests=[{recordId:'synthetic-evidence',dataRef:key}];
 assert.equal(checkPreworkReviewCoverage(c,coverage(),pooled,[{id:'A1',requirementIds:['R1']}]).length,1);
});
test('PW supplies exact requirement, case and acceptance mappings to the reviewer',()=>{
 const contract={requirements:[{requirementId:'R1'},{requirementId:'R2'}]};
 const acceptance=[{id:'A1',requirementIds:['R1']},{id:'A2',requirementIds:['R2']}];
 const observed=[
  {id:'C1',requirementIds:['R1','R2'],acceptanceIds:['A1','A2'],ok:true,status:'EXECUTED'},
  {id:'C2',requirementIds:['R1'],ok:false,status:'EXECUTED'},
  {id:'C3',requirementIds:['R1'],ok:true,status:'TIMED_OUT'},
 ];
 assert.deepEqual(requiredPreworkReviewCoverage(contract,{},acceptance,observed),[
  {requirementId:'R1',caseIds:['C1'],acceptanceIds:['A1']},
  {requirementId:'R2',caseIds:['C1'],acceptanceIds:['A2']},
 ]);
});
for(const[name,change]of[['missing coverage',()=>undefined],['unknown fields',v=>(v[0].passed=true,v)],['unknown file',v=>(v[0].artifactPaths=['other.mjs'],v)],['unknown test',v=>(v[0].caseIds=['C2'],v)],['missing acceptance',v=>(v[0].acceptanceIds=[],v)],['duplicate rows',v=>[v[0],v[0]]]])test('PW rejects '+name,()=>assert.throws(()=>checkPreworkReviewCoverage(c,change(coverage()),packet,[{id:'A1',requirementIds:['R1']}]),{code:'PREWORK_REVIEW_COVERAGE_REQUIRED'}));
