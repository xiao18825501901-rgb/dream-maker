// OFFLINE regression: valid serialized evidence must not multiply into alternate JSON representations.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assertReviewMaterialSafe} from '../../dist/server/review-material.js';
import {reviewAdmissionPrompt} from '../../dist/server/review-admission.js';

function material(){
 const raw=JSON.stringify({cases:Array.from({length:20},(_,i)=>({id:'C'+i,stdin:JSON.stringify(Array.from({length:250},(_,n)=>({category:'类别'+i+'-'+n,amount:n}))),stdout:'正确结果',ok:true}))});
 return {schema:'dream-maker.review-packet.v1',runId:'OFFLINE_RUN',specHash:'a'.repeat(64),rawTests:{stdout:JSON.stringify({planText:raw})},executionEvidence:{roleIdentities:{planner2:{sessionId:'OFFLINE_P2'}}}};
}
test('bounded raw evidence survives the actual reviewer taskData and admission wrappers unchanged',()=>{
 const packet=material(),taskData=JSON.stringify(packet);
 assert.ok(Buffer.byteLength(taskData)<512000);
 const input={role:'reviewer',runId:packet.runId,specHash:packet.specHash,prompt:JSON.stringify({specHash:packet.specHash,taskData,laya:null})};
 const admitted=reviewAdmissionPrompt(input,{threadId:'OFFLINE_REVIEWER',model:'fixture-not-model',provider:'openai',permissionProfile:'readonly',policyHash:'b'.repeat(64)});
 assert.equal(JSON.parse(admitted.prompt).taskData,taskData);
 assert.deepEqual(JSON.parse(JSON.parse(admitted.prompt).taskData),packet);
});
test('three complete verification histories survive wrapping without multiplying outer JSON decode work',()=>{
 const packet=material(),raw=JSON.parse(packet.rawTests.stdout);packet.rawTests=Array.from({length:3},(_,attempt)=>({stdout:JSON.stringify({...raw,attempt})}));
 const taskData=JSON.stringify(packet),input={role:'reviewer',runId:packet.runId,specHash:packet.specHash,prompt:JSON.stringify({specHash:packet.specHash,taskData,laya:null})};
 const admitted=reviewAdmissionPrompt(input,{threadId:'OFFLINE_REVIEWER',model:'fixture-not-model',provider:'openai',permissionProfile:'readonly',policyHash:'b'.repeat(64)});
 assert.equal(JSON.parse(admitted.prompt).taskData,taskData);assert.equal(JSON.parse(JSON.parse(admitted.prompt).taskData).rawTests.length,3);
});
for(const key of ['"Authorization"','\\u0041uthorization'])test('packet-internal encoded key keeps secret context '+key,()=>{
 const packet=material();packet.metadata={[key]:'Bearer OFFLINE_SECRET'};
 const input={role:'reviewer',runId:packet.runId,specHash:packet.specHash,prompt:JSON.stringify({specHash:packet.specHash,taskData:JSON.stringify(packet),laya:null})};
 assert.throws(()=>reviewAdmissionPrompt(input,{threadId:'OFFLINE_REVIEWER',model:'fixture-not-model',provider:'openai',permissionProfile:'readonly',policyHash:'b'.repeat(64)}),{code:'REVIEW_SECRET_IN_MATERIAL'});
});
test('packet-internal key and value escapes cannot hide their decoded credential context',()=>{
 const packet=material();packet.metadata={'\\u0041uthorization':'Be\\u0061rer OFFLINE_SECRET'};
 const input={role:'reviewer',runId:packet.runId,specHash:packet.specHash,prompt:JSON.stringify({specHash:packet.specHash,taskData:JSON.stringify(packet),laya:null})};
 assert.throws(()=>reviewAdmissionPrompt(input,{threadId:'OFFLINE_REVIEWER',model:'fixture-not-model',provider:'openai',permissionProfile:'readonly',policyHash:'b'.repeat(64)}),{code:'REVIEW_SECRET_IN_MATERIAL'});
});
for(const prefixed of [false,true])test('deeply serialized '+(prefixed?'prefixed log':'JSON')+' secrets remain rejected',()=>{
 let value=JSON.stringify({Authorization:'Bearer OFFLINE_SECRET'});
 for(let i=0;i<5;i++)value=JSON.stringify({evidence:prefixed?'log: '+value:value});
 assert.throws(()=>assertReviewMaterialSafe(value),{code:'REVIEW_SECRET_IN_MATERIAL'});
});
test('decoded object keys retain secret context',()=>{
 assert.throws(()=>assertReviewMaterialSafe(JSON.stringify({credentials:JSON.stringify({Authorization:'Bearer OFFLINE_SECRET'})})),{code:'REVIEW_SECRET_IN_MATERIAL'});
});
test('duplicate JSON keys cannot hide an escaped secret in an overwritten value',()=>{
 const text='{"x":"\\u0073k-aaaaaaaaaaaaaaaa","x":0}';
 assert.throws(()=>assertReviewMaterialSafe(text));
 assert.doesNotThrow(()=>assertReviewMaterialSafe('[{"x":1},{"x":2}]'));
});
test('serialized object keys are decoded as material, retaining child credential context',()=>{
 assert.throws(()=>assertReviewMaterialSafe('{"\\\\u0073k-aaaaaaaaaaaaaaaa":0}'),{code:'REVIEW_SECRET_IN_MATERIAL'});
 assert.throws(()=>assertReviewMaterialSafe('{"\\\\u0041uthorization":"Bearer OFFLINE_SECRET"}'),{code:'REVIEW_SECRET_IN_MATERIAL'});
});
test('reviewer carrier fields retain the original escaped-key secret checks',()=>{
 const packet=material(),input={role:'reviewer',runId:packet.runId,specHash:packet.specHash,prompt:JSON.stringify({specHash:packet.specHash,taskData:JSON.stringify(packet),laya:{'"Authorization"':'Bearer OFFLINE_SECRET'}})};
 assert.throws(()=>reviewAdmissionPrompt(input,{threadId:'OFFLINE_REVIEWER',model:'fixture-not-model',provider:'openai',permissionProfile:'readonly',policyHash:'b'.repeat(64)}),{code:'REVIEW_SECRET_IN_MATERIAL'});
});
test('scan byte, depth and node bounds still reject excessive material',()=>{
 assert.throws(()=>assertReviewMaterialSafe('x'.repeat(8*512000+1)),{code:'REVIEW_PACKET_LIMIT'});
 let deep='leaf';for(let i=0;i<66;i++)deep={child:deep};
 assert.throws(()=>assertReviewMaterialSafe(deep),{code:'REVIEW_PACKET_LIMIT'});
 assert.throws(()=>assertReviewMaterialSafe(Array(100001).fill(1)),{code:'REVIEW_PACKET_LIMIT'});
});
