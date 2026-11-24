// OFFLINE: a Custom qualification probe must be constructible for every harness wire,
// while every other purpose binding still refuses.
import test from 'node:test';import assert from 'node:assert/strict';
import {DeepSeekGateway} from '../../dist/server/deepseek-gateway.js';
const magpie={role:'planner2'},probe={permit:{},assertCurrent:()=>{}};
const build=(wire,overrides={})=>new DeepSeekGateway({},()=>({}),'',8192,1,undefined,wire,true,undefined,undefined,undefined,overrides.magpie??magpie,overrides.probe??probe);
test('codex and independent probe wires construct the permit-bound gateway',()=>{
 assert.doesNotThrow(()=>build('chat-completions'));
 assert.doesNotThrow(()=>build('anthropic-messages'));
 // Codex CLI 0.162.0 only speaks the Responses wire for custom providers.
 assert.doesNotThrow(()=>build('responses'));
});
test('an executor probe binds its inbound and upstream wire to its harness',()=>{
 for(const [runtime,protocol] of [['dsh','anthropic-messages'],['pi','chat-completions']]){
  const channel={role:'executor',concreteRoute:{runtime,protocol}};
  assert.doesNotThrow(()=>build(protocol,{magpie:channel}));
  const other=protocol==='anthropic-messages'?'chat-completions':'anthropic-messages';
  assert.throws(()=>build(other,{magpie:channel}),{code:'CUSTOM_PROBE_GATEWAY_PURPOSE_INVALID'});
  assert.throws(()=>build(other,{magpie:{...channel,concreteRoute:{runtime,protocol:other}}}),{code:'CUSTOM_PROBE_GATEWAY_PURPOSE_INVALID'});
 }
});
test('an unknown wire or a foreign purpose binding is still refused',()=>{
 assert.throws(()=>build('completions'),{code:'CUSTOM_PROBE_GATEWAY_PURPOSE_INVALID'});
 assert.throws(()=>new DeepSeekGateway({},()=>({}),'secret',8192,1,undefined,'chat-completions',true,undefined,undefined,undefined,magpie,probe),{code:'CUSTOM_PROBE_GATEWAY_PURPOSE_INVALID'});
 assert.throws(()=>new DeepSeekGateway({},()=>({}),'',8192,2,undefined,'anthropic-messages',true,undefined,undefined,undefined,{role:'executor'},probe),{code:'CUSTOM_PROBE_GATEWAY_PURPOSE_INVALID'});
});
