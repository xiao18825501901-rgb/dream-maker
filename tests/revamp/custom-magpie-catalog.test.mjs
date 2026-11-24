import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {registeredDshExecutorDigests} from '../../dist/server/magpie-route.js';
import {customMagpieCapabilityProtocol,parseDesktopMagpieCatalog,readDesktopMagpieCatalog,resolveCustomMagpieRoute,selectCustomMagpieMember} from '../../dist/server/flow/custom-magpie-catalog.js';

const account={provider:'deepseek-official',authentication:'api_key',authRef:'AUTH',accountRef:'acct'};
const limits={currency:'CNY',maxMicros:100};
const actor={id:'reviewer',...account,runtime:'independent',model:{kind:'model',id:'deepseek-v4-pro'},permissions:['source_read'],budget:limits,nativeException:false,transport:'magpie'};
const registered={...account,upstreamAccountRef:'deepseek-official/abcdef0123',model:'deepseek-flash',models:['deepseek-v4-pro']};
const observation={scope:'LOCAL_CONTROL_PROCESS_ONLY',accountCount:1,accounts:[registered],binaryHash:'a'.repeat(64)};
const members=['deepseek-flash','deepseek-v4-pro'].map((model,i)=>({id:'member'+i,provider:account.provider,authRef:account.authRef,accountRef:account.accountRef,permissions:actor.permissions,model}));
function profile(strategy){return {mode:'custom',laya:false,accounts:[account],roles:{planner2:{...actor,id:'planner2',runtime:'codex'},executors:[{...actor,id:'worker',runtime:'pi'}],reviewer:{...actor,model:{kind:'group',id:'models'},selectedMemberId:'member1'}},groups:[{id:'models',strategy,members}],privacy:{deniedProviders:[],deniedDataLabels:[]},timeZone:'UTC',budget:limits};}
const estimate=(b,r)=>({...b,reserveMicros:r.model==='deepseek-flash'?5:10,roleRemainingMicros:100,flowRemainingMicros:100,expiresAtMs:Date.now()+5000});
const select=(p,lookup=estimate,cursor)=>selectCustomMagpieMember(p,'reviewer','reviewer',observation,lookup,cursor);
const {recommendPreparedMember}=await import('../../dist/server/flow/custom-member-recommendation.js');
const {NativeOwner}=await import('../../dist/server/native-owner.js');
const {NativeBudget}=await import('../../dist/server/native-budget.js');
test('prepared recommendation uses the owned account, the native request estimate and the frozen role/flow caps',()=>{
 const p=structuredClone(profile('cost')),other={...account,authRef:'OTHER',accountRef:'other'};p.accounts.push(other);
 p.groups[0].members.unshift({...members[0],...{provider:other.provider,authRef:other.authRef,accountRef:other.accountRef},id:'foreign'});
 const snapshot={...p,projectId:'p1',runId:'r1',profile:{contentHash:'a'.repeat(64)}},observed={...observation,accountCount:2,accounts:[registered,{...registered,...other,upstreamAccountRef:'deepseek-official/other'}]};
 const price=model=>({provider:account.provider,model,currency:'CNY',source:'offline price fixture',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:model==='deepseek-flash'?5:10,inputHitMicrosPerMillion:0,outputMicrosPerMillion:1});
 let historyReads=0;
 const budget={requests:()=>{historyReads++;return [];},estimateCustomSelection:NativeBudget.prototype.estimateCustomSelection,preflightFor:NativeBudget.prototype.preflightFor,assertUsageBounds(){},checkReservationLimits(_price,amount,_repair,_engineering,custom){assert.equal(custom,true);return amount;}};
 const call=(obs=observed,read=(role,provider,model)=>{assert.equal(role,'reviewer');assert.equal(provider,account.provider);return price(model);})=>recommendPreparedMember(snapshot,'reviewer',obs,budget,128,read);
 const before=structuredClone(snapshot),r=call();assert.equal(r.memberId,'member0');assert.equal(r.reserveMicros,6);assert.equal(r.profileHash,snapshot.profile.contentHash);assert.deepEqual(snapshot,before);
 assert.equal(historyReads,1);
 assert.throws(()=>call({...observed,scope:'DESKTOP_METADATA_ONLY'}),{code:'CUSTOM_MAGPIE_OBSERVATION_INVALID'});
 assert.throws(()=>call({...observed,accountCount:0,accounts:[]}),{code:'CUSTOM_MAGPIE_NO_ELIGIBLE_MEMBER'});assert.equal(historyReads,1);
 for(const read of [()=>{throw Error('binding changed');},()=>price('unrelated'),(...args)=>({...price(args[2]),expiresAt:new Date(0).toISOString()})])assert.throws(()=>call(observed,read),{code:'CUSTOM_MAGPIE_ESTIMATE_UNAVAILABLE'});
 snapshot.roles.reviewer.budget={currency:'CNY',maxMicros:5};assert.throws(()=>call(),{code:'CUSTOM_MAGPIE_BUDGET_EXHAUSTED'});
});
test('prepared group selection rejects a run before opening control and rechecks after cleanup',async()=>{
 let running=true,opened=0;const frozen={id:'frozen'},input={projectId:'p'},before=structuredClone(frozen);
 const owner={context:{store:{runs:()=>running?[frozen]:[]}},configured:()=>({op:{maxRequests:10}}),customAccountSelection:()=>({prepared:{flowConfig:{...profile('cost'),runId:'frozen'}},budget:{requests:()=>[]}}),withCustomMagpieControl:async()=>{opened++;running=true;return {expiresAtMs:Date.now()+5000};}};
 const call=()=>NativeOwner.prototype.recommendCustomMagpieMember.call(owner,input,'reviewer',new AbortController().signal);
 await assert.rejects(call(),{code:'FLOW_TERMINATION_REQUIRED'});assert.equal(opened,0);running=false;await assert.rejects(call(),{code:'FLOW_TERMINATION_REQUIRED'});assert.equal(opened,1);assert.deepEqual(frozen,before);
});
test('invalid prepared recommendations reject before spending history, quotes and account control',async()=>{
 for(const [roleId,mutate,code] of [
  ['missing',()=>{},'CUSTOM_MAGPIE_SELECTION_SCOPE_INVALID'],['worker',()=>{},'CUSTOM_MAGPIE_SELECTION_SCOPE_INVALID'],
  ['reviewer',p=>p.privacy.deniedDataLabels.push('private'),'CUSTOM_MAGPIE_SELECTION_SCOPE_INVALID'],
  ['reviewer',p=>{p.groups[0].members[0].permissions=['source_read','source_write'];},'FLOW_PROFILE_GROUP_SCOPE_INVALID'],
  ['reviewer',p=>{p.groups[0].members[0].accountRef='wrong';},'FLOW_PROFILE_GROUP_SCOPE_INVALID']
 ]){
  const snapshot=structuredClone(profile('cost'));mutate(snapshot);
  let history=0,quotes=0,controls=0;const budget={requests(){history++;return [];}};
  const owner={context:{store:{runs:()=>[]}},configured:()=>({op:{maxRequests:10}}),customAccountSelection:()=>({prepared:{flowConfig:snapshot},budget}),withCustomMagpieControl(){controls++;}};
  await assert.rejects(NativeOwner.prototype.recommendCustomMagpieMember.call(owner,{projectId:'p'},roleId,new AbortController().signal),{code});
  assert.throws(()=>recommendPreparedMember(snapshot,roleId,observation,budget,128,()=>{quotes++;}),{code});
  assert.deepEqual([history,quotes,controls],[0,0,0]);
 }
});
const list={object:'list',has_more:false,data:[{object:'model',id:'string/example',owned_by:'string',native_endpoints:['/v1/messages','/v1/responses','/v1/chat/completions','/unknown'],pricing:{},credential:'discard'},{object:'model',id:'group/cheap',owned_by:'string'}]};
test('desktop lookup issues only one local metadata GET and projects provider and alias rows',async()=>{
 const seen=[];const server=createServer((req,res)=>{seen.push([req.method,req.url,req.headers.authorization]);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(list));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const result=await readDesktopMagpieCatalog(server.address().port);assert.deepEqual(seen,[['GET','/v1/models',undefined]]);assert.deepEqual(result,{scope:'DESKTOP_METADATA_ONLY',models:[{id:'string/example',provider:'string',kind:'provider',protocols:['anthropic-messages','openai-responses','chat-completions']},{id:'group/cheap',provider:'string',kind:'alias',protocols:[]}]});}finally{await new Promise(resolve=>server.close(resolve));}
});
test('catalog rejects pagination, duplicate IDs, redirects and oversize responses',async()=>{
 for(const raw of [{...list,has_more:true},{...list,data:[list.data[0],list.data[0]]}])assert.throws(()=>parseDesktopMagpieCatalog(raw),{code:'CUSTOM_MAGPIE_CATALOG_INVALID'});
 let calls=0;const server=createServer((req,res)=>{if(++calls===1){res.writeHead(302,{location:'/other'});res.end();}else{res.writeHead(200,{'content-type':'application/json'});res.end(Buffer.alloc(4*1024*1024+1));}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{await assert.rejects(readDesktopMagpieCatalog(server.address().port),{code:'CUSTOM_MAGPIE_CATALOG_UNAVAILABLE'});await assert.rejects(readDesktopMagpieCatalog(server.address().port),{code:'CUSTOM_MAGPIE_CATALOG_TOO_LARGE'});assert.equal(calls,2);}finally{await new Promise(resolve=>server.close(resolve));}
});
test('owned route preserves both refs, canonical account, secondary model and physical protocol',()=>{
 assert.deepEqual(resolveCustomMagpieRoute(observation,'reviewer',actor),{...account,runtime:'independent',protocol:'chat-completions',model:'deepseek-v4-pro',upstreamAccountRef:registered.upstreamAccountRef});
 for(const bad of [{...actor,authRef:'other'},{...actor,accountRef:'other'}])assert.throws(()=>resolveCustomMagpieRoute(observation,'reviewer',bad),{code:'CUSTOM_ACCOUNT_SOURCE_MISMATCH'});
 assert.throws(()=>resolveCustomMagpieRoute({...observation,accounts:[registered,registered],accountCount:2},'reviewer',actor),{code:'CUSTOM_ACCOUNT_SOURCE_MISMATCH'});
 for(const runtime of ['dsh','pi','opencode','cline'])assert.throws(()=>resolveCustomMagpieRoute(observation,'reviewer',{...actor,runtime}),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
});
test('explicit capabilities match one model and harness protocol without using legacy model or endpoint hints',()=>{
 const model=actor.model.id;
 const caps=[{model,protocol:'chat-completions',endpoint:'https://api.example.test/v1/chat/completions'},{model:'other',protocol:'openai-responses',endpoint:'https://api.example.test/v1/responses'}];
 const wire=(runtime,role,capabilities)=>customMagpieCapabilityProtocol(role,{...actor,runtime},capabilities);
 assert.equal(wire('codex','planner2',caps),'chat-completions');
 const responses={...caps[1],model};
 assert.equal(wire('codex','planner2',[...caps,responses]),'openai-responses');
 assert.equal(wire('cline','reviewer',[responses]),undefined);
 // Every CLI executor leg falls back to the translated ladder when its own wire is undeclared.
 assert.equal(wire('opencode','executor',caps),'chat-completions');
 assert.equal(wire('pi','executor',caps),'chat-completions');
 assert.equal(wire('claude','reviewer',caps),undefined);
 const messages={model,protocol:'anthropic-messages',endpoint:'https://api.example.test/v1/messages'};
 assert.equal(wire('dsh','executor',[messages]),'anthropic-messages');
 assert.equal(wire('claude','reviewer',[messages]),'anthropic-messages');
 assert.equal(wire('claude','planner2',[messages]),'anthropic-messages');
 // The Claude executor leg prefers native Messages and falls back to the translated ladder; the
 // outlet is named here while its own reviewed build digest stays empty, because naming a lane is
 // not opening it (see magpie-route.supportsClaudeExecutorTranslatedBuild).
 assert.equal(wire('claude','executor',[messages]),'anthropic-messages');
 assert.equal(wire('claude','executor',[caps[0]]),'chat-completions');
 // A Codex read role reads Responses locally, so a Messages-only model is a translated lane that
 // loses to the already-verified Chat outlet and to the reviewed Responses ladder.
 assert.equal(wire('codex','planner2',[messages]),'anthropic-messages');
 assert.equal(wire('codex','reviewer',[messages]),'anthropic-messages');
 assert.equal(wire('codex','planner2',[messages,caps[0]]),'chat-completions');
 assert.equal(wire('codex','planner2',[messages,responses]),'openai-responses');
 // Codex's own wire is Responses, so a Messages-only model reaches the third rung of the same
 // executor ladder: the product renders the Anthropic body and rebuilds the CLI's Responses answer,
 // behind its own (still empty) digest set. Naming the outlet is not opening it.
 assert.equal(wire('codex','executor',[messages]),'anthropic-messages');
 assert.equal(wire('codex','executor',[messages,caps[0]]),'chat-completions');
 assert.equal(wire('codex','executor',[messages,responses]),'openai-responses');
 // A read-only CLI whose model declares only the native Messages wire keeps that wire;
 // Chat still wins when the model declares it, and Responses stays on its reviewed ladder.
 for(const runtime of ['opencode','cline'])for(const role of ['planner2','reviewer'])
  assert.equal(wire(runtime,role,[messages]),'anthropic-messages');
 // OpenCode and Cline are executor legs on their own Messages wire, exactly like Claude Code;
 // Codex keeps Messages as the translated outlet last on its ladder.
 assert.equal(wire('opencode','executor',[messages]),'anthropic-messages');
 assert.equal(wire('cline','executor',[messages]),'anthropic-messages');
 assert.equal(wire('codex','executor',[messages]),'anthropic-messages');
 // A Chat-only model is the translated outlet of the same leg, exactly as for Claude and Cline.
 assert.equal(wire('opencode','executor',[caps[0]]),'chat-completions');
 assert.equal(wire('cline','executor',[caps[0]]),'chat-completions');
 assert.equal(wire('codex','executor',[caps[0]]),'chat-completions');
 assert.equal(wire('pi','executor',[messages]),undefined);
 // The independent runner only speaks Chat, so it has no Messages outlet and fails closed.
 assert.equal(wire('independent','reviewer',[messages]),undefined);
 assert.equal(wire('opencode','reviewer',[messages,caps[0]]),'chat-completions');
 assert.equal(wire('cline','reviewer',[messages,responses]),undefined);
 for(const binaryHash of ['a'.repeat(64),'80db8d25fae1b73556b92700fb9c72388475bf717ede8580a9e8ade2f5272510','940711059f87125f893dc009f0146d4f065ea6448384e168554024790c113e79']){
  assert.throws(()=>resolveCustomMagpieRoute({...observation,binaryHash,accounts:[{...registered,capabilities:caps}]},'reviewer',actor),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
 }
});
test('verified v5 resolves declared protocols on the registered account and preserves the legacy CLI pin',()=>{
 const binaryHash='15ac29455f506ddd67238e9b553c4fd3c6f9354ed0c8c6a979527b8011777ef8';
 const model=actor.model.id;
 const capabilities=[{model,protocol:'openai-responses',endpoint:'https://api.example.test/v1/responses'}];
 const session={...observation,binaryHash,accounts:[{...registered,capabilities}]};
 const planner={...actor,id:'planner2',runtime:'codex'};
 assert.deepEqual(resolveCustomMagpieRoute(session,'planner2',planner),{...account,runtime:'codex',protocol:'openai-responses',model,upstreamAccountRef:registered.upstreamAccountRef});
 for(const invalid of [{...planner,model:{kind:'model',id:registered.model}},{...planner,runtime:'cline'},{...planner,accountRef:'other'}])assert.throws(()=>resolveCustomMagpieRoute(session,'planner2',invalid),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
 for(const runtime of ['opencode','cline'])assert.throws(()=>resolveCustomMagpieRoute({...observation,binaryHash},'reviewer',{...actor,runtime}),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
});
test('reviewed CLI build resolves Responses for four read roles and prefers declared Chat',()=>{
 const binaryHash='78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6',model=actor.model.id;
 const caps=[{model,protocol:'openai-responses',endpoint:'https://api.example.test/v1/responses'}];
 const session={...observation,binaryHash,accounts:[{...registered,capabilities:caps}]};
 for(const runtime of ['opencode','cline'])for(const role of ['planner2','reviewer']){
  const resolved=resolveCustomMagpieRoute(session,role,{...actor,id:role,runtime});
  assert.deepEqual(resolved,{...account,runtime,protocol:'openai-responses',model,upstreamAccountRef:registered.upstreamAccountRef});
 }
 caps.push({model,protocol:'chat-completions',endpoint:'https://api.example.test/v1/chat/completions'});
 assert.equal(resolveCustomMagpieRoute(session,'reviewer',{...actor,runtime:'cline'}).protocol,'chat-completions');
});
test('a registered build resolves the declared Messages wire for both read-only CLIs',()=>{
 // The union gate admits an explicitly registered build; it is not a claim about a physical binary.
 const binaryHash='15ac29455f506ddd67238e9b553c4fd3c6f9354ed0c8c6a979527b8011777ef8',model=actor.model.id;
 const capabilities=[{model,protocol:'anthropic-messages',endpoint:'https://api.example.test/v1/messages'}];
 const session={...observation,binaryHash,accounts:[{...registered,capabilities}]};
 for(const runtime of ['opencode','cline'])for(const role of ['planner2','reviewer'])
  assert.deepEqual(resolveCustomMagpieRoute(session,role,{...actor,id:role,runtime}),{...account,runtime,protocol:'anthropic-messages',model,upstreamAccountRef:registered.upstreamAccountRef});
 for(const runtime of ['opencode','cline'])
  assert.throws(()=>resolveCustomMagpieRoute({...observation,binaryHash:'a'.repeat(64),accounts:[{...registered,capabilities}]},'reviewer',{...actor,runtime}),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
 const both={...session,accounts:[{...registered,capabilities:[...capabilities,{model,protocol:'openai-responses',endpoint:'https://api.example.test/v1/responses'}]}]};
 for(const runtime of ['opencode','cline'])
  assert.throws(()=>resolveCustomMagpieRoute(both,'reviewer',{...actor,runtime}),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
});

test('a declared Chat capability reaches the DSH supervision ladder but stays closed without a registered build',()=>{
 // The explicit-capability build only proves the union gate; the lane keeps its own digest set.
 const binaryHash='15ac29455f506ddd67238e9b553c4fd3c6f9354ed0c8c6a979527b8011777ef8',model=actor.model.id;
 const chat={model,protocol:'chat-completions',endpoint:'https://api.example.test/v1/chat/completions'};
 const session={...observation,binaryHash,accounts:[{...registered,capabilities:[chat]}]};
 for(const role of ['planner2','reviewer']){
  assert.throws(()=>resolveCustomMagpieRoute(session,role,{...actor,id:role,runtime:'dsh'}),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
  assert.throws(()=>resolveCustomMagpieRoute({...session,binaryHash:'a'.repeat(64)},role,{...actor,id:role,runtime:'dsh'}),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
 }
 // The declared native Messages wire keeps resolving through the unchanged passthrough.
 const messages={...session,accounts:[{...registered,capabilities:[{model,protocol:'anthropic-messages',endpoint:'https://api.example.test/v1/messages'}]}]};
 assert.equal(resolveCustomMagpieRoute(messages,'reviewer',{...actor,runtime:'dsh'}).protocol,'anthropic-messages');
});
test('a DSH executor resolves declared Responses ahead of Chat only on its own registered build',()=>{
 const binaryHash=registeredDshExecutorDigests()[0],model=actor.model.id;
 const chat={model,protocol:'chat-completions',endpoint:'https://api.example.test/v1/chat/completions'};
 const responses={model,protocol:'openai-responses',endpoint:'https://api.example.test/v1/responses'};
 const messages={model,protocol:'anthropic-messages',endpoint:'https://api.example.test/v1/messages'};
 const session=caps=>({...observation,binaryHash,accounts:[{...registered,capabilities:caps}]});
 // An executor is its own role id; planner2/reviewer never run the executor lane.
 const executor={...actor,id:'worker',runtime:'dsh'};
 const resolve=caps=>resolveCustomMagpieRoute(session(caps),'executor',executor);
 assert.equal(resolve([chat]).protocol,'chat-completions');
 for(const caps of [[chat,responses],[responses,chat],[responses]])assert.equal(resolve(caps).protocol,'openai-responses');
 // A declared native Messages wire keeps the unchanged passthrough on every mix.
 for(const caps of [[messages],[messages,chat],[chat,messages,responses]])assert.equal(resolve(caps).protocol,'anthropic-messages');
 // The union gate only admits the build; the executor lane keeps its own digest set.
 for(const binaryHash of ['15ac29455f506ddd67238e9b553c4fd3c6f9354ed0c8c6a979527b8011777ef8','a'.repeat(64)])
  assert.throws(()=>resolveCustomMagpieRoute({...session([chat,responses]),binaryHash},'executor',executor),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
 // A supervision role takes its own lane first, so the executor ladder never claims those wires.
 for(const role of ['planner2','reviewer'])
  assert.equal(resolveCustomMagpieRoute(session([chat,responses]),role,{...actor,id:role,runtime:'dsh'}).protocol,'openai-responses');
});
test('a Codex role resolves the declared Messages wire through the capability selector',()=>{
 const binaryHash='15ac29455f506ddd67238e9b553c4fd3c6f9354ed0c8c6a979527b8011777ef8',model=actor.model.id;
 const messages={model,protocol:'anthropic-messages',endpoint:'https://api.example.test/v1/messages'};
 const session={...observation,binaryHash,accounts:[{...registered,capabilities:[messages]}]};
 for(const role of ['planner2','reviewer'])
  assert.deepEqual(resolveCustomMagpieRoute(session,role,{...actor,id:role,runtime:'codex'}),{...account,runtime:'codex',protocol:'anthropic-messages',model,upstreamAccountRef:registered.upstreamAccountRef});
 // A model that also declares Responses keeps the reviewed Responses selection instead.
 const both={...session,accounts:[{...registered,capabilities:[messages,{model,protocol:'openai-responses',endpoint:'https://api.example.test/v1/responses'}]}]};
 assert.equal(resolveCustomMagpieRoute(both,'planner2',{...actor,id:'planner2',runtime:'codex'}).protocol,'openai-responses');
 // Chat still wins over the unverified Messages lane for a Codex read role.
 const chat={model,protocol:'chat-completions',endpoint:'https://api.example.test/v1/chat/completions'};
 const chatSession={...session,accounts:[{...registered,capabilities:[messages,chat]}]};
 assert.equal(resolveCustomMagpieRoute(chatSession,'planner2',{...actor,id:'planner2',runtime:'codex'}).protocol,'chat-completions');
});
test('CLI Reviewer Pro requires the reviewed binary and registered account on its chat path',()=>{
 const candidate='940711059f87125f893dc009f0146d4f065ea6448384e168554024790c113e79';
 const deployed='80db8d25fae1b73556b92700fb9c72388475bf717ede8580a9e8ade2f5272510';
 for(const runtime of ['opencode','cline']){
  const reviewer={...actor,runtime};
  const session={...observation,binaryHash:candidate};
  assert.deepEqual(resolveCustomMagpieRoute(session,'reviewer',reviewer),{...account,runtime,protocol:'chat-completions',model:'deepseek-v4-pro',upstreamAccountRef:registered.upstreamAccountRef});
  for(const binaryHash of [deployed,'b'.repeat(64)])assert.throws(()=>resolveCustomMagpieRoute({...session,binaryHash},'reviewer',reviewer),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
  assert.throws(()=>resolveCustomMagpieRoute(session,'planner2',{...reviewer,id:'planner2'}),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
  assert.throws(()=>resolveCustomMagpieRoute(session,'reviewer',{...reviewer,accountRef:'other'}),{code:'CUSTOM_ACCOUNT_SOURCE_MISMATCH'});
 }
});
test('policy selection keeps the profile frozen and implements stable ties, rotation and eligible fallback',()=>{
 for(const [strategy,expected] of [['failure_only','member1'],['smart','member1'],['rotate','member1'],['cost','member0']]){const p=profile(strategy),before=structuredClone(p);assert.equal(select(p).memberId,expected);assert.deepEqual(p,before);}
 assert.equal(select(profile('rotate'),estimate,'member1').memberId,'member0');assert.equal(select(profile('rotate'),estimate,'member0').memberId,'member1');
 assert.equal(select(profile('failure_only'),(b,r)=>r.model==='deepseek-flash'?estimate(b,r):undefined).memberId,'member0');
 assert.equal(select(profile('cost'),(b,r)=>({...estimate(b,r),reserveMicros:5})).memberId,'member0');
});
test('unknown, misbound, expired, exhausted and privacy-denied budgets fail distinctly',()=>{
 for(const change of [{currency:'USD'},{profileHash:'other'},{roleId:'other'},{routeHash:'other'},{reserveMicros:0},{expiresAtMs:0},{reserveMicros:NaN}])assert.throws(()=>select(profile('cost'),(b,r)=>({...estimate(b,r),...change})),{code:'CUSTOM_MAGPIE_ESTIMATE_UNAVAILABLE'});
 assert.throws(()=>select(profile('cost'),()=>undefined),{code:'CUSTOM_MAGPIE_ESTIMATE_UNAVAILABLE'});
 for(const change of [{roleRemainingMicros:1},{flowRemainingMicros:1},{reserveMicros:101}])assert.throws(()=>select(profile('cost'),(b,r)=>({...estimate(b,r),...change})),{code:'CUSTOM_MAGPIE_BUDGET_EXHAUSTED'});
 const invalidMember=structuredClone(profile('cost'));invalidMember.groups[0].members[0].permissions=['source_read','source_write'];
 let calls=0;const neverQuote=()=>{calls++;};
 assert.throws(()=>select(invalidMember,neverQuote),{code:'FLOW_PROFILE_GROUP_SCOPE_INVALID'});
 const denied=structuredClone(profile('cost'));
 const other={provider:'string',authRef:'STRING_REF',accountRef:'string-account',authentication:'api_key'};
 denied.accounts.push(other);denied.groups[0].members[0]={...denied.groups[0].members[0],provider:other.provider,authRef:other.authRef,accountRef:other.accountRef};denied.privacy.deniedProviders.push('string');
 assert.throws(()=>select(denied,neverQuote),{code:'FLOW_PROFILE_GROUP_SCOPE_INVALID'});assert.equal(calls,0);
 const p=profile('cost');p.privacy.deniedDataLabels=['private'];assert.throws(()=>select(p),{code:'CUSTOM_MAGPIE_SELECTION_SCOPE_INVALID'});
});
