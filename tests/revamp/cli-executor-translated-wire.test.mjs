// OFFLINE contract only: no model, no account, no Store, no dispatch, no CLI process.
//
// Scope: the translated outlet of the four CLI executor legs. A CLI harness keeps the wire its own
// tools speak; when the model declares only an OpenAI wire the product gateway replays the CLI's
// request onto that wire (flow/cli-executor-wire.ts, over the shared neutral transcript in
// flow/executor-transcript.ts) and rebuilds the CLI's own dialect from the answer. This suite locks
// three things:
//   - the runtime x wire ladder, per harness, and that no harness answers for another,
//   - the route layer: the translated outlet is named by the ladder and gated by its own registered
//     set, and every digest no lane registered is refused (fail-closed),
//   - the translation itself: tool declarations, calls and results survive the round trip in both
//     directions, and every departure from the accepted shape is refused.
import test from 'node:test';import assert from 'node:assert/strict';
import {customMagpieProtocol,claudeExecutorProtocol,clineExecutorProtocol,codexExecutorProtocol,opencodeExecutorProtocol} from '../../dist/shared/custom-magpie-protocol.js';
import {registeredCliExecutorDigests,registeredClineExecutorDigests,registeredDshExecutorDigests,registeredDshSupervisorDigests} from '../../dist/server/magpie-route.js';
import {additionalMagpieRoute,concreteMagpieRoute,supportsClaudeExecutorBuild,supportsClaudeExecutorTranslatedBuild,supportsClineExecutorBuild,supportsClineExecutorTranslatedBuild,supportsCodexExecutorBuild,supportsCodexExecutorMessagesBuild,supportsCodexExecutorTranslatedBuild,supportsOpencodeExecutorBuild,supportsOpencodeExecutorTranslatedBuild} from '../../dist/server/magpie-route.js';
import {createCliExecutorExchange} from '../../dist/server/flow/cli-executor-wire.js';

const MODEL='deepseek-flash',PROVIDER='deepseek-fixture',QUALIFIED=PROVIDER+'/'+MODEL;
const NATIVE={claude:'anthropic-messages',opencode:'anthropic-messages',cline:'anthropic-messages',codex:'openai-responses'};
// Codex's third rung is the native Messages wire: the CLI still reads Responses locally, so that
// outlet is a translation this product authors and it keeps a separate digest set of its own
// (tests/revamp/codex-executor-messages.test.mjs locks that lane).
const TRANSLATED={claude:['openai-responses','chat-completions'],opencode:['openai-responses','chat-completions'],
 cline:['openai-responses','chat-completions'],codex:['chat-completions','anthropic-messages']};
const REQUEST={request:'CLI_EXECUTOR_REQUEST_INVALID',completion:'MODEL_GATEWAY_COMPLETION_INVALID',usage:'NATIVE_USAGE_UNKNOWN'};
const upstream=(body,media='text/event-stream')=>new Response(body,{headers:{'content-type':media}});
const frames=sse=>sse.trimEnd().split('\n\n').map(block=>JSON.parse(block.split('\n')[1].slice(6)));
const routeOf=(runtime,protocol)=>({runtime,provider:PROVIDER,protocol,model:MODEL,authentication:'api_key',
 authRef:'offline_auth',accountRef:'offline_account',upstreamAccountRef:PROVIDER+'/offline_peer'});
const capabilities=protocol=>[{model:MODEL,protocol}];
// The registry is the only source of a product digest: a rebuild renames the build, so a pinned
// constant would turn a green lane into a false failure. A digest is used as a fail-closed negative
// only once the product proves that no lane registered it.
const registeredDigests=()=>new Set([...registeredCliExecutorDigests(),...registeredClineExecutorDigests(),
 ...registeredDshExecutorDigests(),...registeredDshSupervisorDigests()]);
const negatives=()=>{const hashes=['a'.repeat(64),'0'.repeat(64),'f'.repeat(64)].filter(hash=>!registeredDigests().has(hash));
 assert.equal(hashes.length,3,'the fail-closed fixtures are registered by no lane');return hashes;};

