// OFFLINE byte/encoding admission tests; no account, model or product result.
import test from 'node:test';import assert from 'node:assert/strict';
import {poolReviewSources,expandReviewSourcePool} from '../../dist/server/review-source-pool.js';
import {assertReviewTaskBodySafe} from '../../dist/server/review-admission.js';
import {hash} from '../../dist/server/security.js';
function packet(encoding='utf8'){
 const bytes=encoding==='utf8'?Buffer.from('\uFEFF中文\n'):Buffer.from([0,255,254,1]);
 const files=[{path:'source.txt',bytes:bytes.length,sha256:hash(bytes),encoding,content:bytes.toString(encoding)}];
 const body={schema:'dream-maker.source-snapshot.v1',runId:'OFFLINE_RUN',specHash:'a'.repeat(64),stage:'BASELINE',treeHash:hash(files.map(({path,bytes,sha256})=>({path,bytes,sha256}))),files};
 return {schema:'dream-maker.review-packet.v1',runId:body.runId,specHash:body.specHash,sourceHistory:[{recordId:'OFFLINE_RECORD',...body,sha256:hash(body)}]};
}
for(const encoding of ['utf8','base64'])test('source pool preserves exact '+encoding+' bytes including BOM',()=>{
 const p=packet(encoding);assert.deepEqual(expandReviewSourcePool(poolReviewSources(p)),p.sourceHistory);
});
for(const [name,mutate]of [
 ['mixed inline and reference',p=>p.sourceHistory[0].files[0].content='hidden'],
 ['wrong snapshot digest',p=>p.sourceHistory[0].sha256='b'.repeat(64)],
 ['wrong file metadata',p=>p.sourceHistory[0].files[0].bytes++],
 ['unknown encoding marker',p=>p.sourceContentEncoding='OTHER'],
 ['oversized expanded history',p=>{const original=p.sourceHistory[0];p.sourceHistory=Array.from({length:2000},()=>original);}]
])test('review admission refuses '+name,()=>{const p=poolReviewSources(packet());mutate(p);assert.throws(()=>assertReviewTaskBodySafe({taskData:JSON.stringify(p)}));});
test('unknown pool-less references are not accepted as ordinary inline source',()=>{
 const p=poolReviewSources(packet());delete p.sourceContentPool;delete p.sourceContentEncoding;
 assert.throws(()=>assertReviewTaskBodySafe(p));
});
test('content sharing does not allow secrets in unique source bytes',()=>{
 const p=packet(),f=p.sourceHistory[0].files[0];f.content='sk-'+'A'.repeat(30);f.bytes=Buffer.byteLength(f.content);f.sha256=hash(Buffer.from(f.content));
 const {recordId,sha256,...body}=p.sourceHistory[0];body.treeHash=hash([{path:f.path,bytes:f.bytes,sha256:f.sha256}]);
 p.sourceHistory[0]={recordId,...body,sha256:hash(body)};assert.throws(()=>poolReviewSources(p),{code:'REVIEW_SECRET_IN_MATERIAL'});
});
test('exact original 512000-byte history boundary is retained after pooling',()=>{
 const p=packet(),s=p.sourceHistory[0],f=s.files[0];f.content='R'.repeat(100000);f.bytes=100000;f.sha256=hash(Buffer.from(f.content));
 s.treeHash=hash([{path:f.path,bytes:f.bytes,sha256:f.sha256}]);s.padding='';p.sourceHistory.push(structuredClone(s));p.sourceHistory[1].recordId='OFFLINE_SECOND';
 s.padding='P'.repeat(512000-Buffer.byteLength(JSON.stringify(p.sourceHistory)));
 for(const snapshot of p.sourceHistory){const {recordId,sha256,...body}=snapshot;snapshot.sha256=hash(body);}
 assert.equal(Buffer.byteLength(JSON.stringify(p.sourceHistory)),512000);
 assert.deepEqual(expandReviewSourcePool(poolReviewSources(p)),p.sourceHistory);
});
for(const escaped of [false,true])test('raw taskData rejects duplicate pool key including escaped alias '+escaped,()=>{
 const p=poolReviewSources(packet()),key=Object.keys(p.sourceContentPool)[0],entry=JSON.stringify(p.sourceContentPool[key]);
 const second=escaped?'"\\u'+key.charCodeAt(0).toString(16).padStart(4,'0')+key.slice(1)+'"':JSON.stringify(key);
 const raw=JSON.stringify(p).replace(JSON.stringify(key)+':'+entry,JSON.stringify(key)+':'+entry+','+second+':'+entry);
 assert.throws(()=>assertReviewTaskBodySafe({taskData:raw}));
});
