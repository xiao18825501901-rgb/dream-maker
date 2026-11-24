// Pure OFFLINE routing contract. No registry discovery, credentials, accounts or models.
import test from 'node:test';import assert from 'node:assert/strict';
import {customMagpieProtocol} from '../../dist/shared/custom-magpie-protocol.js';
import {additionalMagpieRoute,claudeReadOnlyProtocol,codexSupervisorProtocol,concreteMagpieRoute,dshExecutorProtocol,dshSupervisorProtocol,supportsClaudeReadOnlyBuild,supportsCodexSupervisorBuild,supportsDshExecutorBuild,supportsDshSupervisorBuild,isOfficialCliMessagesRoute,isOfficialCliResponsesRoute,matchesOfficialCliMessagesSelection,matchesOfficialCliResponsesSelection,magpieRouteHash,magpieRoutePath,piExecutorNativeProtocol,supportsPiExecutorNativeBuild,supportsOfficialCliMessagesBuild,supportsOfficialCliResponsesBuild} from '../../dist/server/magpie-route.js';
const route=()=>({runtime:'dsh',provider:'example',protocol:'chat-completions',model:'model-a',authentication:'api_key',authRef:'dm-auth-1',accountRef:'dm-account-1',upstreamAccountRef:'example/0123456789'});

test('Claude translation is read-only, prefers native Messages and binds the exact declared model',()=>{
 const actor={...route(),runtime:'claude',model:'org/A'};
 const caps=['openai-responses','chat-completions','anthropic-messages'].map(protocol=>({protocol,model:actor.model}));
 for(const role of ['planner2','reviewer']){
  assert.equal(claudeReadOnlyProtocol(role,actor,caps),undefined);
  assert.equal(claudeReadOnlyProtocol(role,actor,[caps[0]]),'openai-responses');
  for(const pair of [[caps[0],caps[1]],[caps[1],caps[0]]])assert.equal(claudeReadOnlyProtocol(role,actor,pair),'chat-completions');
  const extra=additionalMagpieRoute(role,actor,[caps[0]]);assert.equal(extra.supportsBuild,supportsClaudeReadOnlyBuild);
  assert.equal(extra.supportsBuild('78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6'),false);
 }
 assert.equal(claudeReadOnlyProtocol('executor',actor,[caps[0]]),undefined);
 assert.equal(claudeReadOnlyProtocol('reviewer',{...actor,authentication:'oauth'},[caps[0]]),undefined);
 assert.equal(claudeReadOnlyProtocol('reviewer',{...actor,model:'org/a'},[caps[0]]),undefined);
});

test('native Pi executor protocols require the selected physical model and explicit API-key role',()=>{
 const pi={...route(),runtime:'pi',model:'org/A'};
 const messages={model:pi.model,protocol:'anthropic-messages'},responses={...messages,protocol:'openai-responses'};
 assert.equal(piExecutorNativeProtocol('executor',pi,[messages]),messages.protocol);
 for(const caps of [[messages,responses],[responses,messages]])assert.equal(piExecutorNativeProtocol('executor',pi,caps),responses.protocol);
 for(const [role,actor,caps] of [['planner2',pi,[responses]],['executor',{...pi,runtime:'dsh'},[messages]],['executor',{...pi,authentication:'oauth'},[messages]],['executor',pi,[{...messages,model:'org/a'}]]])assert.equal(piExecutorNativeProtocol(role,actor,caps),undefined);
 assert.equal(supportsPiExecutorNativeBuild('78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6'),false);
});

test('official CLI Messages selection is one declared per-model capability of a read-only CLI',()=>{
 const selected={...route(),protocol:'openai-responses',model:'org/A:v2',runtime:'cline'};
 const caps=[{model:'org/A:v2',protocol:'anthropic-messages'}];
 for(const runtime of ['cline','opencode'])for(const role of ['planner2','reviewer'])
  assert.equal(matchesOfficialCliMessagesSelection(role,{...selected,runtime},caps),true);
 for(const [role,overrides,capabilities] of [
  ['executor',{},caps],['planner1',{},caps],['reviewer',{runtime:'pi'},caps],['reviewer',{runtime:'dsh'},caps],['reviewer',{runtime:'codex'},caps],
  ['reviewer',{authentication:'oauth'},caps],['reviewer',{protocol:'chat-completions'},caps],['reviewer',{model:'org/a:v2'},caps],['reviewer',{},undefined],
  ['reviewer',{},[{model:selected.model,protocol:'chat-completions'},{model:'org/a:v2',protocol:'anthropic-messages'}]],
 ])assert.equal(matchesOfficialCliMessagesSelection(role,{...selected,...overrides},capabilities),false);
 // Responses keeps the preference on the additional ladder and Messages never gains a build without evidence.
 const extra=additionalMagpieRoute('reviewer',selected,caps);
 assert.equal(extra.protocol,'anthropic-messages');assert.equal(extra.supportsBuild,supportsOfficialCliMessagesBuild);
 assert.equal(additionalMagpieRoute('reviewer',selected,[...caps,{model:selected.model,protocol:'openai-responses'}]).protocol,'openai-responses');
 for(const binary of ['78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6','15ac29455f506ddd67238e9b553c4fd3c6f9354ed0c8c6a979527b8011777ef8','a'.repeat(64)]){
  assert.equal(supportsOfficialCliMessagesBuild(binary),false);
  assert.equal(isOfficialCliMessagesRoute(binary,'reviewer',selected,caps),false);
 }
});