// ---------------------------------------------------------------- the ladder, per harness ----
test('four runtimes x translated wires: each harness prefers its own wire and falls back in ladder order',()=>{
 const fns={claude:claudeExecutorProtocol,opencode:opencodeExecutorProtocol,cline:clineExecutorProtocol,codex:codexExecutorProtocol};
 for(const [runtime,fn] of Object.entries(fns)){
  const native=NATIVE[runtime];
  // Native always wins, whatever else the model declares.
  assert.equal(fn('executor',runtime,[native]),native,runtime);
  assert.equal(fn('executor',runtime,[...TRANSLATED[runtime],native]),native,runtime);
  assert.equal(customMagpieProtocol('executor',runtime,[...TRANSLATED[runtime],native]),native,runtime);
  // Without it, Responses is preferred over Chat - except Codex, whose own wire is Responses; and
  // Chat is preferred over the Messages outlet that sits below it on that same ladder.
  for(const only of TRANSLATED[runtime]){
   assert.equal(fn('executor',runtime,[only]),only,runtime+' '+only);
   assert.equal(customMagpieProtocol('executor',runtime,[only]),only,runtime+' '+only);
  }
  if(runtime!=='codex')assert.equal(fn('executor',runtime,['openai-responses','chat-completions']),'openai-responses',runtime);
  else assert.equal(fn('executor',runtime,['chat-completions','anthropic-messages']),'chat-completions','codex chat over messages');
  // A model that declares nothing leaves the role unrouted; no harness answers for another; and no
  // supervision role ever reaches an executor outlet.
  assert.equal(fn('executor',runtime,[]),undefined,runtime);
  for(const role of ['planner2','reviewer'])assert.equal(fn(role,runtime,[...TRANSLATED[runtime],native]),undefined,runtime+' '+role);
  for(const other of Object.keys(fns).filter(value=>value!==runtime))
   for(const wire of [native,...TRANSLATED[runtime]])assert.equal(fn('executor',other,[wire]),undefined,runtime+' claims '+other);
 }
});

// ------------------------------------------------------------------- route layer, closed ----
test('the translated outlet answers its own evidence set, and refuses every unregistered digest',()=>{
 const physical=registeredCliExecutorDigests()[0];
 const nativeSet={claude:supportsClaudeExecutorBuild,opencode:supportsOpencodeExecutorBuild,
  cline:supportsClineExecutorBuild,codex:supportsCodexExecutorBuild};
 const translatedSet={claude:supportsClaudeExecutorTranslatedBuild,opencode:supportsOpencodeExecutorTranslatedBuild,
  cline:supportsClineExecutorTranslatedBuild,codex:supportsCodexExecutorTranslatedBuild};
 // Codex's Messages outlet is a third translated lane, so it answers a third set of its own.
 const outletSet=(runtime,wire)=>runtime==='codex'&&wire==='anthropic-messages'?supportsCodexExecutorMessagesBuild:translatedSet[runtime];
 for(const runtime of Object.keys(NATIVE)){
  for(const wire of TRANSLATED[runtime]){
   const lane=additionalMagpieRoute('executor',concreteMagpieRoute(routeOf(runtime,wire)),capabilities(wire));
   assert.ok(lane,runtime+' '+wire);
   assert.equal(lane.protocol,wire,runtime+' '+wire);
   // The resolved outlet answers its own set and not the native one: the sets are separate
   // evidence, so a native-only digest could never open a translated outlet even if the same
   // image happens to hold both.
   assert.equal(lane.supportsBuild,outletSet(runtime,wire),runtime+' '+wire);
   assert.notEqual(lane.supportsBuild,nativeSet[runtime],runtime+' '+wire);
   assert.equal(lane.supportsBuild(physical),outletSet(runtime,wire)(physical),runtime+' '+wire);
   // Fail-closed on anything nobody registered, including the zero hash and a synthetic digest.
   for(const hash of negatives())
    assert.equal(lane.supportsBuild(hash),false,runtime+' '+wire+' '+hash);
  }
 }
// A native route still resolves the native leg and its own evidence.
 for(const runtime of Object.keys(NATIVE)){
  const lane=additionalMagpieRoute('executor',concreteMagpieRoute(routeOf(runtime,NATIVE[runtime])),capabilities(NATIVE[runtime]));
  assert.equal(lane.supportsBuild,nativeSet[runtime],runtime+' native lane');
 }
});

// --------------------------------------------------------------- translation, both ways ----
const prompt='Inspect src/app.ts and run the test.';
const readSchema={type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false};
const bashSchema={type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false};
const tools=()=>[{name:'Read',description:'Read one file.',input_schema:structuredClone(readSchema)},
 {name:'Bash',description:'Run one command.',input_schema:structuredClone(bashSchema)}];
const toolNames=['Read','Bash'];
const user=(text=prompt)=>({role:'user',content:[{type:'text',text}]});
const assistantCalls=(calls,text)=>({role:'assistant',content:[...(text===undefined?[]:[{type:'text',text}]),
 ...calls.map(call=>({type:'tool_use',id:call.id,name:call.name,input:call.input}))]});
const results=list=>({role:'user',content:list.map(row=>({type:'tool_result',tool_use_id:row.id,
 content:[{type:'text',text:row.output}],...(row.error===undefined?{}:{is_error:row.error})}))});
const requestBody=()=>({model:MODEL,stream:true,max_tokens:512,thinking:{type:'disabled'},
 system:[{type:'text',text:'You are the frozen CLI executor.'}],messages:[user(prompt)],tools:tools()});
