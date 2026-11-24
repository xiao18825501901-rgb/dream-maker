// OFFLINE contract only: no model, account, Store or dispatch.
import test from 'node:test';import assert from 'node:assert/strict';
import {MagpieDshRequestTransport} from '../../dist/server/magpie-model-transport.js';
import {registeredDshExecutorDigests} from '../../dist/server/magpie-route.js';
import {DeepSeekGateway} from '../../dist/server/deepseek-gateway.js';

const digest='a'.repeat(64);
const route=(protocol)=>({runtime:'dsh',provider:'deepseek-official',protocol,model:'deepseek-flash',
 authentication:'api_key',authRef:'auth_one',accountRef:'account_one',upstreamAccountRef:'deepseek-official/acc_one'});
const session=()=>({observation:{address:'127.0.0.1:4567',pid:1,epoch:'dm_epoch',binaryHash:digest,accountCount:1,accounts:[],credentialsAccepted:true,qualification:'NOT_VERIFIED',realCredentialsPermitted:false,runtimeDirectory:'r',scope:'LOCAL_CONTROL_PROCESS_ONLY'},
 prepareModelPayload:()=>{throw new Error('unused');},control:{prepare:async()=>{},grant:async()=>({status:'ACKNOWLEDGED'})},close:async()=>{}});
const context=(protocol)=>({session:session(),budget:{pendingBoundRequest:()=>({price:{provider:'deepseek-official',model:'deepseek-flash',expiresAt:new Date(Date.now()+60000).toISOString()},maxOutputTokens:128})},
 route:route(protocol),role:'planner2',bindRequest:()=>({projectId:'p',runId:'r',configurationHash:digest,roleId:'planner2',role:'planner2',bodyHash:digest,routeHash:digest,engineeringMode:'custom',work:{}}),assertCurrent:()=>{}});

test('the controller-to-Magpie URL follows the concrete route protocol',()=>{
 assert.equal(new MagpieDshRequestTransport(context('chat-completions')).upstream,'http://127.0.0.1:4567/v1/chat/completions');
 assert.equal(new MagpieDshRequestTransport(context('openai-responses')).upstream,'http://127.0.0.1:4567/v1/responses');
 assert.equal(new MagpieDshRequestTransport(context('anthropic-messages')).upstream,'http://127.0.0.1:4567/v1/messages');
});

