// OFFLINE contract only: no model, no account, no Store, no dispatch, no CLI process.
//
// Scope: the THIRD outlet of the Codex executor leg. `codex exec` only ever posts a Responses
// request and reads Responses events, so a model that declares only the native Messages wire is
// served by a translation in the opposite direction from the read-only Codex lane:
//
//   src/shared/custom-magpie-protocol.ts   the ladder responses > chat > messages for runtime codex
//   src/server/flow/cli-executor-wire.ts   the lane: Responses ingress, Messages body upstream,
//                                          Responses events back to the CLI
//   src/server/flow/executor-transcript.ts messagesBody() and readMessagesStream(), the Anthropic
//                                          dialect of the same neutral executor transcript
//   src/server/magpie-route.ts             codexExecutorMessagesBuilds - its own digest set, empty
//                                          until a physical two-round turn registers one
//
// This suite locks: the three-rung ladder, the outlet's own evidence set and that it is closed
// while that set holds no digest, the whole translation in both directions, and every departure
// from the accepted shape (undeclared tool, mismatched call id, over-limit declaration,
// unaccountable transcript) being refused rather than repaired.
import test from 'node:test';import assert from 'node:assert/strict';
import {customMagpieProtocol,claudeExecutorProtocol,clineExecutorProtocol,codexExecutorProtocol,opencodeExecutorProtocol} from '../../dist/shared/custom-magpie-protocol.js';
import {additionalMagpieRoute,concreteMagpieRoute,registeredCliExecutorDigests,registeredCodexExecutorMessagesDigests,supportsCodexExecutorBuild,supportsCodexExecutorMessagesBuild,supportsCodexExecutorTranslatedBuild} from '../../dist/server/magpie-route.js';
import {createCliExecutorExchange} from '../../dist/server/flow/cli-executor-wire.js';
import {prepareOwnedCliExecutorPayload} from '../../dist/server/magpie-owned.js';

const MODEL='deepseek-flash',PROVIDER='deepseek-fixture',QUALIFIED=PROVIDER+'/'+MODEL;
const REQUEST={request:'CLI_EXECUTOR_REQUEST_INVALID',completion:'MODEL_GATEWAY_COMPLETION_INVALID',usage:'NATIVE_USAGE_UNKNOWN'};
const upstream=(body,media='text/event-stream')=>new Response(body,{headers:{'content-type':media}});
const frames=sse=>sse.trimEnd().split('\n\n').map(block=>JSON.parse(block.split('\n')[1].slice(6)));
const frame=(type,fields)=>'event: '+type+'\ndata: '+JSON.stringify({type,...fields})+'\n\n';
const routeOf=protocol=>({runtime:'codex',provider:PROVIDER,protocol,model:MODEL,authentication:'api_key',
 authRef:'offline_auth',accountRef:'offline_account',upstreamAccountRef:PROVIDER+'/offline_peer'});
const capabilities=protocol=>[{model:MODEL,protocol}];
const negatives=()=>{const registered=new Set(registeredCliExecutorDigests());
 return ['a'.repeat(64),'0'.repeat(64),'f'.repeat(64)].filter(hash=>!registered.has(hash));};