const roundTrip=()=>{const body=requestBody();
 body.messages=[user(),assistantCalls([{id:'toolu_01',name:'Read',input:{path:'src/app.ts'}}]),results([{id:'toolu_01',output:'export const a = 1;'}])];
 return body;};
const parallel=()=>{const body=requestBody();
 body.messages=[user(),assistantCalls([{id:'toolu_01',name:'Read',input:{path:'src/app.ts'}},{id:'toolu_02',name:'Bash',input:{command:'node -v'}}]),
  results([{id:'toolu_01',output:'export const a = 1;'},{id:'toolu_02',output:'v24.19.0'}])];
 return body;};
const multiTurn=()=>{const body=requestBody();
 body.messages=[user(),assistantCalls([{id:'toolu_01',name:'Read',input:{path:'a.ts'}}],'Reading.'),
  results([{id:'toolu_01',output:'A'}]),
  assistantCalls([{id:'toolu_02',name:'Bash',input:{command:'node -v'}}]),results([{id:'toolu_02',output:'v24'}]),
  assistantCalls([{id:'toolu_03',name:'Read',input:{path:'b.ts'}}]),results([{id:'toolu_03',output:'B'}])];
 return body;};
const ingress=(body,runtime='claude')=>runtime==='codex'
 ?{method:'POST',path:'/v1/responses',contentType:'application/json',body:typeof body==='string'?body:JSON.stringify(body)}
 :{method:'POST',path:'/v1/messages',version:'2023-06-01',contentType:'application/json',body:typeof body==='string'?body:JSON.stringify(body)};
const context=(runtime,protocol='chat-completions')=>{
 const route=routeOf(runtime,protocol);
 return {route,role:'executor',accounts:[{...route,capabilities:capabilities(protocol)}],
  limits:{model:MODEL,maxInputTokens:128,maxOutputTokens:512},assertCurrent(){},assertSafe(){},signal:new AbortController().signal};
};
const exchange=ctx=>createCliExecutorExchange(ctx);
const failure=code=>error=>error.code===code;

const chatFrame=(choices,extra={})=>({id:'fixture_cli_1',object:'chat.completion.chunk',created:1,model:QUALIFIED,choices,...extra});
const usage=()=>({prompt_tokens:9,completion_tokens:4,prompt_tokens_details:{cached_tokens:2},total_tokens:13});
const data=row=>'data: '+JSON.stringify(row)+'\n\n';
function chatToolStream(){
 return [data(chatFrame([{index:0,delta:{role:'assistant',content:''},finish_reason:null}])),
  data(chatFrame([{index:0,delta:{tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'Read',arguments:'{"path":"src/app.ts"}'}}]},finish_reason:null}])),
  data(chatFrame([{index:0,delta:{tool_calls:[{index:1,id:'call_2',type:'function',function:{name:'Bash',arguments:'{"command":"node -v"}'}}]},finish_reason:null}])),
  data(chatFrame([{index:0,delta:{},finish_reason:'tool_calls'}],{usage:usage()})),'data: [DONE]\n\n'].join('');
}
function chatTextStream(text='CLI_TURN_COMPLETE'){
 return [data(chatFrame([{index:0,delta:{role:'assistant',content:text},finish_reason:null}])),
  data(chatFrame([{index:0,delta:{},finish_reason:'stop'}],{usage:usage()})),'data: [DONE]\n\n'].join('');
}

test('Messages tool round trip becomes Chat tool_calls and tool rows, and the answer is rebuilt as tool_use blocks',async()=>{
 const prepared=exchange(context('claude')).prepare(ingress(parallel()));
 assert.equal(prepared.path,'/v1/chat/completions');
 const wire=JSON.parse(prepared.body);
 // Declarations survive with their schemas.
 assert.deepEqual(wire.tools,[{type:'function',function:{name:'Read',description:'Read one file.',parameters:readSchema}},
  {type:'function',function:{name:'Bash',description:'Run one command.',parameters:bashSchema}}]);
 // One assistant envelope carrying both calls in order, then one tool row per answer.
 assert.deepEqual(wire.messages,[{role:'system',content:'You are the frozen CLI executor.'},
  {role:'user',content:prompt},
  {role:'assistant',content:null,tool_calls:[{id:'toolu_01',type:'function',function:{name:'Read',arguments:'{"path":"src/app.ts"}'}},
   {id:'toolu_02',type:'function',function:{name:'Bash',arguments:'{"command":"node -v"}'}}]},
  {role:'tool',tool_call_id:'toolu_01',content:'export const a = 1;'},
  {role:'tool',tool_call_id:'toolu_02',content:'v24.19.0'}]);
 // The answer: one tool_use block per call, in the CLI's own dialect.
 const out=await prepared.complete(upstream(chatToolStream()));
 assert.equal(out.finishReason,'tool_use');
 const events=frames(out.sse);
 assert.deepEqual(events.map(event=>event.type),['message_start',
  'content_block_start','content_block_delta','content_block_stop',
  'content_block_start','content_block_delta','content_block_stop','message_delta','message_stop']);
 assert.deepEqual(events[1].content_block,{type:'tool_use',id:'call_1',name:'Read',input:{}});
 assert.deepEqual(events[2].delta,{type:'input_json_delta',partial_json:'{"path":"src/app.ts"}'});
 assert.deepEqual(events[4].content_block,{type:'tool_use',id:'call_2',name:'Bash',input:{}});
 assert.equal(events[7].delta.stop_reason,'tool_use');
});

