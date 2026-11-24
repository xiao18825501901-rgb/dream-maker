import test from 'node:test';import assert from 'node:assert/strict';
import {checkedExecutorEffectCoverage} from '../../dist/server/prework/executor-effects.js';
import {hash} from '../../dist/server/security.js';
const sh='a'.repeat(64),tree='b'.repeat(64);
const fixture=()=>({entries:[{dispatchId:'d',generation:'g',sliceId:'slice',taskId:'T1',sessionId:'s'}],rows:[
 {id:'prepare',kind:'ExecutorWavePrepared',ordinal:1,data:{id:'wave',sourceHash:tree}},
 {id:'grant',kind:'DispatchGranted',ordinal:2,data:{dispatchId:'d',generation:'g',kind:'executor',executorSliceId:'slice'}},
 {id:'intent',kind:'ToolIntent',ordinal:3,data:{tool:'desk_read',specHash:sh,sliceId:'slice',sourceHash:tree}},
 {id:'result',kind:'ToolResult',ordinal:4,data:{intentId:'intent',tool:'desk_read',specHash:sh,sliceId:'slice',sourceHash:tree,status:'COMPLETE'}},
 {id:'finish',kind:'DispatchFinished',ordinal:5,data:{dispatchId:'d',generation:'g',outcome:'COMPLETED',cleanupReturned:true}},
 {id:'seal',kind:'ExecutorSliceSealed',ordinal:6,data:{waveId:'wave',sliceId:'slice',sourceHash:tree,deltaHash:hash([])}},
 {id:'merge-intent',kind:'ExecutorMergeIntent',ordinal:7,data:{waveId:'wave',beforeHash:tree,sourceHash:tree,changedCount:0,changedHash:hash([]),automaticResume:false}},
 {id:'merge',kind:'ExecutorMergeApplied',ordinal:8,data:{waveId:'wave',sourceHash:tree,taskIds:['T1'],verificationRequired:true,reviewRequired:true}},
]});
test('PW effect gate accepts a proven unchanged slice without inventing a write',()=>{const f=fixture();const proof=checkedExecutorEffectCoverage(f.entries,f.rows,sh);assert.equal(proof[0].effect,'SEALED_UNCHANGED');assert.equal(proof[0].sealRecordId,'seal');});
for(const [name,change]of[
 ['unsealed',f=>f.rows=f.rows.filter(r=>r.kind!=='ExecutorSliceSealed')],['unmerged',f=>f.rows=f.rows.filter(r=>r.kind!=='ExecutorMergeApplied')],
 ['changed without write',f=>f.rows.find(r=>r.kind==='ExecutorSliceSealed').data.deltaHash=sh],['stale generation',f=>f.rows.find(r=>r.kind==='DispatchFinished').data.generation='other'],
 ['uncertain tool',f=>f.rows.find(r=>r.kind==='ToolResult').data.status='UNKNOWN_EFFECT'],['wrong slice',f=>f.rows.find(r=>r.kind==='ToolIntent').data.sliceId='foreign'],
 ['unpaired read',f=>f.rows=f.rows.filter(r=>r.kind!=='ToolResult')],['wrong merged task',f=>f.rows.find(r=>r.kind==='ExecutorMergeApplied').data.taskIds=['T2']],
 ['changed source',f=>f.rows.find(r=>r.kind==='ExecutorWavePrepared').data.sourceHash=sh],['late result',f=>f.rows.find(r=>r.kind==='ToolResult').ordinal=9],
 ['no cleanup',f=>f.rows.find(r=>r.kind==='DispatchFinished').data.cleanupReturned=false],
])test('PW effect gate rejects '+name,()=>{const f=fixture();change(f);assert.throws(()=>checkedExecutorEffectCoverage(f.entries,f.rows,sh),{code:'REVIEW_ROLE_EVIDENCE_REQUIRED'});});
test('PW repair requires an actual write paired within its own completed dispatch',()=>{const f=fixture();delete f.entries[0].sliceId;delete f.entries[0].taskId;delete f.rows[1].data.executorSliceId;for(const r of f.rows){delete r.data.sliceId;if(r.kind==='ToolIntent'||r.kind==='ToolResult')r.data.tool='desk_edit';}assert.equal(checkedExecutorEffectCoverage(f.entries,f.rows,sh)[0].effect,'PAIRED_WRITE');f.rows[3].ordinal=9;assert.throws(()=>checkedExecutorEffectCoverage(f.entries,f.rows,sh));});
for(const tool of ['unknown_tool','desk_run'])test('PW rejects unchanged slice with only '+tool,()=>{const f=fixture();f.rows[2].data.tool=tool;f.rows[3].data.tool=tool;assert.throws(()=>checkedExecutorEffectCoverage(f.entries,f.rows,sh),{code:'REVIEW_ROLE_EVIDENCE_REQUIRED'});});
test('PW rejects fabricated task fields on an incompatible merge intent schema',()=>{const f=fixture();f.rows.find(r=>r.kind==='ExecutorMergeIntent').data.taskIds=['T2'];assert.throws(()=>checkedExecutorEffectCoverage(f.entries,f.rows,sh),{code:'REVIEW_ROLE_EVIDENCE_REQUIRED'});});
test('PW missing wave identity never joins through undefined',()=>{const f=fixture();for(const r of f.rows){if(r.kind==='ExecutorWavePrepared')delete r.data.id;else if(['ExecutorSliceSealed','ExecutorMergeIntent','ExecutorMergeApplied'].includes(r.kind))delete r.data.waveId;}assert.throws(()=>checkedExecutorEffectCoverage(f.entries,f.rows,sh),{code:'REVIEW_ROLE_EVIDENCE_REQUIRED'});});