// ------------------------------------------------------------------------ the three-rung ladder ----
test('the Codex executor ladder is Responses, then Chat, then the native Messages wire',()=>{
 // The CLI's own wire keeps the passthrough whatever else the model declares.
 assert.equal(codexExecutorProtocol('executor','codex',['openai-responses']),'openai-responses');
 assert.equal(codexExecutorProtocol('executor','codex',['anthropic-messages','chat-completions','openai-responses']),'openai-responses');
 // Chat outranks Messages: the outlet below it is only reached by a model that declares neither.
 assert.equal(codexExecutorProtocol('executor','codex',['anthropic-messages','chat-completions']),'chat-completions');
 assert.equal(codexExecutorProtocol('executor','codex',['anthropic-messages']),'anthropic-messages');
 // The public ladder agrees with the leg's own function on every rung.
 for(const wires of [['openai-responses'],['chat-completions'],['anthropic-messages'],
  ['anthropic-messages','chat-completions'],['anthropic-messages','chat-completions','openai-responses']])
  assert.equal(customMagpieProtocol('executor','codex',wires),codexExecutorProtocol('executor','codex',wires),wires.join('+'));
 // A model that declares nothing leaves the role unrouted, and no other runtime answers for Codex.
 assert.equal(codexExecutorProtocol('executor','codex',[]),undefined);
 assert.equal(customMagpieProtocol('executor','codex',[]),undefined);
 for(const role of ['planner2','reviewer'])assert.equal(codexExecutorProtocol(role,'codex',['anthropic-messages']),undefined,role);
 const others={claude:claudeExecutorProtocol,opencode:opencodeExecutorProtocol,cline:clineExecutorProtocol};
 for(const [runtime,fn] of Object.entries(others)){
  assert.equal(fn('executor',runtime,['anthropic-messages']),'anthropic-messages',runtime+' keeps its native wire');
  assert.equal(customMagpieProtocol('executor',runtime,['openai-responses','chat-completions']),'openai-responses',runtime);
 }
});

// ------------------------------------------------------------------------- route layer, closed ----
test('the Messages outlet is named by the ladder and answers its own evidence set',()=>{
 const lane=additionalMagpieRoute('executor',concreteMagpieRoute(routeOf('anthropic-messages')),capabilities('anthropic-messages'));
 assert.ok(lane,'the outlet is named even while it holds no build');
 assert.equal(lane.protocol,'anthropic-messages');
 // Its own set: neither the OpenAI replay's nor the native passthrough's.
 assert.equal(lane.supportsBuild,supportsCodexExecutorMessagesBuild);
 assert.notEqual(lane.supportsBuild,supportsCodexExecutorTranslatedBuild);
 assert.notEqual(lane.supportsBuild,supportsCodexExecutorBuild);
 // Fail-closed on everything the set does not hold. The set holds EXACTLY the digest the physical
 // two-round turn was admitted by - a rebuild renames the image, so the entry is read from the
 // registry rather than pinned here - and every other digest stays closed.
 const held=registeredCodexExecutorMessagesDigests();
 assert.equal(held.length,1,'the Messages outlet registers its one physical digest');
 assert.equal(lane.supportsBuild(held[0]),true,'the outlet opens on its own physical digest');
 for(const hash of negatives())assert.equal(lane.supportsBuild(hash),false,hash);
 assert.equal(supportsCodexExecutorMessagesBuild('a'.repeat(64)),false);
 // The other two outlets of the same leg keep their own sets; nothing above widened them.
 for(const wire of ['chat-completions','openai-responses']){
  const other=additionalMagpieRoute('executor',concreteMagpieRoute(routeOf(wire)),capabilities(wire));
  assert.equal(other.supportsBuild,wire==='openai-responses'?supportsCodexExecutorBuild:supportsCodexExecutorTranslatedBuild,wire);
  assert.notEqual(other.supportsBuild,lane.supportsBuild,wire);
 }
});

test('the owned lane takes the Messages outlet on its own digest and on nothing else',()=>{
 const route=Object.freeze(concreteMagpieRoute(routeOf('anthropic-messages')));
 const accounts=[{provider:route.provider,authRef:route.authRef,accountRef:route.accountRef,
  upstreamAccountRef:route.upstreamAccountRef,authentication:route.authentication,model:MODEL,capabilities:capabilities('anthropic-messages')}];
 const context={route,role:'executor',limits:{model:MODEL,maxInputTokens:128,maxOutputTokens:512},
  assertCurrent(){},assertSafe(){},signal:new AbortController().signal};
 const ingress={method:'POST',path:'/v1/responses',contentType:'application/json',body:JSON.stringify(codexRequest())};
 // Every digest this set does not hold stays closed.
 for(const hash of negatives())
  assert.throws(()=>prepareOwnedCliExecutorPayload(hash,accounts,context,ingress),{code:'MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'},hash);
 // Its own physical digest opens it, and the payload it builds is the Messages body on its own path.
 const prepared=prepareOwnedCliExecutorPayload(registeredCodexExecutorMessagesDigests()[0],accounts,context,ingress);
 assert.equal(prepared.payload.path,'/v1/messages');
 assert.equal(prepared.payload.method,'POST');
 assert.equal(JSON.parse(prepared.payload.body).model,QUALIFIED);
});