test('a multi-round history replays in order and an assistant text beside a call keeps its place',async()=>{
 const wire=JSON.parse(exchange(context('opencode')).prepare(ingress(multiTurn())).body);
 assert.deepEqual(wire.messages.map(row=>row.role),['system','user','assistant','tool','assistant','tool','assistant','tool']);
 assert.deepEqual(wire.messages[2],{role:'assistant',content:'Reading.',tool_calls:[{id:'toolu_01',type:'function',function:{name:'Read',arguments:'{"path":"a.ts"}'}}]});
 assert.deepEqual(wire.messages.filter(row=>row.role==='tool').map(row=>[row.tool_call_id,row.content]),
  [['toolu_01','A'],['toolu_02','v24'],['toolu_03','B']]);
 // The terminal text turn on the same lane.
 const prepared=exchange(context('opencode')).prepare(ingress(roundTrip()));
 const out=await prepared.complete(upstream(chatTextStream()));
 assert.equal(out.finishReason,'end_turn');
 assert.equal(out.sse.includes('CLI_TURN_COMPLETE'),true);
});

test('the Responses outlet is built from the same transcript when the model declares only that wire',async()=>{
 const prepared=exchange(context('cline','openai-responses')).prepare(ingress(parallel()));
 assert.equal(prepared.path,'/v1/responses');
 const wire=JSON.parse(prepared.body);
 assert.equal(wire.store,false);assert.equal(wire.instructions,'You are the frozen CLI executor.');
 assert.deepEqual(wire.input,[{type:'message',role:'user',content:[{type:'input_text',text:prompt}]},
  {type:'function_call',call_id:'toolu_01',name:'Read',arguments:'{"path":"src/app.ts"}'},
  {type:'function_call',call_id:'toolu_02',name:'Bash',arguments:'{"command":"node -v"}'},
  {type:'function_call_output',call_id:'toolu_01',output:'export const a = 1;'},
  {type:'function_call_output',call_id:'toolu_02',output:'v24.19.0'}]);
 assert.deepEqual(wire.tools.map(tool=>tool.name),toolNames);
});

test('a Codex Responses turn is replayed onto Chat with its calls and outputs intact',async()=>{
 const body={model:MODEL,stream:true,store:false,max_output_tokens:512,instructions:'Codex frozen instructions.',
  tools:[{type:'function',name:'Read',description:'Read one file.',parameters:readSchema,strict:true},
   {type:'function',name:'Bash',description:'Run one command.',parameters:bashSchema,strict:false}],
  input:[{type:'message',role:'developer',content:[{type:'input_text',text:'You are a codex executor.'}]},
   {type:'message',role:'user',content:[{type:'input_text',text:prompt}]},
   {type:'function_call',call_id:'call_a',name:'Read',arguments:'{"path":"src/app.ts"}'},
   {type:'function_call',call_id:'call_b',name:'Bash',arguments:'{"command":"node -v"}'},
   {type:'function_call_output',call_id:'call_a',output:'export const a = 1;'},
   {type:'function_call_output',call_id:'call_b',output:'v24.19.0'}]};
 const prepared=exchange(context('codex','chat-completions')).prepare(ingress(body,'codex'));
 assert.equal(prepared.path,'/v1/chat/completions');
 const wire=JSON.parse(prepared.body);
 // Declarations keep name, description and parameters; the strict marker and the developer row
 // travel as the leading system text, and no tool context is lost.
 assert.deepEqual(wire.tools.map(tool=>tool.function.name),toolNames);
 assert.equal(wire.messages[0].role,'system');
 assert.equal(wire.messages[0].content,'Codex frozen instructions.\n\nYou are a codex executor.');
 assert.deepEqual(wire.messages[2],{role:'assistant',content:null,tool_calls:[
  {id:'call_a',type:'function',function:{name:'Read',arguments:'{"path":"src/app.ts"}'}},
  {id:'call_b',type:'function',function:{name:'Bash',arguments:'{"command":"node -v"}'}}]});
 assert.deepEqual(wire.messages.filter(row=>row.role==='tool').map(row=>[row.tool_call_id,row.content]),
  [['call_a','export const a = 1;'],['call_b','v24.19.0']]);
 // And the Codex answer is rebuilt as the function_call items the CLI reads back.
 const out=await prepared.complete(upstream(chatToolStream()));
 assert.equal(out.finishReason,'tool_use');
 const events=out.sse.trimEnd().split('\n\n').map(block=>JSON.parse(block.split('\n')[1].slice(6)));
 assert.deepEqual(events.filter(event=>event.type==='response.output_item.done').map(event=>event.item.type),['function_call','function_call']);
 assert.equal(events.at(-1).type,'response.completed');
});

