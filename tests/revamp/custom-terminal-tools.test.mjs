// Offline contract only: this test never starts DSH, a model or a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {customProductTools,TERMINAL_TOOL_NAMES} from '../../dist/server/flow/dsh-role-tools.js';

const plan={tasks:[{id:'T1',title:'write the file',dependsOn:[],requirementIds:['R001'],acceptance:['file exists'],writePaths:['main.mjs']}]};
const review={verdict:'PASS',findings:[]};

function controller(role,ownedSignal){
 const submitted=[];const tools=customProductTools(role,['source_read'],undefined,()=>{},ownedSignal);
 return{tools,submitted};
}

for(const [role,payload] of [['planner2',plan],['reviewer',review]]){
 test(role+' sees only its role-specific terminal tool and captures exact arguments',async()=>{
  const ownedSignal=new AbortController().signal,x=controller(role,ownedSignal);
  assert.deepEqual(TERMINAL_TOOL_NAMES[role],role==='planner2'?'submit_engineering_plan':'submit_review');
  const result=await x.tools.dispatch('executor',TERMINAL_TOOL_NAMES[role],payload,ownedSignal);
  assert.equal(result.accepted,true);
  assert.deepEqual(JSON.parse(x.tools.terminal()),payload);
  await assert.rejects(x.tools.dispatch('executor',TERMINAL_TOOL_NAMES[role],payload,ownedSignal),{code:'CUSTOM_TERMINAL_SUBMISSION_ALREADY_USED'});
 });
}

test('planner2 terminal submission rejects extra fields before a second call can replace it',async()=>{
 const ownedSignal=new AbortController().signal,x=controller('planner2',ownedSignal);
 await assert.rejects(x.tools.dispatch('executor',TERMINAL_TOOL_NAMES.planner2,{...plan,extra:true},ownedSignal),{code:'CUSTOM_TERMINAL_ARGS_INVALID'});
 await assert.rejects(x.tools.dispatch('executor',TERMINAL_TOOL_NAMES.planner2,plan,ownedSignal),{code:'CUSTOM_TERMINAL_SUBMISSION_ALREADY_USED'});
 assert.equal(x.tools.terminal(),undefined);
});

test('a second terminal call invalidates an earlier successful submission',async()=>{
 const ownedSignal=new AbortController().signal,x=controller('planner2',ownedSignal);
 await x.tools.dispatch('executor',TERMINAL_TOOL_NAMES.planner2,plan,ownedSignal);
 assert.equal(typeof x.tools.terminal(),'string');
 await assert.rejects(x.tools.dispatch('executor',TERMINAL_TOOL_NAMES.planner2,plan,ownedSignal),{code:'CUSTOM_TERMINAL_SUBMISSION_ALREADY_USED'});
 assert.equal(x.tools.terminal(),undefined);
});

test('reviewer terminal submission rejects unknown fields and foreign tools',async()=>{
 const ownedSignal=new AbortController().signal,x=controller('reviewer',ownedSignal);
 await assert.rejects(x.tools.dispatch('executor',TERMINAL_TOOL_NAMES.reviewer,{...review,extra:true},ownedSignal),{code:'CUSTOM_TERMINAL_ARGS_INVALID'});
 await assert.rejects(x.tools.dispatch('executor','desk_read',{path:'main.mjs'},ownedSignal),{code:'CUSTOM_ROLE_PERMISSION_DENIED'});
 assert.equal(x.tools.terminal(),undefined);
});

test('no terminal submission leaves the controller without a result',async()=>{
 const ownedSignal=new AbortController().signal,x=controller('planner2',ownedSignal);
 assert.equal(x.tools.terminal(),undefined);
});
