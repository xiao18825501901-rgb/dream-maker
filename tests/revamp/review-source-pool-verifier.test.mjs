// OFFLINE lossless pooling only. These records do not qualify any product role.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hash} from '../../dist/server/security.js';
import {
  poolReviewSources,
  expandReviewSourcePool,
  expandReviewTestDataPool
} from '../../dist/server/review-source-pool.js';

function sourcePacket() {
  const body={
    schema:'dream-maker.source-snapshot.v1',
    runId:'OFFLINE_RUN',
    specHash:'a'.repeat(64),
    stage:'BASELINE',
    treeHash:hash([]),
    files:[]
  };
  return {recordId:'OFFLINE_SOURCE',...body,sha256:hash(body)};
}

function rawVerifier(planText, marker) {
  const cases=Array.from({length:20},(_, index)=>({
    id:`C${String(index+1).padStart(2,'0')}`,
    payload:'P'.repeat(10_000),
    stdout:`case ${index}\n`,
    stderr:index===19?marker:''
  }));
  return {
    schema:'dream-maker.trusted-cli-evidence.v2',
    specHash:'a'.repeat(64),
    sourceHash:'b'.repeat(64),
    planHash:hash(planText),
    planText,
    ok:true,
    cases
  };
}

function pooledVerifier() {
  const planText='P'.repeat(120_000);
  const packet={
    schema:'dream-maker.review-packet.v1',
    runId:'OFFLINE_RUN',
    specHash:'a'.repeat(64),
    sourceHistory:[sourcePacket()],
    rawTests:[
      {recordId:'OFFLINE_EVIDENCE_1',data:{stdout:JSON.stringify(rawVerifier(planText,'one'))}},
      {recordId:'OFFLINE_EVIDENCE_2',data:{stdout:JSON.stringify(rawVerifier(planText,'two'))}}
    ]
  };
  return {packet,pooled:poolReviewSources(packet)};
}

function repeatedObservedInputPacket() {
  const inputs=Array.from({length:20},(_,index)=>({
    runtime:'node',
    entry:'main.mjs',
    args:[],
    stdin:index===2?'A'.repeat(50_000):index===3?'B'.repeat(50_000):`case-${index}`
  }));
  const expected=Array.from({length:20},(_,index)=>({
    exitCode:index%2,
    json:{index,total:index*17}
  }));
  const planText=JSON.stringify({
    schema:'dream-maker.cli-verifier.v1',
    specHash:'a'.repeat(64),
    cases:inputs.map((input,index)=>({id:`C${index+1}`,requirementIds:['R1'],input,expected:expected[index]}))
  });
  const rawTests=Array.from({length:3},(_,attempt)=>({
    recordId:`OFFLINE_EVIDENCE_${attempt+1}`,
    data:{
      stdout:JSON.stringify({
        schema:'dream-maker.trusted-cli-evidence.v2',
        specHash:'a'.repeat(64),
        sourceHash:'b'.repeat(64),
        planHash:hash(planText),
        planText,
        ok:true,
        cases:inputs.map((input,index)=>({
          id:`C${index+1}`,
          requirementIds:['R1'],
          input,
          expected:expected[index],
          jobId:`job-${attempt+1}-${index+1}`,
          status:'EXECUTED',
          command:['/usr/bin/node','/workspace/main.mjs','--profile='+'P'.repeat(160)],
          stdout:`stdout-${attempt+1}-${index+1}`,
          stderr:''
        }))
      })
    }
  }));
  return {
    schema:'dream-maker.review-packet.v1',
    runId:'OFFLINE_RUN',
    specHash:'a'.repeat(64),
    sourceHistory:[sourcePacket()],
    rawTests,
    oversizedContext:'X'.repeat(120_000)
  };
}

function textVersionSnapshot(index,content) {
  const path='main.mjs';
  const file={path,bytes:Buffer.byteLength(content),sha256:hash(content),encoding:'utf8',content};
  const body={
    schema:'dream-maker.source-snapshot.v1',
    runId:'OFFLINE_RUN',
    specHash:'a'.repeat(64),
    stage:index===0?'BASELINE':'EXECUTOR_AFTER',
    treeHash:hash([{path,bytes:file.bytes,sha256:file.sha256}]),
    files:[file],
    directories:[]
  };
  return {recordId:`OFFLINE_SOURCE_${index+1}`,...body,sha256:hash(body)};
}

function textVersionPacket() {
  const common=Array.from({length:1600},(_,index)=>`const shared_${index} = ${index * 17};`).join('\n');
  const sourceHistory=Array.from({length:10},(_,index)=>
    textVersionSnapshot(index,`${common}\n// revision ${index}\nexport const revision = ${index};\n`)
  );
  return {
    schema:'dream-maker.review-packet.v1',
    runId:'OFFLINE_RUN',
    specHash:'a'.repeat(64),
    sourceHistory
  };
}