// The digest the three translated sets registered, read from the registry rather than pinned: a
// rebuild renames the image, and a constant would turn a green lane into a false failure. A digest
// qualifies only when all three legs named below hold it, so a native-only rebuild is never read as
// one of them.
const registeredTranslated=registeredCliExecutorDigests().find(hash=>supportsClaudeExecutorTranslatedBuild(hash)
 &&supportsOpencodeExecutorTranslatedBuild(hash)&&supportsCodexExecutorTranslatedBuild(hash));

test('the owner dispatches a translated Claude executor turn instead of refusing its wire',async()=>{
 const {NativeOwner}=await import('../../dist/server/native-owner.js');
 const role=(id,{runtime,provider,model,authRef,accountRef,write=false})=>({id,provider,authentication:'api_key',authRef,accountRef,runtime,
  transport:'magpie',nativeException:false,model:{kind:'model',id:model},permissions:write?['source_read','source_write']:['source_read'],
  budget:{currency:'CNY',maxMicros:1000000}});
 const planner=role('planner2',{runtime:'codex',provider:'openai',model:'gpt-6-luna',authRef:'OPENAI_OAUTH',accountRef:'openai:codex'});
 const reviewer=role('reviewer',{runtime:'dsh',provider:'deepseek-official',model:'deepseek-v4-pro',authRef:'DEEPSEEK_KEY',accountRef:'deepseek-official:1'});
 const exec=role('executor-one',{runtime:'claude',provider:'string',model:'claude-sonnet-5',authRef:'STRING_KEY',accountRef:'string:1',write:true});
 const snapshot={schema:'dream-maker.flow-config.v2',mode:'custom',projectId:'project_offline',runId:'run_offline',
  plan:{versionId:'plan_offline',revision:1,contentHash:'a'.repeat(64),specHash:'a'.repeat(64)},profile:{revision:1,contentHash:'a'.repeat(64)},
  accounts:[...new Map([planner,exec,reviewer].map(r=>[r.authRef,{provider:r.provider,authentication:r.authentication,authRef:r.authRef,accountRef:r.accountRef}])).values()],
  roles:{planner2:planner,executors:[exec],reviewer},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},
  budget:{currency:'CNY',maxMicros:10000000},timeZone:'Asia/Shanghai',laya:{enabled:false,mode:'off',roles:[]},
  magpie:{ownership:'DM_ONLY',routing:'MODELS_ONLY'},qualification:'NOT_VERIFIED',configurationFingerprint:'a'.repeat(64)};
 const instance=Object.create(NativeOwner.prototype);
 instance.context={store:{project:()=>({})}};
 instance.customRunAccountSelection=()=>({snapshot});
 instance.configured=()=>({op:{},budget:{}});
 instance.assertCustomReady=()=>{};
 instance.requireUserBudget=()=>{};
 const state={sessions:0};
 instance.withCustomRunMagpieControl=(args,use,signal)=>{state.sessions+=1;
  return use({observation:{scope:'LOCAL_CONTROL_PROCESS_ONLY',realCredentialsPermitted:true,accounts:[],accountCount:0}},{},signal);};
 const input={role:'executor',executorRoleId:'executor-one',runId:snapshot.runId,model:exec.model.id,workspace:'offline',signal:new AbortController().signal};
 // The Magpie session opens (so the wire is dispatched), and the refusal that follows is the route
 // layer's account lookup - never CUSTOM_ROLE_MODEL_NOT_WIRED for a non-native protocol.
 await assert.rejects(instance.custom(input).run(input,()=>{}),error=>{
  assert.notEqual(error.code,'CUSTOM_ROLE_MODEL_NOT_WIRED');
  assert.notEqual(error.code,'CUSTOM_ROLE_RUNTIME_UNSUPPORTED');
  return true;
 });
 assert.equal(state.sessions,1,'the translated Claude executor turn reaches its Magpie lane');
});

