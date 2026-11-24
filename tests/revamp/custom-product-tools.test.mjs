// OFFLINE role permissions. No actual filesystem, shell, model or approvals.
import test from 'node:test';import assert from 'node:assert/strict';import * as roles from '../../dist/server/flow/dsh-role-tools.js';
function rig(role,permissions){let calls=0;const base={async dispatch(_role,name){calls++;return{name};}},controller=roles.customProductTools(role,permissions,base,()=>{},new AbortController().signal);return{controller,calls:()=>calls};}
for(const role of ['planner2','reviewer'])test(role+' cannot invoke any executor tool even with a supplied base controller',async()=>{
 assert.equal(typeof roles.customProductTools,'function');const x=rig(role,['source_read']);
 for(const name of ['desk_read','desk_search','desk_write','desk_edit','desk_run'])await assert.rejects(x.controller.dispatch('executor',name,{},new AbortController().signal),{code:'CUSTOM_ROLE_PERMISSION_DENIED'});assert.equal(x.calls(),0);
});
test('read-only Custom executor cannot gain writes or execution by later permission mutation',async()=>{
 assert.equal(typeof roles.customProductTools,'function');const permissions=['source_read'],x=rig('executor',permissions);permissions.push('source_write');
 assert.equal((await x.controller.dispatch('executor','desk_read',{},new AbortController().signal)).name,'desk_read');assert.equal((await x.controller.dispatch('executor','desk_search',{},new AbortController().signal)).name,'desk_search');
 for(const name of ['desk_write','desk_edit','desk_run','host_shell'])await assert.rejects(x.controller.dispatch('executor',name,{},new AbortController().signal),{code:'CUSTOM_ROLE_PERMISSION_DENIED'});assert.equal(x.calls(),2);
});
test('write-enabled executor retains only its fixed tool roster and cancellation before a side effect',async()=>{
 assert.equal(typeof roles.customProductTools,'function');const x=rig('executor',['source_read','source_write']);
 assert.equal((await x.controller.dispatch('executor','desk_write',{},new AbortController().signal)).name,'desk_write');await assert.rejects(x.controller.dispatch('executor','host_shell',{},new AbortController().signal),{code:'CUSTOM_ROLE_PERMISSION_DENIED'});
 await assert.rejects(x.controller.dispatch('executor','desk_run',{},AbortSignal.abort()),{code:'RUN_CANCELLED'});assert.equal(x.calls(),1);
});
test('Custom tools need exact synchronous controller currentness',async()=>{
 assert.equal(typeof roles.customProductTools,'function');let calls=0;for(const guard of [()=>true,()=>Promise.resolve(),()=>Promise.reject(Error('OFFLINE'))]){
 const c=roles.customProductTools('executor',['source_read','source_write'],{async dispatch(){calls++;return{};}},guard,new AbortController().signal);await assert.rejects(c.dispatch('executor','desk_edit',{},new AbortController().signal),{code:'CUSTOM_DSH_CURRENTNESS_INVALID'});
 }assert.equal(calls,0);
});
test('owned cancellation reaches a tool already waiting at its commit fence',async()=>{
 const owned=new AbortController(),broker=new AbortController();let entered,release,writes=0;const waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const base={async dispatch(_role,_name,_args,signal){entered();await gate;if(signal.aborted)throw Object.assign(Error('OFFLINE_CANCELLED'),{code:'RUN_CANCELLED'});writes++;return{};}};
 const c=roles.customProductTools('executor',['source_read','source_write'],base,()=>{},owned.signal),call=c.dispatch('executor','desk_write',{},broker.signal);await waiting;owned.abort();release();
 await assert.rejects(call,{code:'RUN_CANCELLED'});assert.equal(writes,0);assert.equal(broker.signal.aborted,false);
});
