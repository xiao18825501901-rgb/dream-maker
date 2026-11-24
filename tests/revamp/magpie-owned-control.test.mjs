// OFFLINE lifecycle/Owner tests. Synthetic process and ledger; never Native qualification.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';import {resolve,join} from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {createHash} from 'node:crypto';
import {harness} from '../helpers.mjs';import {hash} from '../../dist/server/security.js';
import {NativeBudget} from '../../dist/server/native-budget.js';
import {createNativeOwner} from '../../dist/server/native-owner.js';
const commit='1aca55909ff94f5c23091ce35f73cb4b7bc46658';
const authority={scopeId:'OFFLINE_OWNED_MAGPIE',authorizationHash:'OFFLINE_AUTHORITY',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
function fixture(t,behavior={}){
 let budget;t.after(()=>budget?.close());const h=harness(t);
 const source=join(h.dir,'candidate.exe');writeFileSync(source,'SYNTHETIC_EXECUTABLE_BYTES_NOT_NATIVE');
 const binary={path:source,sha256:hash(readFileSync(source))};budget=new NativeBudget(join(h.dir,'synthetic-budget.sqlite'),authority);
 let stops=0,writes=0,launched=0,lastOptions,stopped;const finished=new Promise(r=>stopped=r);
 const launch=(command,args,options)=>{
  launched++;lastOptions={command,args,...options};const stdout=new PassThrough(),stderr=new PassThrough();
  const child={pid:123,stdout,stderr,stdin:new Writable({write(chunk,_encoding,cb){writes++;
   const boot=JSON.parse(chunk.toString()),accounts=(boot.accounts??[]).map(a=>({provider:a.provider,authRef:a.authRef,accountRef:a.accountRef,upstreamAccountRef:a.provider+'/'+createHash('sha256').update(a.key).digest('hex').slice(0,10),authentication:a.authentication??'api_key',model:a.capabilities?.[0].model??a.model??'deepseek-flash',...(a.models?{models:a.models}:{}),...(a.capabilities?{capabilities:a.capabilities}:{})}));
   const value={type:'ready',schema:'dream-maker.magpie-ingress-candidate.v1',epoch:boot.epoch,controlSchema:boot.schema,pid:456,address:'127.0.0.1:12345',commit,configDir:resolve(options.cwd,'data'),accountDiscovery:'OFF',accountCatalog:'MEMORY_ONLY',accountCount:accounts.length,accounts,issuedKeyStore:'MEMORY_ONLY',issuedKeyCount:0,qualification:'NOT_VERIFIED',runtimeAuthority:'ORIGINAL_DREAMFLOW_ENGINE'};
   assert.deepEqual(Object.keys(boot).sort(),['dream-maker.magpie-control.v2','dream-maker.magpie-control.v3','dream-maker.magpie-control.v5'].includes(boot.schema)?['accounts','epoch','schema']:['epoch','schema']);
   assert.ok(['dream-maker.magpie-control.v1','dream-maker.magpie-control.v2','dream-maker.magpie-control.v3','dream-maker.magpie-control.v5'].includes(boot.schema));
   behavior.inspectBootstrap?.(boot);
   behavior.reply?.(value,stdout,stderr);if(!behavior.reply)queueMicrotask(()=>stdout.write(JSON.stringify({...value,...behavior.edit})+'\n'));
   if(!behavior.hangWrite)cb();
  },final(cb){stopped({code:0,signal:null});cb();}})};
  return{child,ready:Promise.resolve(),closed:finished,targetPid:()=>456,proveCleanup(){},stop:async()=>{stops++;stopped({code:0,signal:null});if(behavior.badCleanup)throw Error('SYNTHETIC_PRIVATE_CLEANUP_ERROR');}};
 };
 return{h,binary,budget,launch,options:()=>lastOptions,stops:()=>stops,writes:()=>writes,launched:()=>launched};
}
async function open(x,options={}){const {openOwnedMagpieControl}=await import('../../dist/server/magpie-owned.js');return openOwnedMagpieControl({root:x.h.dir,binary:x.binary,budget:x.budget,timeoutMs:5000,...options},x.launch);}
test('string registration binds only its declared Claude model and messages endpoint',async t=>{
 const endpoint={protocol:'anthropic-messages',baseUrl:'https://string.example.test/anthropic'};
 const account={provider:'string',authRef:'string-test',accountRef:'account-test',key:'DM_SYNTHETIC_STRING',models:['claude-sonnet-5'],endpoint};
 const x=fixture(t,{inspectBootstrap:boot=>{const [wire]=boot.accounts;
  assert.equal(wire.chat,'');assert.equal(wire.responses,'');assert.equal(wire.anthropic,endpoint.baseUrl);
  assert.equal(wire.model,account.models[0]);assert.equal(wire.endpoint,undefined);
 }});
 for(const invalid of [{endpoint:undefined},{endpoint:{...endpoint,baseUrl:'https://localhost'}},{model:'claude-undeclared'},{models:['gpt-test']}]){
  await assert.rejects(open(x,{bootstrapAccounts:[{...account,...invalid}]}),{code:'MAGPIE_BOOTSTRAP_ACCOUNTS_INVALID'});
 }
 assert.equal(x.launched(),0);
 const session=await open(x,{bootstrapAccounts:[account]});t.after(()=>session.close());
 assert.equal(session.observation.accounts[0].provider,'string');assert.equal(session.observation.qualification,'NOT_VERIFIED');
 const registered=session.observation.accounts[0];
 const route={runtime:'dsh',provider:'string',protocol:'openai-responses',model:registered.model,authentication:'api_key',
  authRef:registered.authRef,accountRef:registered.accountRef,upstreamAccountRef:registered.upstreamAccountRef};
 assert.throws(()=>session.prepareModelPayload(route,'{}'),{code:'MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'});
 const claudeRoute={...route,runtime:'claude',protocol:'anthropic-messages'};
 const body={model:registered.model,max_tokens:256,stream:true,tools:[],messages:[{role:'user',content:'Review the synthetic evidence.'}]};
 const prepared=session.prepareModelPayload(claudeRoute,JSON.stringify(body));
 const cli={...body,max_tokens:8192,thinking:{type:'disabled'},output_config:{effort:'high'}};
 assert.equal(session.prepareModelPayload(claudeRoute,JSON.stringify(cli)).maxOutputTokens,8192);
 const identified=session.prepareModelPayload(claudeRoute,JSON.stringify({...cli,metadata:{user_id:'synthetic-private-session'}}));
 assert.equal(Object.hasOwn(JSON.parse(identified.body),'metadata'),false);
 assert.equal(identified.bodyHash,session.prepareModelPayload(claudeRoute,JSON.stringify(cli)).bodyHash);

 assert.throws(()=>session.prepareModelPayload(claudeRoute,JSON.stringify({...cli,output_config:{effort:'high',extra:true}})),{code:'MAGPIE_PAYLOAD_INVALID'});
 assert.equal(prepared.path,'/v1/messages');assert.equal(prepared.executionGranted,false);
 assert.equal(JSON.parse(prepared.body).model,'string/claude-sonnet-5');
 for(const extra of [{tools:[{name:'write'}]},{tool_choice:{type:'any'}},{messages:[{role:'assistant',content:[{type:'tool_use',id:'one',name:'write',input:{}}]}]}]){
  assert.throws(()=>session.prepareModelPayload(claudeRoute,JSON.stringify({...body,...extra})),{code:'MAGPIE_PAYLOAD_INVALID'});
 }
});
test('owned ingress pins target PID instead of Windows wrapper and uses a dedicated empty environment',async t=>{
 const x=fixture(t),session=await open(x);t.after(()=>session.close());const o=x.options();
 assert.equal(session.observation.pid,456);assert.notEqual(session.observation.pid,123);assert.equal(session.observation.qualification,'NOT_VERIFIED');
 assert.equal(o.windowsJobRoot,x.h.dir);assert.equal(o.windowsJobReadyMs,5000);assert.deepEqual(o.args,[]);assert.notEqual(o.command,x.binary.path);assert.equal(hash(readFileSync(o.command)),x.binary.sha256);
 for(const field of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','OPENAI_API_KEY','DEEPSEEK_API_KEY','CODEX_HOME'])assert.equal(o.env[field],undefined);
 assert.equal(o.env.MAGPIE_NO_ACCOUNTS,'1');assert.equal(o.env.HOME,join(o.cwd,'profile'));assert.equal(o.env.TEMP,join(o.cwd,'temp'));
 assert.equal(x.budget.requests().length,0);assert.equal(session.observation.accountCount,0);
 await session.close();await session.close();assert.equal(x.stops(),1);
});
test('only an explicit loopback proxy transform can enter the owned Magpie environment',async t=>{
 const proxy='http://127.0.0.1:7890/',bypass='localhost,127.0.0.1,::1,[::1]',x=fixture(t);
 const session=await open(x,{networkEnvironment:base=>({...base,HTTP_PROXY:proxy,http_proxy:proxy,HTTPS_PROXY:proxy,https_proxy:proxy,ALL_PROXY:proxy,all_proxy:proxy,NO_PROXY:bypass,no_proxy:bypass})});
 t.after(()=>session.close());const env=x.options().env;
 for(const key of ['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy'])assert.equal(env[key],proxy);
 assert.equal(env.NO_PROXY,bypass);assert.equal(env.no_proxy,bypass);assert.equal(env.MAGPIE_NO_ACCOUNTS,'1');
 assert.equal(env.HOME,join(x.options().cwd,'profile'));assert.equal(env.DEEPSEEK_API_KEY,undefined);assert.equal(env.CODEX_HOME,undefined);
});
test('a network transform cannot add credentials, remove isolation or point away from loopback',async t=>{
 const proxy='http://127.0.0.1:7890/',bypass='localhost,127.0.0.1,::1,[::1]',baseProxy={HTTP_PROXY:proxy,http_proxy:proxy,HTTPS_PROXY:proxy,https_proxy:proxy,ALL_PROXY:proxy,all_proxy:proxy,NO_PROXY:bypass,no_proxy:bypass};
 const cases=[
  base=>({...base,...baseProxy,DEEPSEEK_API_KEY:'SYNTHETIC_MUST_NOT_ENTER'}),
  base=>{const next={...base,...baseProxy};delete next.MAGPIE_NO_ACCOUNTS;return next;},
  base=>({...base,...baseProxy,HTTP_PROXY:'http://127.0.0.1:7891/',http_proxy:'http://127.0.0.1:7891/'}),
  base=>({...base,...baseProxy,HTTPS_PROXY:'http://example.invalid:7890/',https_proxy:'http://example.invalid:7890/'}),
 ];
 for(const networkEnvironment of cases){
  const x=fixture(t);
  await assert.rejects(open(x,{networkEnvironment}),{code:'MAGPIE_NETWORK_ENVIRONMENT_INVALID'});
  assert.equal(x.launched(),0);assert.equal(x.writes(),0);assert.equal(x.stops(),0);assert.equal(x.budget.requests().length,0);
 }
});
test('tampered pinned binary refuses before a process or ledger request',async t=>{
 const x=fixture(t);writeFileSync(x.binary.path,'CHANGED');await assert.rejects(open(x),{code:'MAGPIE_EXECUTABLE_CHANGED'});assert.equal(x.launched(),0);assert.equal(x.budget.requests().length,0);
});
test('foreign target, directory, listener, discovery or qualification refuses and closes',async t=>{
 for(const edit of [{pid:123},{commit:'0'.repeat(40)},{address:'0.0.0.0:1234'},{address:'127.0.0.1:65536'},{configDir:'C:/foreign'},{accountDiscovery:'ON'},{accountCount:1},{accounts:[{}]},{issuedKeyCount:1},{qualification:'VERIFIED'},{unexpected:true}]){
  const x=fixture(t,{edit});await assert.rejects(open(x),{code:'MAGPIE_READY_INVALID'});assert.equal(x.stops(),1);assert.equal(x.budget.requests().length,0);
 }
});
test('output limit, private stderr and trailing frames fail closed without raw errors',async t=>{
 for(const reply of [(_r,out)=>out.write('x'.repeat(16385)),(_r,_out,err)=>err.write('SYNTHETIC_PRIVATE_START_ERROR'),(r,out)=>out.write(JSON.stringify(r)+'\n{}\n')]){
  const x=fixture(t,{reply});await assert.rejects(open(x),e=>e.code.startsWith('MAGPIE_')&&!e.message.includes('SYNTHETIC_PRIVATE'));assert.equal(x.stops(),1);
 }
});
test('bootstrap write and read share a deadline even after ready is received',async t=>{
 const x=fixture(t,{hangWrite:true});await assert.rejects(open(x,{timeoutMs:100}),{code:'MAGPIE_START_TIMEOUT'});assert.equal(x.stops(),1);
});
test('already aborted does not launch; startup cancellation joins cleanup once',async t=>{
 const a=new AbortController();a.abort();const x=fixture(t);await assert.rejects(open(x,{signal:a.signal}),{code:'MAGPIE_START_CANCELLED'});assert.equal(x.launched(),0);
 const b=new AbortController(),y=fixture(t,{reply:()=>queueMicrotask(()=>b.abort())});await assert.rejects(open(y,{signal:b.signal}),{code:'MAGPIE_START_CANCELLED'});assert.equal(y.stops(),1);
});
test('startup failure retains cleanup uncertainty and never discloses transport details',async t=>{
 const x=fixture(t,{edit:{pid:123},badCleanup:true});await assert.rejects(open(x),e=>e.code==='PROCESS_CLEANUP_UNPROVEN'&&!e.message.includes('PRIVATE'));assert.equal(x.stops(),1);
});
test('NativeOwner refuses missing candidate without reading credentials or creating a new ledger',async t=>{
 let reads=0,owner;t.after(()=>owner?.close());const h=harness(t);owner=createNativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,getSecret:()=>{reads++;throw Error('MUST_NOT_READ');}});
 assert.equal(typeof owner.inspectMagpieIngress,'function');await assert.rejects(owner.inspectMagpieIngress(),{code:'MAGPIE_CANDIDATE_BINDING_REQUIRED'});assert.equal(reads,0);assert.equal(existsSync(join(h.dir,'.runtime/controller/native-budget.sqlite')),false);
});
test('NativeOwner requires the current CFW environment for its empty-account Magpie process before launch',async t=>{
 let reads=0;const h=harness(t),source=join(h.dir,'candidate.exe');writeFileSync(source,'SYNTHETIC_EXECUTABLE_BYTES_NOT_NATIVE');
 const binary={path:source,sha256:hash(readFileSync(source))},requests=[];
 h.config.clash.enabled=true;
 const owner=createNativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,getSecret:()=>{reads++;throw Error('MUST_NOT_READ');},magpieCandidate:binary});
 t.after(()=>owner.close());
 owner.assertNativeCleanup=()=>{};
 owner.configured=()=>({op:{maxRequests:8},budget:{summary:()=>({inFlight:0}),requests:()=>requests}});
 await assert.rejects(owner.inspectMagpieIngress(),{code:'MAGPIE_CONTROLLED_NETWORK_REQUIRED'});
 assert.equal(reads,0);assert.deepEqual(requests,[]);
});
test('NativeOwner leaves the Magpie environment untouched when DM Clash routing is disabled',async t=>{
 const h=harness(t),owner=createNativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config});
 t.after(()=>owner.close());h.config.clash.enabled=false;
 const base={PATH:'C:/Windows/System32',MAGPIE_NO_ACCOUNTS:'1'};
 assert.equal(owner.customMagpieNetworkEnvironment(base),base);
});
const syntheticAccount=(suffix='one')=>({provider:'deepseek-official',authRef:'synthetic_auth_'+suffix,accountRef:'synthetic_account_'+suffix,key:'DM_SYNTHETIC_ACCOUNT_KEY_'+suffix});