test('DSH supervision translation needs no native Messages capability and prefers Responses over Chat',()=>{
 const dsh={...route(),runtime:'dsh',model:'org/A'};
 const chatCap={model:dsh.model,protocol:'chat-completions'},responsesCap={model:dsh.model,protocol:'openai-responses'};
 for(const role of ['planner2','reviewer']){
  assert.equal(dshSupervisorProtocol(role,dsh,[chatCap]),'chat-completions');
  // The Go ingress admits the role's single terminal tool on both OpenAI wires.
 for(const caps of [[chatCap,responsesCap],[responsesCap,chatCap]])assert.equal(dshSupervisorProtocol(role,dsh,caps),'openai-responses');
 assert.equal(dshSupervisorProtocol(role,dsh,[responsesCap]),'openai-responses');
  assert.equal(dshSupervisorProtocol(role,dsh,[{model:dsh.model,protocol:'anthropic-messages'}]),undefined);
  assert.equal(dshSupervisorProtocol(role,dsh,[]),undefined);
  const extra=additionalMagpieRoute(role,dsh,[chatCap]);
  assert.equal(extra.protocol,'chat-completions');assert.equal(extra.supportsBuild,supportsDshSupervisorBuild);
  for(const binary of ['78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6','15ac29455f506ddd67238e9b553c4fd3c6f9354ed0c8c6a979527b8011777ef8','a'.repeat(64)]){
   assert.equal(supportsDshSupervisorBuild(binary),false);assert.equal(extra.supportsBuild(binary),false);
  }
 }
 for(const [role,actor,caps] of [['executor',dsh,[chatCap]],['planner1',dsh,[chatCap]],['planner2',{...dsh,runtime:'claude'},[chatCap]],
  ['planner2',{...dsh,runtime:'pi'},[chatCap]],['reviewer',{...dsh,authentication:'oauth'},[chatCap]],['reviewer',{...dsh,model:'org/a'},[chatCap]],['reviewer',dsh,undefined]])
  assert.equal(dshSupervisorProtocol(role,actor,caps),undefined);
 // A native Messages capability keeps the unchanged passthrough: the ladder stays out of the way.
 assert.equal(additionalMagpieRoute('reviewer',{...dsh,protocol:'anthropic-messages'},[{model:dsh.model,protocol:'anthropic-messages'}]),undefined);
});
test('DSH executor translation prefers Responses, falls back to Chat and needs no terminal tool',()=>{
 const dsh={...route(),runtime:'dsh',model:'org/A'};
 const chat={model:dsh.model,protocol:'chat-completions'},responses={model:dsh.model,protocol:'openai-responses'},messages={model:dsh.model,protocol:'anthropic-messages'};
 assert.equal(dshExecutorProtocol('executor',dsh,[chat]),'chat-completions');
 // Responses wins over Chat in either declaration order, matching the supervision lane.
 for(const caps of [[chat,responses],[responses,chat],[responses]])assert.equal(dshExecutorProtocol('executor',dsh,caps),'openai-responses');
 // A native Messages capability keeps the byte-identical passthrough and never enters the ladder.
 assert.equal(dshExecutorProtocol('executor',dsh,[messages]),undefined);
 assert.equal(dshExecutorProtocol('executor',dsh,[messages,chat]),undefined);
 assert.equal(dshExecutorProtocol('executor',dsh,[]),undefined);
 for(const [role,actor,caps] of [['planner2',dsh,[chat]],['reviewer',dsh,[chat]],['executor',{...dsh,runtime:'pi'},[chat]],
  ['executor',{...dsh,runtime:'claude'},[chat]],['executor',{...dsh,authentication:'oauth'},[chat]],['executor',{...dsh,model:'org/a'},[chat]],['executor',dsh,undefined]])
  assert.equal(dshExecutorProtocol(role,actor,caps),undefined);
 // The extra ladder routes the same pair behind the executor lane's own digest gate.
 for(const [caps,protocol] of [[[chat],'chat-completions'],[[chat,responses],'openai-responses'],[[responses],'openai-responses']]){
  const extra=additionalMagpieRoute('executor',dsh,caps);
  assert.equal(extra.protocol,protocol);assert.equal(extra.supportsBuild,supportsDshExecutorBuild);
  for(const binary of ['78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6','15ac29455f506ddd67238e9b553c4fd3c6f9354ed0c8c6a979527b8011777ef8','a'.repeat(64)]){
   assert.equal(supportsDshExecutorBuild(binary),false);assert.equal(extra.supportsBuild(binary),false);
  }
 }
 // Both wires are real controller paths, so the concrete route resolves each one.
 assert.equal(magpieRoutePath({...dsh,protocol:'openai-responses'}),'/v1/responses');
 assert.equal(magpieRoutePath({...dsh,protocol:'chat-completions'}),'/v1/chat/completions');
});
test('Codex translation takes a Messages-only model and never displaces Responses',()=>{
 const codex={...route(),runtime:'codex',model:'org/A'};
 const messages={model:codex.model,protocol:'anthropic-messages'},chat={model:codex.model,protocol:'chat-completions'},responses={model:codex.model,protocol:'openai-responses'};
 for(const role of ['planner2','reviewer']){
  assert.equal(codexSupervisorProtocol(role,codex,[messages]),'anthropic-messages');
  // A model that also advertises Responses stays on the reviewed Responses ladder.
  assert.equal(codexSupervisorProtocol(role,codex,[messages,responses]),undefined);
  // Chat is not excluded here: the primary selector resolves it first, so this ladder only runs
  // for a model that declares neither Responses nor Chat.
  assert.equal(customMagpieProtocol(role,'codex',[messages.protocol,chat.protocol]),'chat-completions');
  assert.equal(customMagpieProtocol(role,'codex',[messages.protocol,responses.protocol]),'openai-responses');
  assert.equal(customMagpieProtocol(role,'codex',[messages.protocol]),'anthropic-messages');
  // The executor of the same runtime is the third outlet of its own ladder, not an unrouted role:
  // the CLI still reads Responses, so this lane is a body and a transcript the product authors.
  assert.equal(customMagpieProtocol('executor','codex',[messages.protocol]),'anthropic-messages');
  const extra=additionalMagpieRoute(role,codex,[messages]);
  assert.equal(extra.protocol,'anthropic-messages');assert.equal(extra.supportsBuild,supportsCodexSupervisorBuild);
  // With Responses declared the primary selector already claims the wire, so the ladder is empty.
  assert.equal(additionalMagpieRoute(role,codex,[messages,responses]),undefined);
  // No build digest is claimed until a physical Codex turn is observed on the translated wire.
  for(const binary of ['78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6','15ac29455f506ddd67238e9b553c4fd3c6f9354ed0c8c6a979527b8011777ef8','a'.repeat(64)])
   assert.equal(supportsCodexSupervisorBuild(binary),false),assert.equal(extra.supportsBuild(binary),false);
 }
 for(const [role,actor,caps] of [['executor',codex,[messages]],['planner1',codex,[messages]],['planner2',{...codex,runtime:'claude'},[messages]],
  ['reviewer',{...codex,runtime:'dsh'},[messages]],['reviewer',{...codex,authentication:'oauth'},[messages]],
  ['reviewer',{...codex,model:'org/a'},[messages]],['reviewer',codex,undefined],['reviewer',codex,[]]])
  assert.equal(codexSupervisorProtocol(role,actor,caps),undefined);
 // A route already pinned to the native wire resolves the same lane, still behind its digest gate.
 const pinned=additionalMagpieRoute('reviewer',{...codex,protocol:'anthropic-messages'},[messages]);
 assert.equal(pinned.protocol,'anthropic-messages');assert.equal(pinned.supportsBuild,supportsCodexSupervisorBuild);
});
test('the translated selection requires a read-only CLI and exact per-model API capability',()=>{
 const selected={...route(),protocol:'openai-responses',model:'org/A:v2',runtime:'cline'};
 const caps=[{model:'org/A:v2',protocol:'openai-responses'}];
 for(const runtime of ['cline','opencode'])for(const role of ['planner2','reviewer'])
  assert.equal(matchesOfficialCliResponsesSelection(role,{...selected,runtime},caps),true);
 for(const [role,overrides,capabilities] of [
  ['executor',{},caps],['planner1',{},caps],['reviewer',{runtime:'pi'},caps],['reviewer',{authentication:'oauth'},caps],
  ['reviewer',{protocol:'chat-completions'},caps],['reviewer',{model:'org/a:v2'},caps],['reviewer',{},undefined],
  ['reviewer',{},[{model:selected.model,protocol:'chat-completions'},{model:'org/a:v2',protocol:selected.protocol}]],
 ])assert.equal(matchesOfficialCliResponsesSelection(role,{...selected,...overrides},capabilities),false);
});

