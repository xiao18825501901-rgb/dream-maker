// OFFLINE registry adversarial tests; not native DSH/model qualification.
import test from 'node:test';import assert from 'node:assert/strict';
import * as plugin from '../../adapters/dsh-tools-plugin.mjs';
function registry(){const registered=new Map(),guards=[];return{registered,guards,tools:{register:d=>registered.set(d.name,d),get:name=>registered.get(name),schemas:()=>[...registered.values()],guard:g=>guards.push(g)}};}
for(const role of ['planner2','reviewer'])test('DSH '+role+' registry denies every preexisting and injected tool',async()=>{
 const ctx=registry();let requests=0;assert.equal(typeof plugin.installRoleTools,'function');
 const roster=plugin.installRoleTools(ctx,d=>d,async()=>{requests++;return{};},role);
 const terminal=role==='planner2'?'submit_engineering_plan':'submit_review';
 assert.deepEqual(roster(),[terminal]);
 assert.equal(ctx.guards.at(-1)({name:terminal,agent:{}}),undefined);
 for(const name of ['host_shell','desk_read','desk_write','desk_run'])assert.equal(ctx.guards.at(-1)({name}),'DREAM_MAKER_TOOL_DENIED');
 ctx.registered.set('desk_read',{name:'desk_read',execute:()=>{requests++;}});assert.equal(ctx.guards.at(-1)({name:'desk_read'}),'DREAM_MAKER_TOOL_DENIED');assert.equal(requests,0);
});
test('supervision startup refuses leftover SDK tools instead of hiding their schema',()=>{
 const ctx=registry();ctx.registered.set('host_shell',{name:'host_shell'});assert.equal(typeof plugin.installRoleTools,'function');
 assert.throws(()=>plugin.installRoleTools(ctx,d=>d,async()=>({}),'reviewer'),/DREAM_MAKER_TOOL_ROSTER_NOT_EXCLUSIVE/);assert.equal(ctx.guards[0]({name:'host_shell'}),'DREAM_MAKER_TOOL_DENIED');
});
test('unknown SDK roles cannot gain a tool roster',()=>{
 assert.equal(typeof plugin.installRoleTools,'function');for(const role of ['planner1','codex',undefined,''])assert.throws(()=>plugin.installRoleTools(registry(),d=>d,async()=>({}),role),/DREAM_MAKER_ROLE_DENIED/);
});