test('unmarked credentials cannot enter the raw synthetic bootstrap path',async t=>{
 const x=fixture(t);await assert.rejects(open(x,{bootstrapAccounts:[{...syntheticAccount(),key:'UNMARKED_SYNTHETIC_PRIVATE_VALUE_NOT_REAL'}]}),{code:'MAGPIE_BOOTSTRAP_ACCOUNTS_INVALID'});assert.equal(x.launched(),0);assert.equal(x.writes(),0);
});

test('custodied accounts are present in the actual bootstrap frame and mapped by ready',async t=>{
 const x=fixture(t),{createMagpieAccountCustody}=await import('../../dist/server/magpie-account-custody.js'),role=(id,write=false)=>({id,provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 const snapshot={schema:'dream-maker.flow-config.v2',mode:'custom',projectId:'project_offline',runId:'run_offline',plan:{versionId:'spec_offline',revision:1,contentHash:'a'.repeat(64),specHash:'b'.repeat(64)},profile:{revision:1,contentHash:'c'.repeat(64)},accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE'}],roles:{planner2:role('planner2'),executors:[role('worker-one',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai',laya:{enabled:false,mode:'off',roles:[]},magpie:{ownership:'DM_ONLY',routing:'MODELS_ONLY'},qualification:'NOT_VERIFIED',configurationFingerprint:'d'.repeat(64)};
 const binding={flowConfigHash:hash(snapshot),sourceBindingHash:'e'.repeat(64)};let reads=0;
 const custody=createMagpieAccountCustody({snapshot,binding,sources:[{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE',secretEnv:'DEEPSEEK_API_KEY'}],dshKeyEnv:'DEEPSEEK_API_KEY',getSecret:()=>{reads++;return'UNMARKED_SYNTHETIC_CUSTODY_TEST';},assertCurrent:()=>binding});
 const session=await open(x,{accountCustody:custody,custodyBinding:binding});t.after(()=>session.close());assert.equal(reads,1);assert.equal(session.observation.accountCount,1);assert.equal(session.observation.accounts[0].authRef,'AUTH_ONE');assert.equal(session.observation.realCredentialsPermitted,true);assert.equal(session.observation.qualification,'NOT_VERIFIED');
});

test('an owned account stages final Messages bytes before the original budget can reserve them',async t=>{
 const x=fixture(t),session=await open(x,{bootstrapAccounts:[syntheticAccount()]});t.after(()=>session.close());
 const account=session.observation.accounts[0],route={runtime:'dsh',protocol:'anthropic-messages',...account},raw=JSON.stringify({model:'deepseek-flash',max_tokens:128,messages:[{role:'user',content:'OFFLINE_TEXT_ONLY'}],stream:true});
 const payload=session.prepareModelPayload(route,raw);
 assert.equal(JSON.parse(payload.body).model,'deepseek-official/deepseek-flash');assert.equal(payload.bodyHash,hash(payload.body));assert.notEqual(payload.bodyHash,hash(raw));
 assert.equal(JSON.parse(raw).model,'deepseek-flash');assert.equal(payload.path,'/v1/messages');assert.equal(payload.method,'POST');assert.equal(payload.maxOutputTokens,128);assert.equal(payload.executionGranted,false);
 assert.equal(payload.route.upstreamAccountRef,account.upstreamAccountRef);assert.equal(Object.isFrozen(payload),true);assert.equal(Object.isFrozen(payload.route),true);
 assert.equal(x.budget.requests().length,0);assert.equal(x.writes(),1);
});

test('staging refuses a borrowed account, another protocol or dynamic route without reading its getter',async t=>{
 const x=fixture(t),session=await open(x,{bootstrapAccounts:[syntheticAccount()]});t.after(()=>session.close());const route={runtime:'dsh',protocol:'anthropic-messages',...session.observation.accounts[0]},body=JSON.stringify({model:'deepseek-flash',max_tokens:128,messages:[{role:'user',content:'OFFLINE'}]});
 let reads=0;const dynamic={...route};Object.defineProperty(dynamic,'authRef',{enumerable:true,get(){reads++;return route.authRef;}});
 for(const selected of [{...route,authRef:'other'},{...route,upstreamAccountRef:'deepseek-official/0000000000'},{...route,runtime:'copilot-sdk'},{...route,protocol:'openai-responses'},{...route,model:'another'},dynamic])assert.throws(()=>session.prepareModelPayload(selected,body));
 assert.equal(reads,0);assert.equal(x.budget.requests().length,0);assert.equal(x.writes(),1);
 const empty=fixture(t),noAccounts=await open(empty);t.after(()=>noAccounts.close());assert.throws(()=>noAccounts.prepareModelPayload(route,body),{code:'MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'});
});

test('one credential may stage every declared model and still refuse an outsider',async t=>{
 const x=fixture(t),session=await open(x,{bootstrapAccounts:[{...syntheticAccount(),model:'deepseek-flash',models:['deepseek-chat','deepseek-reasoner']}]});t.after(()=>session.close());
 const account=session.observation.accounts[0],base={runtime:'independent',protocol:'chat-completions',provider:account.provider,authRef:account.authRef,accountRef:account.accountRef,upstreamAccountRef:account.upstreamAccountRef,authentication:account.authentication};
 assert.deepEqual(account.models,['deepseek-chat','deepseek-reasoner']);
 for(const model of ['deepseek-flash','deepseek-chat','deepseek-reasoner']){
  const payload=session.prepareModelPayload({...base,model},JSON.stringify({model,messages:[{role:'user',content:'OFFLINE'}],max_tokens:64}));
  assert.equal(JSON.parse(payload.body).model,'deepseek-official/'+model);
 }
 assert.throws(()=>session.prepareModelPayload({...base,model:'deepseek-undeclared'},JSON.stringify({model:'deepseek-undeclared',messages:[{role:'user',content:'OFFLINE'}],max_tokens:64})),{code:'MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'});
});

test('a registered account stages chat-completions and responses bodies on their own paths',async t=>{
 const x=fixture(t),session=await open(x,{bootstrapAccounts:[syntheticAccount()]});t.after(()=>session.close());
 const registered=session.observation.accounts[0];
 const chat=session.prepareModelPayload({runtime:'independent',protocol:'chat-completions',...registered},JSON.stringify({model:'deepseek-flash',messages:[{role:'user',content:'OFFLINE'}],max_tokens:64}));
 assert.equal(chat.path,'/v1/chat/completions');assert.equal(chat.maxOutputTokens,64);
 assert.equal(JSON.parse(chat.body).model,'deepseek-official/deepseek-flash');
 const responses=session.prepareModelPayload({runtime:'codex',protocol:'openai-responses',...registered},JSON.stringify({model:'deepseek-flash',input:'OFFLINE',max_output_tokens:32}));
 assert.equal(responses.path,'/v1/responses');assert.equal(responses.maxOutputTokens,32);
 assert.equal(JSON.parse(responses.body).model,'deepseek-official/deepseek-flash');
 // Protocol/body shape must stay paired: an Anthropic body under a chat route is refused.
 assert.throws(()=>session.prepareModelPayload({runtime:'independent',protocol:'chat-completions',...registered},JSON.stringify({model:'deepseek-flash',messages:[{role:'user',content:'OFFLINE'}],max_tokens:64,thinking:{type:'disabled'}})),{code:'MAGPIE_PAYLOAD_INVALID'});
 assert.throws(()=>session.prepareModelPayload({runtime:'codex',protocol:'openai-responses',...registered},JSON.stringify({model:'deepseek-flash',messages:[{role:'user',content:'OFFLINE'}],max_tokens:64})),{code:'MAGPIE_PAYLOAD_INVALID'});
});

// deepseek-v4-pro is a reasoning model whose whole output budget can disappear into reasoning,
// returning an empty content string (measured: 8192 completion tokens, all reasoning). The gateway
// therefore forwards the upstream's own `reasoning_effort` lever, bounded to the documented values.
test('a chat body stages a bounded reasoning_effort and refuses anything else',async t=>{
 const x=fixture(t),session=await open(x,{bootstrapAccounts:[syntheticAccount()]});t.after(()=>session.close());
 const registered=session.observation.accounts[0],route={runtime:'independent',protocol:'chat-completions',...registered};
 const base={model:'deepseek-flash',messages:[{role:'user',content:'OFFLINE'}],max_tokens:64};
 for(const effort of ['low','medium','high']){
  const staged=session.prepareModelPayload(route,JSON.stringify({...base,reasoning_effort:effort}));
  assert.equal(JSON.parse(staged.body).reasoning_effort,effort);
 }
 for(const bad of ['minimal','none','LOW','',0,true,{effort:'low'}])
  assert.throws(()=>session.prepareModelPayload(route,JSON.stringify({...base,reasoning_effort:bad})),{code:'MAGPIE_PAYLOAD_INVALID'});
});

test('invalid or widened payloads and closed processes cannot stage or write another control frame',async t=>{
 const x=fixture(t),session=await open(x,{bootstrapAccounts:[syntheticAccount()]});t.after(()=>session.close());const route={runtime:'dsh',protocol:'anthropic-messages',...session.observation.accounts[0]},base={model:'deepseek-flash',max_tokens:128,messages:[{role:'user',content:'OFFLINE'}]};
 for(const body of ['{','x'.repeat(262145),'[]',JSON.stringify({...base,model:'other'}),JSON.stringify({...base,max_tokens:0}),JSON.stringify({...base,max_tokens:16001}),JSON.stringify({...base,max_completion_tokens:128}),JSON.stringify({...base,stream:'true'}),JSON.stringify({...base,endpoint:'https://untrusted.invalid'}),JSON.stringify({...base,thinking:{type:'enabled',budget_tokens:128}})])assert.throws(()=>session.prepareModelPayload(route,body),{code:'MAGPIE_PAYLOAD_INVALID'});
 assert.equal(x.writes(),1);await session.close();assert.throws(()=>session.prepareModelPayload(route,JSON.stringify(base)),{code:'MAGPIE_CONTROL_CLOSED'});assert.equal(x.budget.requests().length,0);
});

for(const kind of ['role','nested'])test('untrusted '+kind+' data fails as a bounded payload error',async t=>{
 const x=fixture(t),session=await open(x,{bootstrapAccounts:[syntheticAccount()]});t.after(()=>session.close());const route={runtime:'dsh',protocol:'anthropic-messages',...session.observation.accounts[0]};
 const role=JSON.stringify({model:'deepseek-flash',max_tokens:128,messages:[{role:{toString:'UNTRUSTED'},content:'OFFLINE'}]}),nested='{"model":"deepseek-flash","max_tokens":128,"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"offline","name":"offline","input":'+'{"child":'.repeat(10000)+'0'+'}'.repeat(10000)+'}]}]}';
 assert.throws(()=>session.prepareModelPayload(route,kind==='role'?role:nested),{code:'MAGPIE_PAYLOAD_INVALID'});
 assert.equal(x.writes(),1);assert.equal(x.budget.requests().length,0);
});
test('owned v2 registers only the explicit memory accounts and returns key-free canonical mappings',async t=>{
 const x=fixture(t),accounts=[syntheticAccount(),syntheticAccount('two')],session=await open(x,{bootstrapAccounts:accounts});t.after(()=>session.close());
 assert.equal(session.observation.accountCount,2);assert.equal(session.observation.credentialsAccepted,true);assert.equal(session.observation.realCredentialsPermitted,false);
 assert.equal(session.observation.accounts[0].upstreamAccountRef,'deepseek-official/'+createHash('sha256').update(accounts[0].key).digest('hex').slice(0,10));
 const projection=JSON.stringify({observation:session.observation,launch:x.options(),requests:x.budget.requests()});for(const a of accounts)assert.equal(projection.includes(a.key),false);
 assert.equal(x.budget.requests().length,0);await session.close();assert.equal(x.stops(),1);
});
test('memory bootstrap refuses accessors, duplicate identities, unknown fields and excessive accounts before launch',async t=>{
 let reads=0;const accessor=syntheticAccount();Object.defineProperty(accessor,'key',{enumerable:true,get(){reads++;return 'MUST_NOT_READ';}});
 const keyed=syntheticAccount('two'),one=syntheticAccount();
 for(const accounts of [[accessor],[{...one,provider:'unapproved'}],[{...one,url:'https://example.invalid'}],[one,{...keyed,key:one.key}],[one,{...keyed,authRef:one.authRef}],[one,{...keyed,accountRef:one.accountRef}],Array.from({length:9},(_,i)=>syntheticAccount(String(i))),[undefined]]){
  const x=fixture(t);await assert.rejects(open(x,{bootstrapAccounts:accounts}),{code:'MAGPIE_BOOTSTRAP_ACCOUNTS_INVALID'});assert.equal(x.launched(),0);
 }
 assert.equal(reads,0);
});
test('v2 ready cannot substitute an account, omit its mapping or echo private key material',async t=>{
 for(const edit of [{controlSchema:'dream-maker.magpie-control.v1'},{accounts:[]},{accounts:[{provider:'deepseek-official',authRef:'foreign',accountRef:'foreign',upstreamAccountRef:'deepseek-official/0000000000',authentication:'api_key',model:'deepseek-flash'}]}]){
  const x=fixture(t,{edit});await assert.rejects(open(x,{bootstrapAccounts:[syntheticAccount()]}),{code:'MAGPIE_READY_INVALID'});assert.equal(x.stops(),1);
 }
});

// Stage B needs several distinct models behind one DM-owned Magpie. The account may now carry its
// own model; omitting it must keep the historical deepseek-flash default byte-for-byte.
test('a bootstrap account may name its own model and otherwise defaults to deepseek-flash',async t=>{
 const x=fixture(t),session=await open(x,{bootstrapAccounts:[{...syntheticAccount('chat'),model:'deepseek-chat'},syntheticAccount('flash')]});
 t.after(()=>session.close());
 const byRef=Object.fromEntries(session.observation.accounts.map(a=>[a.authRef,a.model]));
 assert.equal(byRef['synthetic_auth_chat'],'deepseek-chat');
 assert.equal(byRef['synthetic_auth_flash'],'deepseek-flash');
});
// A Pi executor sends the ordinary streaming chat-completions shape. Only the usage
// hint the DM gateway injects is admitted, and only in its exact one-key form.
test('a Pi executor route admits the streaming chat shape but not a foreign stream option',async t=>{
 const x=fixture(t),session=await open(x,{bootstrapAccounts:[{...syntheticAccount('pi_flash'),models:['deepseek-flash']}]});
 t.after(()=>session.close());
 const registered=session.observation.accounts[0],
  route={runtime:'pi',provider:'deepseek-official',protocol:'chat-completions',model:'deepseek-flash',authentication:'api_key',
   authRef:registered.authRef,accountRef:registered.accountRef,upstreamAccountRef:registered.upstreamAccountRef},
  body={model:'deepseek-flash',max_tokens:512,stream:true,stream_options:{include_usage:true},
   messages:[{role:'user',content:'Build the assigned task.'}],
   tools:[{type:'function',function:{name:'desk_read',description:'Read one approved file.',parameters:{type:'object'}}}]};
 const prepared=session.prepareModelPayload(route,JSON.stringify(body));
 assert.equal(prepared.maxOutputTokens,512);
 assert.equal(JSON.parse(prepared.body).model,'deepseek-official/deepseek-flash');
 for(const bad of [{stream_options:{include_usage:true,extra:1}},{stream_options:{include_usage:false}},{stream_options:{}},{stream_options:true}])
  assert.throws(()=>session.prepareModelPayload(route,JSON.stringify({...body,...bad})),{code:'MAGPIE_PAYLOAD_INVALID'});
});
test('v5 keeps model and protocol authority local to the declared credential',async t=>{
 const chat='chat-completions',messages='anthropic-messages',responses='openai-responses';
 const cap=(model,protocol,endpoint)=>({model,protocol,endpoint});
 const first=cap('shared',chat,'https://a.example.test/v1/chat/completions');
 const second=cap('review',messages,'https://b.example.test/v1/messages');
 const third=cap('shared',responses,'https://c.example.test/v1/responses');
 const input=[['gateway-a',first],['gateway-a',second],['gateway-b',third]].map(([provider,c],i)=>({provider,authRef:'auth'+i,accountRef:'alias'+i,key:'DM_SYNTHETIC_EXPLICIT_'+i,capabilities:[c]}));
 const x=fixture(t,{inspectBootstrap:boot=>{assert.equal(boot.schema,'dream-maker.magpie-control.v5');for(const a of boot.accounts)assert.deepEqual(Object.keys(a).sort(),['accountRef','authRef','authentication','capabilities','key','provider']);}});
 const session=await open(x,{bootstrapAccounts:input});t.after(()=>session.close());
 const rows=session.observation.accounts;
 const route=i=>({runtime:'independent',provider:rows[i].provider,authentication:'api_key',authRef:rows[i].authRef,accountRef:rows[i].accountRef,upstreamAccountRef:rows[i].upstreamAccountRef,model:rows[i].model,protocol:rows[i].capabilities[0].protocol});
 const body=(model,protocol)=>JSON.stringify(protocol===responses?{model,input:'hi',max_output_tokens:8}:{model,messages:[{role:'user',content:'hi'}],max_tokens:8});
 for(let i=0;i<3;i++)assert.equal(session.prepareModelPayload(route(i),body(route(i).model,route(i).protocol)).route.protocol,route(i).protocol);
 for(const swap of [{model:'review',protocol:messages},{protocol:responses},{provider:rows[2].provider},{upstreamAccountRef:rows[1].upstreamAccountRef},{authRef:rows[1].authRef},{accountRef:rows[1].accountRef}]){
  const altered={...route(0),...swap};
  assert.throws(()=>session.prepareModelPayload(altered,body(altered.model,altered.protocol)),e=>['MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE','MAGPIE_ROUTE_INVALID'].includes(e.code));
 }
 const paid={...route(2),runtime:'codex'},limits={model:paid.model,maxOutputTokens:5,prompt:'hi',instructions:'review'};
 const raw=JSON.stringify({model:paid.model,input:[{type:'message',role:'user',content:[{type:'input_text',text:'hi'}]}],store:false,stream:true,max_output_tokens:8});
 assert.throws(()=>session.prepareModelPayload(paid,raw),{code:'MAGPIE_PAYLOAD_ROUTE_UNAVAILABLE'});
 const bounded=session.prepareModelPayload(paid,raw,limits);assert.equal(bounded.path,'/v1/responses');assert.equal(bounded.maxOutputTokens,5);
 assert.equal(JSON.parse(bounded.body).instructions,'review');assert.equal(JSON.parse(bounded.body).model,paid.provider+'/'+paid.model);
 assert.throws(()=>session.prepareModelPayload(paid,raw,{...limits,prompt:'changed'}));
 assert.throws(()=>rows[0].capabilities.push(second),TypeError);assert.throws(()=>{rows[0].capabilities[0].protocol=messages;},TypeError);
 assert.equal(x.budget.requests().length,0);
});
test('v5 ready must attest the complete endpoint on the exact credential',async t=>{
 const capabilities=[{model:'shared',protocol:'chat-completions',endpoint:'https://a.example.test/v1/chat/completions'}];
 const x=fixture(t,{reply:(value,out)=>{value.accounts[0].capabilities[0].endpoint='https://b.example.test/v1/chat/completions';queueMicrotask(()=>out.write(JSON.stringify(value)+'\n'));}});
 await assert.rejects(open(x,{bootstrapAccounts:[{provider:'gateway-a',authRef:'auth',accountRef:'account',key:'DM_SYNTHETIC_EXPLICIT',capabilities}]}),{code:'MAGPIE_READY_INVALID'});
 assert.equal(x.stops(),1);assert.equal(x.budget.requests().length,0);
});
test('v5 control accepts 17 full endpoint pairs per key and refuses a 65th pair before launch',async t=>{
 const entries=n=>Array.from({length:n},(_,i)=>({model:'m'+i,protocol:'chat-completions',endpoint:'https://offline.example.test/'+('path/'.repeat(55))+i+'/chat/completions'}));
 const accounts=Array.from({length:4},(_,i)=>({provider:'provider-'+i,authRef:'AUTH_'+i,accountRef:'ACCOUNT_'+i,key:'DM_SYNTHETIC_CAPACITY_'+i,capabilities:entries(17)}));
 const x=fixture(t,{inspectBootstrap:boot=>{assert.ok(Buffer.byteLength(JSON.stringify(boot))>16384);}});
 const session=await open(x,{bootstrapAccounts:accounts});t.after(()=>session.close());assert.equal(session.observation.accounts[3].capabilities.length,17);
 const y=fixture(t);await assert.rejects(open(y,{bootstrapAccounts:[{...accounts[0],capabilities:entries(65)}]}),{code:'MAGPIE_BOOTSTRAP_ACCOUNTS_INVALID'});assert.equal(y.launched(),0);
});