// ------------------------------------------------------------------- the translation, both ways ----
const prompt='Inspect src/app.ts and run the test.';
const readSchema={type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false};
const bashSchema={type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false};
const codexTools=()=>[{type:'function',name:'Read',description:'Read one file.',parameters:structuredClone(readSchema),strict:true},
 {type:'function',name:'Bash',description:'Run one command.',parameters:structuredClone(bashSchema),strict:false}];
const developer={type:'message',role:'developer',content:[{type:'input_text',text:'You are a codex executor.'}]};
const user=(text=prompt)=>({type:'message',role:'user',content:[{type:'input_text',text}]});
const call=(id,name,args)=>({type:'function_call',call_id:id,name,arguments:JSON.stringify(args)});
const output=(id,text)=>({type:'function_call_output',call_id:id,output:text});
const codexRequest=()=>({model:MODEL,stream:true,store:false,max_output_tokens:512,instructions:'Codex frozen instructions.',
 tools:codexTools(),input:[developer,user()]});
const ingress=body=>({method:'POST',path:'/v1/responses',contentType:'application/json',body:typeof body==='string'?body:JSON.stringify(body)});
const context=(protocol='anthropic-messages',extra={})=>{
 const route=routeOf(protocol);
 return {...extra,route,role:'executor',accounts:[{...route,capabilities:capabilities(protocol)}],
  limits:{model:MODEL,maxInputTokens:128,maxOutputTokens:512},assertCurrent(){},assertSafe(){},signal:new AbortController().signal};
};
const exchange=ctx=>createCliExecutorExchange(ctx);
const failure=code=>error=>error.code===code;
const systemText='Codex frozen instructions.\n\nYou are a codex executor.';
const startFrame=()=>frame('message_start',{message:{id:'msg_fixture',type:'message',role:'assistant',model:QUALIFIED,
 content:[],stop_reason:null,stop_sequence:null,
 usage:{input_tokens:7,cache_read_input_tokens:2,cache_creation_input_tokens:0,output_tokens:0}}});
