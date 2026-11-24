import {seedOfflinePlannerIdentity} from '../fixtures/offline-prework.mjs';
// OFFLINE controller contracts. No model, Native qualification or generated-business execution.
import test from 'node:test';import assert from 'node:assert/strict';
import {validatePlan} from '../../dist/server/engine.js';
import {validateJsonRuntimePlan} from '../../dist/server/json-runtime-protocol.js';
import {shell} from '../../dist/web/views.js';
import {harness,ready} from '../helpers.mjs';
import {hash,DomainError} from '../../dist/server/security.js';
const sqlite=()=>({schema:'dream-maker.sqlite-runtime-plan.v1',protocol:'SQLITE_IMAGE_V1',runtime:'node',entry:'data.mjs',args:[]});
const json=()=>({schema:'dream-maker.json-runtime-plan.v1',protocol:'JSON_DOCUMENT_V1',runtime:'node',entry:'data.mjs',args:[]});
const tasks=[{id:'T1',title:'Implement data entry',dependsOn:[],requirementIds:['R1'],acceptance:['bounded database'],writePaths:['data.mjs']}];
const load=()=>import('../../dist/server/data-runtime-plan.js');

test('original plan admission accepts SQLite and JSON but never unknown or mixed runtime declarations',()=>{
 assert.equal(validatePlan({tasks,dataRuntime:sqlite()},['R1']).length,1);
 assert.equal(validatePlan({tasks,dataRuntime:json()},['R1']).length,1);
 assert.equal(validatePlan({tasks},['R1']).length,1);
 for(const change of [{schema:'dream-maker.json-runtime-plan.v1'},{protocol:'JSON_DOCUMENT_V1'},{protocol:'SHELL'},{approved:true},{imagePath:'F:/private.sqlite'},{base_url:'https://invalid.example'}])assert.throws(()=>validatePlan({tasks,dataRuntime:{...sqlite(),...change}},['R1']));
 assert.throws(()=>validateJsonRuntimePlan(sqlite()));
});

test('SQLite command uses bounded existing command rules and only fixed guest path and capture binding',async()=>{
 const m=await load(),binding={inputHash:'a'.repeat(64),expectedRevision:2};
 const p=sqlite(),command=m.prepareSqliteRuntimeCommand(p,binding),stdin=JSON.parse(command.stdin);
 assert.equal(command.runtime,'node');assert.equal(command.entry,'data.mjs');assert.deepEqual(command.args,[]);
 assert.deepEqual(stdin,{schema:'dream-maker.sqlite-program-input.v1',protocol:'SQLITE_IMAGE_V1',...binding,database:'/data/project.sqlite'});
 p.args.push('changed-after-capture');assert.deepEqual(command.args,[]);assert.equal(Buffer.byteLength(command.stdin)<65536,true);
 assert.equal(m.validateDataRuntimePlan({...sqlite(),runtime:'python',entry:'data.py'}).runtime,'python');
 for(const change of [{runtime:'sh'},{entry:'../outside.py'},{entry:' data.mjs '},{entry:'.env/main.mjs'},{entry:'node_modules/a.mjs'},{args:['x'.repeat(8193)]},{stdin:'SQL'},{wallSeconds:999},{database:'C:/private.sqlite'},{permissions:['network']}])assert.throws(()=>m.validateSqliteRuntimePlan({...sqlite(),...change}),{code:'PLAN_SQLITE_RUNTIME_INVALID'});
 for(const value of [{...binding,inputHash:'invalid'},{...binding,expectedRevision:-1},{...binding,expectedRevision:NaN},{...binding,image:'not-stdin-data'}])assert.throws(()=>m.prepareSqliteRuntimeCommand(sqlite(),value));
});

test('original Engine retains the exact SQLite declaration in Plan and gives it to Executor without changing frozen spec',async t=>{
 const h=harness(t),{p,s}=await ready(h);h.engine.launch=()=>{};
 const created=h.engine.create(p.id,s.hash,true),run=h.store.run(created.id);run.mode='live';h.store.saveRun(run);seedOfflinePlannerIdentity(h,run.id);
 const before=hash(h.store.spec(s.id)),plan={tasks:[{...tasks[0],requirementIds:s.requirements.map(r=>r.id)}],dataRuntime:sqlite()};let plannerCalls=0,executorCalls=0;
 h.engine.role=async(_run,role,prompt)=>{
  if(role==='planner2'){plannerCalls++;assert.match(prompt,/SQLITE_IMAGE_V1/);return structuredClone(plan);}
  if(role==='executor'){executorCalls++;assert.match(prompt,/dream-maker.sqlite-runtime-plan.v1/);throw new DomainError('OFFLINE_STOP_BEFORE_EXECUTOR_MODEL',409);}
  throw Error('UNEXPECTED_OFFLINE_ROLE');
 };
 await h.engine.loop(run.id,new AbortController().signal);
 assert.equal(plannerCalls,1);assert.equal(executorCalls,1);assert.deepEqual(h.store.run(run.id).plan,plan);
 assert.deepEqual(h.store.records(p.id,'Plan')[0].data.plan,plan);assert.equal(hash(h.store.spec(s.id)),before);
 assert.equal(h.store.records(p.id,'Evidence').length,0);assert.equal(h.store.records(p.id,'Review').length,0);
});

test('Reviewer packet preserves the declared SQLite protocol without granting Native execution or accepting the project',async t=>{
 const h=harness(t),{p,s}=await ready(h),created=h.engine.create(p.id,s.hash,true);await h.engine.settled(created.id);
 const run=h.store.run(created.id);run.plan={...run.plan,dataRuntime:sqlite()};h.store.saveRun(run);
 const {buildReviewPacket}=await import('../../dist/server/review-packet.js'),packet=buildReviewPacket(h.store,run,s);
 assert.deepEqual(packet.plan.dataRuntime,sqlite());assert.equal(packet.scope.toolsAllowed,false);assert.equal(h.store.run(run.id).state,'READY_FOR_DELIVERY');
});

test('JSON data controls never advertise SQLite or unknown declarations as a runnable JSON entry',async t=>{
 const h=harness(t),{p,s}=await ready(h),created=h.engine.create(p.id,s.hash,true);await h.engine.settled(created.id);
 const project=h.store.project(p.id),run=h.store.run(created.id);project.mode='live';run.mode='live';
 const v={mode:'local',screen:'project',projects:[project],snapshot:{project,spec:s,runs:[run],records:[]},settings:null,tab:'files',busy:false,error:'',events:[],connection:'connected',railClosed:false,files:[],fileName:'',fileText:'',previewUrl:'',specSearch:'',logLimit:40,clash:null,draft:()=>'',hasDraft:()=>false};
 for(const dataRuntime of [sqlite(),{...json(),schema:'unknown'}]){run.plan={...run.plan,dataRuntime};assert.equal(/data-action="json-execute"/.test(shell(v)),false);}
 run.plan={...run.plan,dataRuntime:json()};assert.equal(/data-action="json-execute"/.test(shell(v)),true);
});