test('the three physically accepted translated lanes open on their own digest, and on nothing else',()=>{
 const translatedSet={claude:supportsClaudeExecutorTranslatedBuild,opencode:supportsOpencodeExecutorTranslatedBuild,
  cline:supportsClineExecutorTranslatedBuild,codex:supportsCodexExecutorTranslatedBuild};
 const nativeSet={claude:supportsClaudeExecutorBuild,opencode:supportsOpencodeExecutorBuild,
  cline:supportsClineExecutorBuild,codex:supportsCodexExecutorBuild};
 assert.ok(registeredTranslated,'the three translated sets registered a build');
 const nativeDigest=registeredCliExecutorDigests()[0];
 for(const runtime of ['claude','opencode','codex']){
  // The translated lane is open for exactly the image its physical turn was admitted by.
  assert.equal(translatedSet[runtime](registeredTranslated),true,runtime);
  // Codex's Messages outlet is not one of these three: it registers no digest until its own
  // physical two-round turn, and tests/revamp/codex-executor-messages.test.mjs locks that state.
  for(const wire of runtime==='codex'?['chat-completions']:TRANSLATED[runtime]){
   const lane=additionalMagpieRoute('executor',concreteMagpieRoute(routeOf(runtime,wire)),capabilities(wire));
   assert.equal(lane.protocol,wire,runtime+' '+wire);
   assert.equal(lane.supportsBuild(registeredTranslated),true,runtime+' '+wire);
   // ...and for nothing else: not a synthetic digest, not the zero hash.
   for(const hash of negatives())
    assert.equal(lane.supportsBuild(hash),false,runtime+' '+wire+' '+hash);
  }
  // The two evidence sets remain distinct even though one image earned both: each lane answers its
  // own function, and the native lane is reached through the native set only.
  const nativeLane=additionalMagpieRoute('executor',concreteMagpieRoute(routeOf(runtime,NATIVE[runtime])),capabilities(NATIVE[runtime]));
  assert.equal(nativeLane.supportsBuild,nativeSet[runtime],runtime+' native lane');
  assert.notEqual(nativeLane.supportsBuild,translatedSet[runtime],runtime+' native lane');
  assert.equal(nativeSet[runtime](nativeDigest),true,runtime+' native digest');
 }
 // Cline's translated outlet is the owner's ONE decision for a lane that can never be fenced per
 // command: it is registered on the same reviewed build as its native lane, and it closes on every
 // other digest exactly like the rest. What backs it is the process-level audit in
 // tests/revamp/cline-executor-audit.test.mjs, not a translated physical turn.
 assert.equal(supportsClineExecutorTranslatedBuild(registeredTranslated),true);
 for(const wire of TRANSLATED.cline){
  const lane=additionalMagpieRoute('executor',concreteMagpieRoute(routeOf('cline',wire)),capabilities(wire));
  assert.equal(lane.supportsBuild(registeredTranslated),true,'cline '+wire);
  // Cline's translated outlet holds the same registered digest as its native lane, so the
  // fail-closed negatives are the digests no lane registered - never the digest it holds itself.
  for(const hash of negatives())
   assert.equal(lane.supportsBuild(hash),false,'cline '+wire+' '+hash);
 }
});

test('a Codex hosted-tool bundle is dropped exactly as the native lane drops it',()=>{
 // Measured on codex 0.171.0: the CLI declares its own hosted classes beside its function tools -
 // a 'namespace' bundle of sub-tools and a hosted 'web_search'. They are not calls this lane can
 // replay or audit, and the native lane keeps only type:function, so they are dropped here too.
 const body={model:MODEL,stream:true,store:false,instructions:'Codex frozen instructions.',
  tools:[{type:'function',name:'exec_command',description:'Run one command.',parameters:bashSchema,strict:true},
   {type:'namespace',name:'multi_agent_v1',description:'Sub-agent bundle.',tools:[{type:'function',name:'spawn'}]},
   {type:'web_search',external_web_access:true}],
  input:[{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}]};
 const wire=JSON.parse(exchange(context('codex','chat-completions')).prepare(ingress(body,'codex')).body);
 assert.deepEqual(wire.tools.map(tool=>tool.function.name),['exec_command']);
 // An unknown class is still refused: only the hosted classes the CLI actually sends are dropped.
 const unknown=structuredClone(body);unknown.tools.push({type:'telepathy'});
 assert.throws(()=>exchange(context('codex','chat-completions')).prepare(ingress(unknown,'codex')),failure(REQUEST.request));
 // A duplicate function name stays ambiguous even when a hosted bundle sits between the two.
 const duplicate=structuredClone(body);duplicate.tools.push({...body.tools[0]});
 assert.throws(()=>exchange(context('codex','chat-completions')).prepare(ingress(duplicate,'codex')),failure(REQUEST.request));
});