const toolBlock=(index,id,name,args)=>[frame('content_block_start',{index,content_block:{type:'tool_use',id,name,input:{}}}),
 frame('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}}),
 frame('content_block_stop',{index})].join('');
const messagesToolStream=(calls=[{id:'call_1',name:'Read',args:{path:'src/app.ts'}},{id:'call_2',name:'Bash',args:{command:'node -v'}}])=>
 startFrame()+calls.map((each,index)=>toolBlock(index,each.id,each.name,each.args)).join('')
 +frame('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:9}})+frame('message_stop',{});
const messagesTextStream=(text='CODEX_MESSAGES_COMPLETE')=>startFrame()
 +frame('content_block_start',{index:0,content_block:{type:'text',text:''}})
 +frame('content_block_delta',{index:0,delta:{type:'text_delta',text}})
 +frame('content_block_stop',{index:0})
 +frame('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}})+frame('message_stop',{});

test('one declared tool: the Responses turn becomes one Messages body and back again',async()=>{
 const body=codexRequest();body.tools=[codexTools()[0]];
 body.input=[developer,user(),call('call_a','Read',{path:'src/app.ts'}),output('call_a','export const a = 1;')];
 const prepared=exchange(context()).prepare(ingress(body));
 // The upstream path and dialect are the Anthropic ones.
 assert.equal(prepared.path,'/v1/messages');
 const wire=JSON.parse(prepared.body);
 assert.equal(wire.model,QUALIFIED);assert.equal(wire.stream,true);assert.equal(wire.max_tokens,512);
 assert.deepEqual(wire.system,[{type:'text',text:systemText}]);
 // Exactly one declaration, in the Anthropic shape: input_schema, not parameters.
 assert.deepEqual(wire.tools,[{name:'Read',description:'Read one file.',input_schema:readSchema}]);
 // The developer row travelled as system text; the user turn and the tool round trip keep their order.
 assert.deepEqual(wire.messages,[{role:'user',content:[{type:'text',text:prompt}]},
  {role:'assistant',content:[{type:'tool_use',id:'call_a',name:'Read',input:{path:'src/app.ts'}}]},
  {role:'user',content:[{type:'tool_result',tool_use_id:'call_a',content:'export const a = 1;'}]}]);
 // The answer is rebuilt as the function_call items the CLI reads back.
 const result=await prepared.complete(upstream(messagesToolStream([{id:'call_1',name:'Read',args:{path:'src/app.ts'}}])));
 assert.equal(result.finishReason,'tool_use');assert.equal(result.responseId,'msg_fixture');
 const events=frames(result.sse);
 const done=events.filter(event=>event.type==='response.output_item.done').map(event=>event.item);
 assert.deepEqual(done,[{id:'call_1',type:'function_call',status:'completed',call_id:'call_1',name:'Read',
  arguments:'{"path":"src/app.ts"}'}]);
 assert.deepEqual(events.map(event=>event.type),['response.created','response.output_item.added',
  'response.function_call_arguments.delta','response.function_call_arguments.done','response.output_item.done','response.completed']);
 // Charged input is the prompt the start frame reported, cache reads included, exactly as Go meters it.
 assert.deepEqual(events.at(-1).response.usage,{input_tokens:9,input_tokens_details:{cached_tokens:2},output_tokens:9,
  output_tokens_details:{reasoning_tokens:0},total_tokens:18});
});

test('two parallel calls share one assistant turn and one answer turn, and both items come back',async()=>{
 const body=codexRequest();
 body.input=[developer,user(),
  call('call_a','Read',{path:'src/app.ts'}),call('call_b','Bash',{command:'node -v'}),
  output('call_a','export const a = 1;'),output('call_b','v24.19.0')];
 const prepared=exchange(context()).prepare(ingress(body));
 const wire=JSON.parse(prepared.body);
 assert.deepEqual(wire.tools.map(tool=>[tool.name,tool.input_schema]),[['Read',readSchema],['Bash',bashSchema]]);
 // Both calls ride the one assistant turn they were asked in, and both results the one user turn.
 assert.deepEqual(wire.messages,[{role:'user',content:[{type:'text',text:prompt}]},
  {role:'assistant',content:[{type:'tool_use',id:'call_a',name:'Read',input:{path:'src/app.ts'}},
   {type:'tool_use',id:'call_b',name:'Bash',input:{command:'node -v'}}]},
  {role:'user',content:[{type:'tool_result',tool_use_id:'call_a',content:'export const a = 1;'},
   {type:'tool_result',tool_use_id:'call_b',content:'v24.19.0'}]}]);
 const result=await prepared.complete(upstream(messagesToolStream()));
 const done=frames(result.sse).filter(event=>event.type==='response.output_item.done').map(event=>event.item);
 assert.deepEqual(done.map(item=>[item.call_id,item.name,item.arguments]),
  [['call_1','Read','{"path":"src/app.ts"}'],['call_2','Bash','{"command":"node -v"}']]);
});

test('a multi-round history replays in order and keeps an assistant text beside its call',async()=>{
 const body=codexRequest();
 body.input=[developer,user(),
  {type:'message',role:'assistant',content:[{type:'input_text',text:'Reading.'}]},
  call('call_a','Read',{path:'a.ts'}),output('call_a','A'),
  call('call_b','Bash',{command:'node -v'}),output('call_b','v24')];
 const wire=JSON.parse(exchange(context()).prepare(ingress(body)).body);
 assert.deepEqual(wire.messages.map(row=>row.role),['user','assistant','user','assistant','user']);
 // The neutral transcript keeps one assistant turn per round: the prose the CLI sent and the call
 // it made in that same round stay together, as one assistant message with a text and a tool_use.
 assert.deepEqual(wire.messages[1],{role:'assistant',content:[{type:'text',text:'Reading.'},
  {type:'tool_use',id:'call_a',name:'Read',input:{path:'a.ts'}}]});
 // The next round opens a new assistant turn: a call after an answer never merges backwards.
 assert.deepEqual(wire.messages[3],{role:'assistant',content:[{type:'tool_use',id:'call_b',name:'Bash',input:{command:'node -v'}}]});
 assert.deepEqual(wire.messages.filter(row=>row.role==='user').map(row=>row.content[0]),[
  {type:'text',text:prompt},{type:'tool_result',tool_use_id:'call_a',content:'A'},{type:'tool_result',tool_use_id:'call_b',content:'v24'}]);
});

test('a Messages text answer closes the turn as the single message item the CLI reads',async()=>{
 const prepared=exchange(context()).prepare(ingress(codexRequest()));
 const result=await prepared.complete(upstream(messagesTextStream()));
 assert.equal(result.finishReason,'end_turn');
 const done=frames(result.sse).filter(event=>event.type==='response.output_item.done').map(event=>event.item);
 assert.equal(done.length,1);
 assert.equal(done[0].type,'message');
 assert.deepEqual(done[0].content,[{type:'output_text',text:'CODEX_MESSAGES_COMPLETE',annotations:[]}]);
});

test('an undeclared tool, a mismatched call id and an over-limit declaration are all refused',()=>{
 const undeclared=codexRequest();
 undeclared.input=[developer,user(),call('call_a','Write',{path:'a'}),output('call_a','x')];
 assert.throws(()=>exchange(context()).prepare(ingress(undeclared)),failure(REQUEST.request));
 // A result that answers no call, and one that answers the wrong call of a parallel round.
 const orphan=codexRequest();
 orphan.input=[developer,user(),call('call_a','Read',{path:'a'}),output('call_b','x')];
 assert.throws(()=>exchange(context()).prepare(ingress(orphan)),failure(REQUEST.request));
 const reordered=codexRequest();
 reordered.input=[developer,user(),call('call_a','Read',{path:'a'}),call('call_b','Bash',{command:'node -v'}),
  output('call_b','v24'),output('call_a','A')];
 assert.throws(()=>exchange(context()).prepare(ingress(reordered)),failure(REQUEST.request));
 // A call id repeated inside the history makes both rounds ambiguous.
 const repeated=codexRequest();
 repeated.input=[developer,user(),call('call_a','Read',{path:'a'}),output('call_a','A'),
  call('call_a','Read',{path:'b'}),output('call_a','B')];
 assert.throws(()=>exchange(context()).prepare(ingress(repeated)),failure(REQUEST.request));
 // An unanswered call is never a completed history.
 const unanswered=codexRequest();
 unanswered.input=[developer,user(),call('call_a','Read',{path:'a'}),user('and then?')];
 assert.throws(()=>exchange(context()).prepare(ingress(unanswered)),failure(REQUEST.request));
 // Seventeen declarations exceed the translated lane's ceiling, and none may be declared twice.
 const many=codexRequest();many.tools=Array.from({length:17},(_,index)=>({type:'function',name:'tool'+index,parameters:{type:'object'}}));
 assert.throws(()=>exchange(context()).prepare(ingress(many)),failure(REQUEST.request));
 const duplicate=codexRequest();duplicate.tools.push({...duplicate.tools[0]});
 assert.throws(()=>exchange(context()).prepare(ingress(duplicate)),failure(REQUEST.request));
});

test('an upstream transcript that cannot be accounted for is refused before any frame reaches the CLI',async()=>{
 const prepared=()=>exchange(context()).prepare(ingress(codexRequest()));
 // A call the request never declared.
 await assert.rejects(prepared().complete(upstream(messagesToolStream([{id:'call_1',name:'Write',args:{path:'a'}}]))),
  failure(REQUEST.completion));
 // A stop reason that disagrees with the blocks actually read.
 await assert.rejects(prepared().complete(upstream(messagesToolStream().replace('"stop_reason":"tool_use"','"stop_reason":"end_turn"'))),
  failure(REQUEST.completion));
 // A truncated transcript: the terminal frames are missing.
 await assert.rejects(prepared().complete(upstream(messagesToolStream().replace(frame('message_stop',{}),''))),
  failure(REQUEST.completion));
 // A cache write is unaccountable spend on this lane.
 await assert.rejects(prepared().complete(upstream(messagesToolStream().replace('"cache_creation_input_tokens":0','"cache_creation_input_tokens":3'))),
  failure(REQUEST.usage));
 // Seventeen emitted calls exceed the same ceiling the declarations had.
 await assert.rejects(prepared().complete(upstream(messagesToolStream(Array.from({length:17},(_,index)=>
  ({id:'call_'+index,name:'Read',args:{path:'p'+index}}))))),failure(REQUEST.completion));
 // A payload that is not a tool input is not a call either.
 const mangled=[startFrame(),
  frame('content_block_start',{index:0,content_block:{type:'tool_use',id:'call_1',name:'Read',input:{}}}),
  frame('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:'not-json'}}),
  frame('content_block_stop',{index:0}),
  frame('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:1}}),
  frame('message_stop',{})].join('');
 await assert.rejects(prepared().complete(upstream(mangled)),
  error=>[REQUEST.completion,'MODEL_GATEWAY_TOOL_ARGUMENTS_INVALID'].includes(error.code));
});

// ------------------------------------------------------------- only Codex takes this outlet ----
test('only the Codex executor may take the Messages outlet',async()=>{
 // The three Messages CLIs are native on that wire: the exchanging lane refuses it for them.
 for(const runtime of ['claude','opencode','cline']){
  const route={...routeOf('anthropic-messages'),runtime};
  const ctx={route,role:'executor',accounts:[{...route,capabilities:capabilities('anthropic-messages')}],
   limits:{model:MODEL,maxInputTokens:128,maxOutputTokens:512},assertCurrent(){},assertSafe(){},signal:new AbortController().signal};
  assert.throws(()=>exchange(ctx),failure('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'),runtime);
 }
 const base=context('anthropic-messages');
 // A model that also declares Chat would have resolved to Chat: a Messages route for it is a mix-up.
 const withChat={...base,accounts:[{...base.route,capabilities:[...capabilities('anthropic-messages'),{model:MODEL,protocol:'chat-completions'}]}]};
 assert.throws(()=>exchange(withChat),failure('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'));
 // A model that also declares the CLI's own wire is the passthrough, never this lane.
 const withResponses={...base,accounts:[{...base.route,capabilities:[...capabilities('anthropic-messages'),{model:MODEL,protocol:'openai-responses'}]}]};
 assert.throws(()=>exchange(withResponses),failure('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'));
 // Another role never resolves the lane.
 assert.throws(()=>exchange({...base,role:'reviewer'}),failure('MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'));
 // A Responses document that is not the frozen model, or not a stream, is refused on the same lane.
 const wrong=codexRequest();wrong.model='other-model';
 assert.throws(()=>exchange(base).prepare(ingress(wrong)),failure(REQUEST.request));
 const noStream=codexRequest();noStream.stream=false;
 assert.throws(()=>exchange(base).prepare(ingress(noStream)),failure(REQUEST.request));
 // One prepared payload is spent once.
 const prepared=exchange(base).prepare(ingress(codexRequest()));
 await prepared.complete(upstream(messagesTextStream()));
 await assert.rejects(prepared.complete(upstream(messagesTextStream())),failure('MAGPIE_MODEL_REQUEST_ALREADY_USED'));
});

test('the gateway purpose admits a Codex executor on the Messages wire only at its own ingress',async()=>{
 const {DeepSeekGateway}=await import('../../dist/server/deepseek-gateway.js');
 const build=(channel,wire,forbidTools=false)=>new DeepSeekGateway({},()=>({}),'',8192,16,undefined,wire,forbidTools,
  undefined,undefined,undefined,channel,undefined,MODEL);
 const channel={role:'executor',cliExecutorTranslated:true,concreteRoute:{runtime:'codex',protocol:'anthropic-messages',model:MODEL}};
 // The CLI still speaks Responses at this gateway; the Messages wire is the upstream, not the ingress.
 assert.doesNotThrow(()=>build(channel,'responses'));
 assert.throws(()=>build(channel,'anthropic-messages'),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
 // The read-only Codex lane keeps its own purpose, and a Messages route for the three native
 // Messages CLIs never becomes a translated outlet.
 assert.throws(()=>build({...channel,role:'reviewer'},'responses'),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
 assert.throws(()=>build({role:'executor',cliExecutorTranslated:true,concreteRoute:{runtime:'claude',protocol:'anthropic-messages',model:MODEL}},'responses'),
  {code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
 // A tool-forbidding purpose can never carry the executor turn.
 assert.throws(()=>build(channel,'responses',true),{code:'MAGPIE_GATEWAY_PURPOSE_INVALID'});
});

test('the read-only Codex lane and the executor outlet never answer for each other',async()=>{
 const {MagpieDshRequestTransport}=await import('../../dist/server/magpie-model-transport.js');
 const get=Object.getOwnPropertyDescriptor(MagpieDshRequestTransport.prototype,'codexSupervisorTranslated').get;
 // The same runtime+protocol pair is two different lanes, and the role is what tells them apart:
 // a read role keeps the frozen single-request Messages lane, an executor takes the tool outlet.
 assert.equal(get.call({route:{runtime:'codex',protocol:'anthropic-messages'},role:'executor'}),false);
 assert.equal(get.call({route:{runtime:'codex',protocol:'anthropic-messages'},role:'planner2'}),true);
 assert.equal(get.call({route:{runtime:'codex',protocol:'anthropic-messages'},role:'reviewer'}),true);
 assert.equal(get.call({route:{runtime:'codex',protocol:'chat-completions'},role:'reviewer'}),false);
 // A transport built for the executor outlet declares the translated purpose, never the
 // read-only one, and stays closed while its own set holds no digest.
 const digest='a'.repeat(64);
 const route=routeOf('anthropic-messages');
 const session={observation:{address:'127.0.0.1:4567',pid:1,epoch:'dm_epoch',binaryHash:digest,accountCount:1,
  accounts:[{...route,capabilities:capabilities('anthropic-messages')}],credentialsAccepted:true,qualification:'NOT_VERIFIED',
  realCredentialsPermitted:false,runtimeDirectory:'r',scope:'LOCAL_CONTROL_PROCESS_ONLY'},
  prepareModelPayload:()=>({body:'{}',bodyHash:digest,routeHash:digest,path:'/v1/messages',method:'POST',maxOutputTokens:128,route}),
  prepareCliExecutorPayload:()=>({payload:{body:'{}',bodyHash:digest,routeHash:digest,path:'/v1/messages',method:'POST',maxOutputTokens:128},complete:async()=>({})}),
  control:{prepare:async()=>{},grant:async()=>({status:'ACKNOWLEDGED'})},close:async()=>{}};
 const context={session,budget:{pendingBoundRequest:()=>({price:{provider:PROVIDER,model:MODEL,expiresAt:new Date(Date.now()+60000).toISOString()},maxOutputTokens:128})},
  route,role:'executor',
  bindRequest:()=>({projectId:'p',runId:'r',configurationHash:digest,roleId:'executor',role:'executor',bodyHash:digest,routeHash:digest,engineeringMode:'custom',work:{}}),
  assertCurrent:()=>{}};
 assert.throws(()=>new MagpieDshRequestTransport(context),{code:'MAGPIE_MODEL_ROLE_INVALID'});
});