function rewriteReferencedStdout(pooled, mutate) {
  const dataKey=Object.keys(pooled.rawTestDataPool).find(key=>pooled.rawTestDataPool[key].stdoutRef);
  const data=pooled.rawTestDataPool[dataKey];
  const descriptor=structuredClone(pooled.rawVerifierStdoutPool[data.stdoutRef]);
  mutate(descriptor);
  const stdoutRef=hash(descriptor);
  pooled.rawVerifierStdoutPool[stdoutRef]=descriptor;
  delete pooled.rawTestDataPool[dataKey];
  const nextData={...data,stdoutRef};
  const dataRef=hash(nextData);
  pooled.rawTestDataPool[dataRef]=nextData;
  const test=pooled.rawTests.find(value=>value.dataRef===dataKey);
  test.dataRef=dataRef;
  return pooled;
}

function rewriteReferencedCase(pooled, mutate) {
  const dataKey=Object.keys(pooled.rawTestDataPool).find(key=>pooled.rawTestDataPool[key].stdoutRef);
  const data=pooled.rawTestDataPool[dataKey];
  const oldStdoutRef=data.stdoutRef;
  const descriptor=structuredClone(pooled.rawVerifierStdoutPool[oldStdoutRef]);
  const caseIndex=descriptor.casesRef.findIndex(ref=>Object.keys(pooled.rawVerifierCasePool[ref].valueRefs).length);
  const oldCaseRef=descriptor.casesRef[caseIndex];
  const body=structuredClone(pooled.rawVerifierCasePool[oldCaseRef]);
  mutate(body);
  const caseRef=hash(body);
  pooled.rawVerifierCasePool[caseRef]=body;
  descriptor.casesRef[caseIndex]=caseRef;
  const stdoutRef=hash(descriptor);
  pooled.rawVerifierStdoutPool[stdoutRef]=descriptor;
  delete pooled.rawTestDataPool[dataKey];
  const nextData={...data,stdoutRef};
  const dataRef=hash(nextData);
  pooled.rawTestDataPool[dataRef]=nextData;
  const test=pooled.rawTests.find(value=>value.dataRef===dataKey);
  test.dataRef=dataRef;
  return pooled;
}

test('duplicate verifier plans and cases are shared without changing raw evidence',()=>{
  const planText=JSON.stringify({
    schema:'dream-maker.cli-verifier.v1',
    specHash:'a'.repeat(64),
    cases:[{id:'C01',requirementIds:['R1'],runtime:'node',entry:'main.mjs',args:[],stdin:'x'.repeat(150_000),expectedExitCode:0,expectedStdout:'ok\n'}]
  });
  const first=rawVerifier(planText,'first diagnostic');
  const second=rawVerifier(planText,'second diagnostic');
  const packet={
    schema:'dream-maker.review-packet.v1',
    runId:'OFFLINE_RUN',
    specHash:'a'.repeat(64),
    sourceHistory:[sourcePacket()],
    rawTests:[
      {recordId:'OFFLINE_EVIDENCE_1',data:{stdout:JSON.stringify(first)}},
      {recordId:'OFFLINE_EVIDENCE_2',data:{stdout:JSON.stringify(second)}}
    ]
  };
  const pooled=poolReviewSources(packet);
  assert.ok(Buffer.byteLength(JSON.stringify(pooled))<=512_000);
  assert.equal(pooled.rawVerifierStdoutEncoding,'CONTENT_POOL_V2');
  assert.deepEqual(
    expandReviewTestDataPool(pooled),
    packet.rawTests
  );
});

test('repeated observed inputs are shared across three verifier attempts without changing evidence',()=>{
  const packet=repeatedObservedInputPacket();
  const pooled=poolReviewSources(packet);
  assert.ok(Buffer.byteLength(JSON.stringify(pooled))<=512_000);
  assert.equal(pooled.rawVerifierStdoutEncoding,'CONTENT_POOL_V2');
  assert.deepEqual(expandReviewTestDataPool(pooled),packet.rawTests);
});

test('plan witnesses and repeated observed fields are lossless and explicitly encoded',()=>{
  const packet=repeatedObservedInputPacket();
  for(const test of packet.rawTests){
    const evidence=JSON.parse(test.data.stdout);
    for(const observed of evidence.cases)observed.stdout='S'.repeat(2_000);
    test.data.stdout=JSON.stringify(evidence);
  }
  const pooled=poolReviewSources(packet);
  const cases=Object.values(pooled.rawVerifierCasePool);
  assert.ok(cases.some(body=>body.planWitnessFields?.includes('input')));
  assert.ok(cases.some(body=>body.planWitnessFields?.includes('expected')));
  assert.ok(cases.some(body=>body.valueRefs?.stdout));
  assert.deepEqual(expandReviewTestDataPool(pooled),packet.rawTests);
});