test('an undeclared tool, a mismatched call id and an over-limit declaration are all refused',()=>{
 // An assistant turn that calls a tool the request never declared is not a replayable history.
 const undeclared=requestBody();
 undeclared.messages=[user(),assistantCalls([{id:'toolu_01',name:'Write',input:{path:'a'}}]),results([{id:'toolu_01',output:'x'}])];
 assert.throws(()=>exchange(context('claude')).prepare(ingress(undeclared)),failure(REQUEST.request));
 // A result whose id answers no call, and one that answers the wrong call, are both refusals.
 const orphan=requestBody();
 orphan.messages=[user(),assistantCalls([{id:'toolu_01',name:'Read',input:{path:'a'}}]),results([{id:'toolu_02',output:'x'}])];
 assert.throws(()=>exchange(context('claude')).prepare(ingress(orphan)),failure(REQUEST.request));
 // An unanswered call is never a completed history.
 const unanswered=requestBody();
 unanswered.messages=[user(),assistantCalls([{id:'toolu_01',name:'Read',input:{path:'a'}}]),user('and then?')];
 assert.throws(()=>exchange(context('claude')).prepare(ingress(unanswered)),failure(REQUEST.request));
 // Seventeen declarations exceed the translated lane's ceiling.
 const many=requestBody();
 many.tools=Array.from({length:17},(_,index)=>({name:'tool'+index,input_schema:{type:'object'}}));
 assert.throws(()=>exchange(context('claude')).prepare(ingress(many)),failure(REQUEST.request));
 // A duplicate declaration makes every later call ambiguous.
 const duplicate=requestBody();duplicate.tools.push({...duplicate.tools[0]});
 assert.throws(()=>exchange(context('claude')).prepare(ingress(duplicate)),failure(REQUEST.request));
 // A Codex document that answers a call it never made is refused on the same lane.
 const codexBody={model:MODEL,stream:true,store:false,input:[
  {type:'message',role:'user',content:[{type:'input_text',text:prompt}]},
  {type:'function_call_output',call_id:'call_missing',output:'x'}]};
 assert.throws(()=>exchange(context('codex','chat-completions')).prepare(ingress(codexBody,'codex')),failure(REQUEST.request));
});

test('a tool name invented by the upstream is refused before any frame reaches the CLI',async()=>{
 const rows=chatToolStream().replace('"name":"Read"','"name":"Write"');
 await assert.rejects(exchange(context('claude')).prepare(ingress(roundTrip())).complete(upstream(rows)),
  error=>[REQUEST.completion,'MODEL_GATEWAY_TOOL_ARGUMENTS_INVALID'].includes(error.code));
});

test('a system-role message mid-transcript is folded into the system prompt, not treated as a turn',async()=>{
 // Measured on Claude Code 2.1.318: the CLI sends its cached environment block as a system-role
 // MESSAGE after the first user turn, then continues the conversation. The native lane folds it
 // into the system prompt; the translated lane must replay the same history, not refuse it.
 const body=requestBody();
 body.messages=[user(),{role:'system',content:[{type:'text',text:'# Environment\n- platform: win32',cache_control:{type:'ephemeral'}}]},
  assistantCalls([{id:'toolu_01',name:'Read',input:{path:'src/app.ts'}}]),results([{id:'toolu_01',output:'A'}])];
 const wire=JSON.parse(exchange(context('claude')).prepare(ingress(body)).body);
 assert.equal(wire.messages[0].role,'system');
 assert.equal(wire.messages[0].content,'You are the frozen CLI executor.\n\n# Environment\n- platform: win32');
 assert.deepEqual(wire.messages.slice(1).map(row=>row.role),['user','assistant','tool']);
 // The SDK lanes keep refusing it: only the CLI arm carries that message.
 assert.throws(()=>exchange(context('opencode')).prepare(ingress({...body,messages:[user(),{role:'system',content:'x'},user('again')]})),
  failure(REQUEST.request));
});

test('the lane is executor-only and refuses a foreign wire, a foreign model and a native-wire capability',async()=>{
 const base=context('claude');
 // A capability set that also declares the CLI's own wire means the native lane, never this one.
 const nativeAlso={...base,accounts:[{...base.route,capabilities:[...capabilities('chat-completions'),{model:MODEL,protocol:'anthropic-messages'}]}]};
 assert.throws(()=>exchange(nativeAlso),failure('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'));
 // A route whose protocol is the CLI's own wire is the passthrough, not this lane.
 assert.throws(()=>exchange(context('claude','anthropic-messages')),failure('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'));
 // Another role never resolves the lane.
 assert.throws(()=>exchange({...base,role:'reviewer'}),failure('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'));
 // The model in the request must be the frozen one.
 const wrong=requestBody();wrong.model='other-model';
 assert.throws(()=>exchange(base).prepare(ingress(wrong)),failure(REQUEST.request));
 // A request without the streaming flag, or with a foreign top-level member, is refused.
 const noStream=requestBody();noStream.stream=false;
 assert.throws(()=>exchange(base).prepare(ingress(noStream)),failure(REQUEST.request));
 const foreign=requestBody();foreign.response_format={type:'json_object'};
 assert.throws(()=>exchange(base).prepare(ingress(foreign)),failure(REQUEST.request));
 // One prepared payload is spent once: a second complete() on the same frozen payload is refused.
 const prepared=exchange(base).prepare(ingress(roundTrip()));
 await prepared.complete(upstream(chatTextStream()));
 await assert.rejects(prepared.complete(upstream(chatTextStream())),failure('MAGPIE_MODEL_REQUEST_ALREADY_USED'));
});