test('a declared DSH supervision lane opens only with a registered build and one pinned account',()=>{
 const lane=protocol=>({...context(protocol),supervisor:true});
 assert.throws(()=>new MagpieDshRequestTransport(lane('chat-completions')),{code:'MAGPIE_MODEL_ROLE_INVALID'});
 assert.throws(()=>new MagpieDshRequestTransport(lane('openai-responses')),{code:'MAGPIE_MODEL_ROLE_INVALID'});
 // Declaring the lane on the native Messages wire is a contradiction, not a shortcut.
 assert.throws(()=>new MagpieDshRequestTransport(lane('anthropic-messages')),{code:'MAGPIE_MODEL_ROLE_INVALID'});
 // Without the declaration the transport keeps its historical, untranslated behaviour.
 assert.equal(new MagpieDshRequestTransport(context('chat-completions')).dshSupervisorTranslated,false);
});
test('a declared DSH executor lane opens on both OpenAI wires and on no other',()=>{
 // The lane's own digest gates the build; the declared protocol still picks the outlet.
 // Read from the product registry: a pinned constant goes stale on every rebuild.
const registered=registeredDshExecutorDigests()[0];
 const lane=(protocol,role='executor')=>{
  const input=context(protocol);
  input.role=role;
  input.session.observation={...input.session.observation,binaryHash:registered,accountCount:1,
   accounts:[{...input.route,capabilities:[{model:input.route.model,protocol}]}]};
  return{...input,dshExecutor:true};
 };
 const chat=new MagpieDshRequestTransport(lane('chat-completions'));
 assert.equal(chat.dshExecutorTranslated,true);assert.equal(chat.upstream,'http://127.0.0.1:4567/v1/chat/completions');
 const responses=new MagpieDshRequestTransport(lane('openai-responses'));
 assert.equal(responses.dshExecutorTranslated,true);assert.equal(responses.upstream,'http://127.0.0.1:4567/v1/responses');
 // Declaring the lane on the native Messages wire, on another role, or without the digest is a contradiction.
 assert.throws(()=>new MagpieDshRequestTransport(lane('anthropic-messages')),{code:'MAGPIE_MODEL_ROLE_INVALID'});
 assert.throws(()=>new MagpieDshRequestTransport(lane('openai-responses','planner2')),{code:'MAGPIE_MODEL_ROLE_INVALID'});
 for(const protocol of ['chat-completions','openai-responses']){
  const unregistered=lane(protocol);unregistered.session={...unregistered.session,observation:{...unregistered.session.observation,binaryHash:'a'.repeat(64)}};
  assert.throws(()=>new MagpieDshRequestTransport(unregistered),{code:'MAGPIE_MODEL_ROLE_INVALID'});
  // The declared capability must be the selected protocol: the other wire never opens this lane.
  const other=lane(protocol);other.session={...other.session,observation:{...other.session.observation,
   accounts:[{...other.route,capabilities:[{model:other.route.model,protocol:protocol==='chat-completions'?'openai-responses':'chat-completions'}]}]}};
  assert.throws(()=>new MagpieDshRequestTransport(other),{code:'MAGPIE_MODEL_ROLE_INVALID'});
 }
 // Without the declaration the transport keeps its historical, untranslated behaviour.
 assert.equal(new MagpieDshRequestTransport(context('openai-responses')).dshExecutorTranslated,false);
});
test('a Magpie-backed gateway accepts chat-completions but still refuses responses',()=>{
 const magpie={role:'reviewer',upstream:'http://127.0.0.1:4567/v1/chat/completions'};
 const budget={pendingBoundRequest:()=>{throw new Error('unused');}},quote=()=>({});
 assert.doesNotThrow(()=>new DeepSeekGateway(budget,quote,'',1024,4,fetch,'chat-completions',false,undefined,undefined,undefined,magpie));
 assert.doesNotThrow(()=>new DeepSeekGateway(budget,quote,'',1024,4,fetch,'anthropic-messages',false,undefined,undefined,undefined,magpie));
 assert.throws(()=>new DeepSeekGateway(budget,quote,'',1024,4,fetch,'openai-responses',false,undefined,undefined,undefined,magpie),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
});

test('Claude Messages requires the exact account capability or its legacy reviewer binding',()=>{
 const channel=(provider,role,capabilities,upstreamAccountRef=provider+'/acc_one')=>{
  const input=context('anthropic-messages');
  input.role=role;input.route={...input.route,runtime:'claude',provider,upstreamAccountRef:provider+'/acc_one'};
  input.session.observation.accounts=[{...input.route,upstreamAccountRef,...(capabilities?{capabilities}:{})}];
  return new MagpieDshRequestTransport(input);
 };
 const messages=[{model:'deepseek-flash',protocol:'anthropic-messages'}];
 assert.equal(channel('string','reviewer').claudeSupervisor,true);
 assert.equal(channel('string','planner2').claudeSupervisor,false);
 assert.equal(channel('alternate','planner2',messages).claudeSupervisor,true);
 // An executor on this wire is the Claude executor leg, not the read-only supervisor lane, and it
 // stays closed because no build digest is registered for it: the constructor refuses it.
 assert.throws(()=>channel('alternate','executor',messages),{code:'MAGPIE_MODEL_ROLE_INVALID'});
 assert.equal(channel('alternate','reviewer',[{...messages[0],protocol:'chat-completions'}]).claudeSupervisor,false);
 const unpinned=channel('alternate','reviewer',messages,'alternate/other_account');
 assert.equal(unpinned.claudeSupervisor,false);
 assert.throws(()=>new DeepSeekGateway({},()=>({}),'',1024,1,fetch,'anthropic-messages',false,undefined,undefined,undefined,unpinned),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
});
