// Offline adapter lifecycle only. Actual SDK scheduler tests live in the F-only component tools.
import test from 'node:test';import assert from 'node:assert/strict';
import {installRoleTools,TERMINAL_TOOL_NAMES} from '../../adapters/dsh-tools-plugin.mjs';
function tool(role,dispatch){const registered=new Map();const ctx={tools:{schemas:()=>[...registered.values()],register:d=>registered.set(d.name,d),get:n=>registered.get(n),guard(){}}};installRoleTools(ctx,d=>d,dispatch,role);return registered.get(TERMINAL_TOOL_NAMES[role]);}
for(const role of ['planner2','reviewer']){
 test(role+' ends the SDK turn only after controller acceptance',async()=>{const seen=[],definition=tool(role,async()=>{seen.push('controller-accepted');return{accepted:true};});const result=await definition.execute({}, {signal:new AbortController().signal,concludeTurn(){seen.push('turn-concluded');}});assert.deepEqual(seen,['controller-accepted','turn-concluded']);assert.deepEqual(result,{text:'{"accepted":true}'});});
 test(role+' rejected controller submission never concludes',async()=>{let concluded=0;const definition=tool(role,async()=>{throw Error('CONTROLLER_REJECTED');});await assert.rejects(definition.execute({}, {signal:new AbortController().signal,concludeTurn(){concluded++;}}),/CONTROLLER_REJECTED/);assert.equal(concluded,0);});
 test(role+' missing SDK lifecycle refuses before submission',async()=>{let submitted=0;const definition=tool(role,async()=>{submitted++;return{accepted:true};});await assert.rejects(definition.execute({}, {signal:new AbortController().signal}),/DREAM_MAKER_TERMINAL_LIFECYCLE_REQUIRED/);assert.equal(submitted,0);});
 test(role+' nonaccepted controller result cannot terminate a successful turn',async()=>{let concluded=0;const definition=tool(role,async()=>({accepted:false}));await assert.rejects(definition.execute({}, {signal:new AbortController().signal,concludeTurn(){concluded++;}}),/DREAM_MAKER_TERMINAL_NOT_ACCEPTED/);assert.equal(concluded,0);});
}
