import test from 'node:test';
import assert from 'node:assert/strict';
import {validateJsonRuntimePlan,prepareJsonRuntimeInput,readJsonRuntimeOutput} from '../../dist/server/json-runtime-protocol.js';
import {hash} from '../../dist/server/security.js';
const plan={schema:'dream-maker.json-runtime-plan.v1',protocol:'JSON_DOCUMENT_V1',runtime:'node',entry:'main.mjs',args:[]};
function view(document={count:1}){return {schema:'dream-maker.json-data.v1',kind:'JSON_DOCUMENT_V1',projectId:'p1',revision:2,document,dataHash:hash(document),contentHash:'a'.repeat(64),scope:'PROJECT_JSON_DATA_ONLY',nativeExecutionGranted:false};}
const binding={projectId:'p1',runId:'r1',specHash:'b'.repeat(64),sourceHash:'c'.repeat(64)};
test('runtime plan admits only fixed JSON protocol and bounded explicit command',()=>{
 assert.deepEqual(validateJsonRuntimePlan(plan),plan);
 for(const change of [{runtime:'sh'},{entry:'../outside.py'},{args:['x'.repeat(9000)]},{protocol:'SHELL'},{approved:true}])assert.throws(()=>validateJsonRuntimePlan({...plan,...change}));
});
test('stdin binds the same project, source and displayed JSON revision without truncation',()=>{
 const prepared=prepareJsonRuntimeInput(binding,view()),value=JSON.parse(prepared.stdin);assert.equal(value.revision,2);assert.equal(value.inputHash,prepared.expected.inputHash);assert.deepEqual(value.document,{count:1});assert.equal(value.sourceHash,binding.sourceHash);
 assert.throws(()=>prepareJsonRuntimeInput({...binding,projectId:'other'},view()));assert.throws(()=>prepareJsonRuntimeInput(binding,{...view(),dataHash:'d'.repeat(64)}));assert.throws(()=>prepareJsonRuntimeInput(binding,view({text:'中'.repeat(30000)})),{code:'JSON_DATA_RUNTIME_INPUT_LIMIT'});
});
test('stdout must be exact JSON data bound to that input, never PASS text or another revision',()=>{
 const {expected}=prepareJsonRuntimeInput(binding,view()),output={schema:'dream-maker.json-runtime-output.v1',inputHash:expected.inputHash,expectedRevision:expected.revision,document:{count:2}};
 assert.deepEqual(readJsonRuntimeOutput(JSON.stringify(output)+'\n',expected),{count:2});
 for(const raw of ['PASS',JSON.stringify({...output,expectedRevision:1}),JSON.stringify({...output,inputHash:'f'.repeat(64)}),JSON.stringify({...output,approved:true}),'```json\n'+JSON.stringify(output)+'\n```'])assert.throws(()=>readJsonRuntimeOutput(raw,expected));
});
