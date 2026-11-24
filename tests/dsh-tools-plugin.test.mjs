// Offline extension-policy tests. The registry double is not actual SDK/Live evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installExecutorTools,installRoleTools,TOOL_NAMES,TERMINAL_TOOL_NAMES} from '../adapters/dsh-tools-plugin.mjs';

function registry(){
 const registered=new Map(),guards=[];
 return {registered,guards,tools:{register:d=>registered.set(d.name,d),get:name=>registered.get(name),schemas:()=>[...registered.values()],guard:g=>guards.push(g)}};
}
test('extension forwards arguments and cancellation only through the controller dispatcher',async()=>{
 const ctx=registry(),signal=new AbortController().signal;
 let received;
 const roster=installExecutorTools(ctx,d=>d,async(...args)=>{received=args;return{content:'approved'};});
 assert.deepEqual(roster(),[...TOOL_NAMES].sort());
 const definition=ctx.registered.get('desk_read');
 assert.deepEqual(await definition.execute({path:'main.mjs'},{signal}),{text:'{"content":"approved"}'});
 assert.deepEqual(received,['desk_read',{path:'main.mjs'},signal]);
 assert.equal(ctx.guards[0]({name:'desk_read'}),undefined);
 assert.equal(ctx.guards[0]({name:'host_shell'}),'DREAM_MAKER_TOOL_DENIED');
});
test('allowlisted name cannot authorize a replacement definition',()=>{
 const ctx=registry();installExecutorTools(ctx,d=>d,async()=>({}));
 ctx.registered.set('desk_read',{name:'desk_read',execute:()=>{throw Error('MUST_NOT_EXECUTE');}});
 assert.equal(ctx.guards[0]({name:'desk_read'}),'DREAM_MAKER_TOOL_DENIED');
});

for(const role of ['planner2','reviewer'])test('Custom '+role+' gets only its terminal submission tool',async()=>{
 const ctx=registry(),calls=[];
 const roster=installRoleTools(ctx,d=>d,async(...args)=>{calls.push(args);return{accepted:true};},role);
 assert.deepEqual(roster(),[TERMINAL_TOOL_NAMES[role]]);
 const definition=ctx.registered.get(TERMINAL_TOOL_NAMES[role]);
 const payload=role==='planner2'?{tasks:[{id:'T1',title:'x',dependsOn:[],requirementIds:['R1'],acceptance:['ok'],writePaths:['main.mjs']}],notes:'x'}:{verdict:'PASS',findings:[]};
 const signal=new AbortController().signal;let concluded=0;
 assert.deepEqual(await definition.execute(payload,{signal,concludeTurn(){concluded++;}}),{text:'{"accepted":true}'});
 assert.equal(concluded,1);
 assert.deepEqual(calls,[[TERMINAL_TOOL_NAMES[role],payload,signal]]);
 assert.equal(ctx.guards[0]({name:TERMINAL_TOOL_NAMES[role]}),undefined);
 assert.equal(ctx.guards[0]({name:'desk_read'}),'DREAM_MAKER_TOOL_DENIED');
});