test('text-heavy source histories use exact deltas and expand byte-for-byte',()=>{
  const packet=textVersionPacket();
  const pooled=poolReviewSources(packet);
  assert.equal(pooled.sourceContentEncoding,'CONTENT_POOL_V2');
  assert.ok(Object.values(pooled.sourceContentPool).some(entry=>entry.schema==='dream-maker.source-content-delta.v1'));
  assert.ok(Buffer.byteLength(JSON.stringify(pooled))<=512_000);
  assert.deepEqual(expandReviewSourcePool(pooled),packet.sourceHistory);
});

test('tampered source deltas, plan witnesses and command values are refused',()=>{
  const sourcePooled=poolReviewSources(textVersionPacket());
  const [deltaRef,delta]=Object.entries(sourcePooled.sourceContentPool)
    .find(([,entry])=>entry.schema==='dream-maker.source-content-delta.v1');
  const badDelta=structuredClone(sourcePooled);
  badDelta.sourceContentPool[deltaRef]={...delta,prefixLength:-1};
  assert.throws(()=>expandReviewSourcePool(badDelta),{code:'REVIEW_SOURCE_POOL_INVALID'});

  const verifierPooled=poolReviewSources(repeatedObservedInputPacket());
  const [caseRef,caseBody]=Object.entries(verifierPooled.rawVerifierCasePool)
    .find(([,body])=>Array.isArray(body.planWitnessFields));
  const badWitness=structuredClone(verifierPooled);
  badWitness.rawVerifierCasePool[caseRef]={...caseBody,planWitnessFields:['command']};
  assert.throws(()=>expandReviewTestDataPool(badWitness),{code:'REVIEW_SOURCE_POOL_INVALID'});
});

test('shared observed inputs refuse missing, orphan and mixed-reference case values',()=>{
  const empty=poolReviewSources(repeatedObservedInputPacket());
  empty.rawVerifierCaseValuePool={};
  assert.throws(()=>expandReviewTestDataPool(empty),{code:'REVIEW_SOURCE_POOL_INVALID'});

  const missing=poolReviewSources(repeatedObservedInputPacket());
  const missingRef=Object.keys(missing.rawVerifierCaseValuePool)[0];
  delete missing.rawVerifierCaseValuePool[missingRef];
  assert.throws(()=>expandReviewTestDataPool(missing),{code:'REVIEW_SOURCE_POOL_INVALID'});

  const orphan=poolReviewSources(repeatedObservedInputPacket());
  const orphanValue={orphan:'must not be accepted'};
  orphan.rawVerifierCaseValuePool[hash(orphanValue)]=orphanValue;
  assert.throws(()=>expandReviewTestDataPool(orphan),{code:'REVIEW_SOURCE_POOL_INVALID'});

  const mixed=rewriteReferencedCase(poolReviewSources(repeatedObservedInputPacket()),body=>{
    const name=Object.keys(body.valueRefs)[0];
    body.fields[name]=body.valueRefs[name];
  });
  assert.throws(()=>expandReviewTestDataPool(mixed),{code:'REVIEW_SOURCE_POOL_INVALID'});
});

test('tampered shared verifier content is refused during expansion',()=>{
  const {pooled}=pooledVerifier();
  const key=Object.keys(pooled.rawVerifierPlanTextPool)[0];
  pooled.rawVerifierPlanTextPool[key]+='tampered';
  assert.throws(()=>expandReviewTestDataPool(pooled),{code:'REVIEW_SOURCE_POOL_INVALID'});
});

test('missing verifier plan, case and stdout references are refused',()=>{
  for(const target of ['plan','case','stdout']) {
    const {pooled}=pooledVerifier();
    const name=target==='plan'?'rawVerifierPlanTextPool':target==='case'?'rawVerifierCasePool':'rawVerifierStdoutPool';
    delete pooled[name][Object.keys(pooled[name])[0]];
    assert.throws(()=>expandReviewTestDataPool(pooled),{code:'REVIEW_SOURCE_POOL_INVALID'});
  }
});

test('orphan verifier plan, case and stdout entries are refused',()=>{
  for(const target of ['plan','case']) {
    const {pooled}=pooledVerifier();
    const name=target==='plan'?'rawVerifierPlanTextPool':'rawVerifierCasePool';
    const value=target==='plan'?'ORPHAN_PLAN':{id:'ORPHAN_CASE'};
    pooled[name][hash(value)]=value;
    assert.throws(()=>expandReviewTestDataPool(pooled),{code:'REVIEW_SOURCE_POOL_INVALID'});
  }
  const {pooled}=pooledVerifier();
  const [oldRef,oldDescriptor]=Object.entries(pooled.rawVerifierStdoutPool)[0];
  const orphan={...oldDescriptor,fields:{...oldDescriptor.fields,sourceHash:'f'.repeat(64)}};
  pooled.rawVerifierStdoutPool[hash(orphan)]=orphan;
  assert.notEqual(hash(orphan),oldRef);
  assert.throws(()=>expandReviewTestDataPool(pooled),{code:'REVIEW_SOURCE_POOL_INVALID'});
});