test('old v5, the private TLS test build and unknown builds reject official CLI Responses translation',()=>{
 const physical={...route(),runtime:'opencode',protocol:'openai-responses'};
 const capabilities=[{model:physical.model,protocol:physical.protocol}];
 for(const binary of ['15ac29455f506ddd67238e9b553c4fd3c6f9354ed0c8c6a979527b8011777ef8','1c54421d1c5fac99fc7b0ac2aa85f403cb1679c1d2bc7763fc202a85d79c507c','0'.repeat(64)]){
  assert.equal(supportsOfficialCliResponsesBuild(binary),false);
  assert.equal(isOfficialCliResponsesRoute(binary,'planner2',physical,capabilities),false);
 }
});

test('the mapped route matches an independent canonical JSON and SHA256 vector',()=>{
 assert.equal(magpieRouteHash(route()),'9a20f15bf3c78e5646e40203925ad9c7101dd36cb6ac94c4c64b318cb87efeb3');assert.equal(magpieRoutePath(route()),'/v1/chat/completions');
});
test('DM aliases remain distinct from canonical upstream account IDs and are cloned',()=>{
 const input=route(),saved=concreteMagpieRoute(input);input.upstreamAccountRef='example/other';assert.equal(saved.accountRef,'dm-account-1');assert.equal(saved.upstreamAccountRef,'example/0123456789');
});
test('every concrete account, model, runtime and authentication choice changes the reserved route',()=>{
 const original=magpieRouteHash(route());for(const edit of [{runtime:'copilot-sdk'},{provider:'another',upstreamAccountRef:'another/0123456789'},{protocol:'openai-responses'},{model:'model-b'},{authentication:'oauth'},{authRef:'other-auth'},{accountRef:'other-alias'},{upstreamAccountRef:'example/abcdef0123'}])assert.notEqual(magpieRouteHash({...route(),...edit}),original);
});
test('a canonical account must have the exact provider and a stable opaque ID',()=>{
 for(const upstreamAccountRef of ['dm-account-1','other/0123456789','example/','example/UNKNOWN','example/user@example.invalid','example/a/b','example/../account','https://example/123','example/123\n',' example/123','example/123 '])assert.throws(()=>concreteMagpieRoute({...route(),upstreamAccountRef}),{code:'MAGPIE_ROUTE_INVALID'});
});
test('objects, inherited and hidden proof fields cannot masquerade as a concrete route',()=>{
 const hidden={...route()};Object.defineProperty(hidden,'verified',{value:true});const inherited={...route()};delete inherited.protocol;Object.setPrototypeOf(inherited,{protocol:'chat-completions'});
 for(const value of [{...route(),protocol:new String('chat-completions')},{...route(),authentication:new String('api_key')},hidden,inherited,{...route(),verified:true},{...route(),apiKey:'OFFLINE_NEVER_A_SECRET'}])assert.throws(()=>concreteMagpieRoute(value),{code:'MAGPIE_ROUTE_INVALID'});
});
test('protocol paths are fixed controller choices',()=>{
 for(const [protocol,path] of [['openai-responses','/v1/responses'],['anthropic-messages','/v1/messages']])assert.equal(magpieRoutePath({...route(),protocol}),path);assert.throws(()=>concreteMagpieRoute({...route(),protocol:'https://untrusted.invalid'}),{code:'MAGPIE_ROUTE_INVALID'});
});

test('route snapshot refuses getters and hidden fields without reading a dynamic account',()=>{
 let reads=0;const changing=route();Object.defineProperty(changing,'upstreamAccountRef',{enumerable:true,get(){reads++;return reads===1?'example/0123456789':'example/another';}});
 const hidden=route();Object.defineProperty(hidden,'upstreamAccountRef',{enumerable:false,value:'example/0123456789'});
 for(const input of [changing,hidden])assert.throws(()=>concreteMagpieRoute(input),{code:'MAGPIE_ROUTE_INVALID'});assert.equal(reads,0);
});

test('only a native Codex OpenAI subscription selects the ChatGPT backend path',()=>{
 const sub={...route(),runtime:'codex',provider:'openai',upstreamAccountRef:'openai/test',protocol:'openai-responses',authentication:'oauth'};
 assert.equal(magpieRoutePath(sub),'/backend-api/codex/responses');
 for(const change of [{authentication:'api_key'},{runtime:'independent'},{provider:'example',upstreamAccountRef:'example/test'}])
  assert.equal(magpieRoutePath({...sub,...change}),'/v1/responses');
});