test('a translated turn is not the native CLI executor purpose, and the native field stays unset',async()=>{
 const {MagpieDshRequestTransport}=await import('../../dist/server/magpie-model-transport.js');
 const {DeepSeekGateway}=await import('../../dist/server/deepseek-gateway.js');
 const digest='a'.repeat(64);
 const physical=registeredCliExecutorDigests()[0];
 const route=routeOf('claude','chat-completions');
 const session=hash=>({observation:{address:'127.0.0.1:4567',pid:1,epoch:'dm_epoch',binaryHash:hash,accountCount:1,
  accounts:[{...route,capabilities:capabilities('chat-completions')}],credentialsAccepted:true,qualification:'NOT_VERIFIED',
  realCredentialsPermitted:false,runtimeDirectory:'r',scope:'LOCAL_CONTROL_PROCESS_ONLY'},
  prepareModelPayload:()=>({body:'{}',bodyHash:digest,routeHash:digest,path:'/v1/chat/completions',method:'POST',maxOutputTokens:128,route}),
  prepareCliExecutorPayload:()=>({payload:{body:'{}',bodyHash:digest,routeHash:digest,path:'/v1/chat/completions',method:'POST',maxOutputTokens:128},complete:async()=>({})}),
  control:{prepare:async()=>{},grant:async()=>({status:'ACKNOWLEDGED'})},close:async()=>{}});
 const context=hash=>({session:session(hash),
  budget:{pendingBoundRequest:()=>({price:{provider:PROVIDER,model:MODEL,expiresAt:new Date(Date.now()+60000).toISOString()},maxOutputTokens:128})},
  route,role:'executor',
  bindRequest:()=>({projectId:'p',runId:'r',configurationHash:digest,roleId:'executor',role:'executor',bodyHash:digest,routeHash:digest,engineeringMode:'custom',work:{}}),
  assertCurrent:()=>{}});
 // The registered digest constructs the translated outlet, and the field that names the native
 // passthrough stays undefined: a translated turn is a different purpose, not the native one.
 const translated=new MagpieDshRequestTransport(context(physical));
 assert.equal(translated.cliExecutorTranslated,true);
 assert.equal(translated.cliExecutor,undefined);
 // Fail-closed on every digest the translated set does not hold.
 assert.throws(()=>new MagpieDshRequestTransport(context(digest)),{code:'MAGPIE_MODEL_ROLE_INVALID'});
 assert.throws(()=>new MagpieDshRequestTransport(context('0'.repeat(64))),{code:'MAGPIE_MODEL_ROLE_INVALID'});
 // The Gateway purpose follows the same closed state: a channel that claims the translated outlet
 // is admitted only on the CLI's own ingress wire and never on the OpenAI one.
 const build=(channel,wire,requests=16,forbidTools=false)=>new DeepSeekGateway({},()=>({}),'',8192,requests,undefined,wire,forbidTools,
  undefined,undefined,undefined,channel,undefined,MODEL);
 const channel={role:'executor',cliExecutorTranslated:true,concreteRoute:{runtime:'claude',protocol:'chat-completions',model:MODEL}};
 assert.doesNotThrow(()=>build(channel,'anthropic-messages'));
 assert.throws(()=>build(channel,'responses'),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
 assert.throws(()=>build({...channel,role:'reviewer'},'anthropic-messages'),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
 assert.throws(()=>build(channel,'anthropic-messages',16,true),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
 assert.throws(()=>build({...channel,concreteRoute:{runtime:'claude',protocol:'anthropic-messages',model:MODEL}},'anthropic-messages'),
  {code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
 // A Codex translated turn speaks the Responses wire at this gateway, and only that one.
 const codexChannel={role:'executor',cliExecutorTranslated:true,concreteRoute:{runtime:'codex',protocol:'chat-completions',model:MODEL}};
 assert.doesNotThrow(()=>build(codexChannel,'responses'));
 assert.throws(()=>build(codexChannel,'anthropic-messages'),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
});