test('tampered shared verifier case bytes are refused',()=>{
  const {pooled}=pooledVerifier();
  const key=Object.keys(pooled.rawVerifierCasePool)[0];
  pooled.rawVerifierCasePool[key]={...pooled.rawVerifierCasePool[key],payload:'TAMPERED'};
  assert.throws(()=>expandReviewTestDataPool(pooled),{code:'REVIEW_SOURCE_POOL_INVALID'});
});

test('rehashed field-order, stdout digest and byte-count changes are refused',()=>{
  const mutations=[
    descriptor=>{const first=descriptor.fieldOrder[0];descriptor.fieldOrder[0]=descriptor.fieldOrder[1];descriptor.fieldOrder[1]=first;},
    descriptor=>{descriptor.stdoutSha256='f'.repeat(64);},
    descriptor=>{descriptor.stdoutBytes++;},
  ];
  for(const mutate of mutations) {
    const {pooled}=pooledVerifier();
    assert.throws(()=>expandReviewTestDataPool(rewriteReferencedStdout(pooled,mutate)),{code:'REVIEW_SOURCE_POOL_INVALID'});
  }
});

test('a test cannot mix an inline stdout and a stdoutRef',()=>{
  const {pooled}=pooledVerifier();
  const key=Object.keys(pooled.rawTestDataPool)[0];
  pooled.rawTestDataPool[key]={...pooled.rawTestDataPool[key],stdout:'INLINE_DUPLICATE'};
  assert.throws(()=>expandReviewTestDataPool(pooled),{code:'REVIEW_SOURCE_POOL_INVALID'});
});

test('compressed repeated cases cannot exceed the expanded evidence bound',()=>{
  const planText='PLAN';
  const planRef=hash(planText);
  const verifierCase={id:'C01',payload:'X'.repeat(50_000)};
  const caseRef=hash(verifierCase);
  const fieldOrder=['schema','planText','cases'];
  const fields={schema:'dream-maker.trusted-cli-evidence.v2'};
  const raw={schema:fields.schema,planText,cases:Array(50).fill(verifierCase)};
  const stdout=JSON.stringify(raw);
  const descriptor={
    schema:'dream-maker.raw-verifier-stdout-pool.v1',
    fieldOrder,
    fields,
    planTextRef:planRef,
    casesRef:Array(50).fill(caseRef),
    stdoutSha256:hash(stdout),
    stdoutBytes:Buffer.byteLength(stdout)
  };
  const stdoutRef=hash(descriptor);
  const data={stdoutRef};
  const dataRef=hash(data);
  const pooled={
    rawTestDataEncoding:'CONTENT_POOL_V1',
    rawTests:[{recordId:'OFFLINE_BOMB',dataRef}],
    rawTestDataPool:{[dataRef]:data},
    rawVerifierStdoutEncoding:'CONTENT_POOL_V1',
    rawVerifierStdoutPool:{[stdoutRef]:descriptor},
    rawVerifierPlanTextPool:{[planRef]:planText},
    rawVerifierCasePool:{[caseRef]:verifierCase}
  };
  assert.ok(Buffer.byteLength(JSON.stringify(pooled))<512_000);
  assert.throws(()=>expandReviewTestDataPool(pooled),{code:'REVIEW_PACKET_LIMIT'});
});

test('the reviewer prompt explains every lossless verification reference form',()=>{
  const prompt=readFileSync(new URL('../../prompts/reviewer.md',import.meta.url),'utf8');
  assert.match(prompt,/sourceContentEncoding=CONTENT_POOL_V2/);
  assert.match(prompt,/source-content-delta\.v1/);
  assert.match(prompt,/rawTestDataEncoding=CONTENT_POOL_V1/);
  assert.match(prompt,/dataRef/);
  assert.match(prompt,/rawVerifierStdoutEncoding=CONTENT_POOL_V1/);
  assert.match(prompt,/rawVerifierStdoutEncoding=CONTENT_POOL_V2/);
  assert.match(prompt,/stdoutRef/);
  assert.match(prompt,/fieldOrder/);
  assert.match(prompt,/planTextRef/);
  assert.match(prompt,/casesRef/);
  assert.match(prompt,/rawVerifierCaseValuePool/);
  assert.match(prompt,/valueRefs/);
  assert.match(prompt,/planWitnessFields/);
  assert.match(prompt,/manualAcceptanceStatus NOT_RUN is expected controller state, not a code defect/);
});
