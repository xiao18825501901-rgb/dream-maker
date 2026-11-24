// OFFLINE model responses with real localhost Gateway, original ledger and control pipe.
// No provider credentials, real model request, user Run or role qualification.
import test from 'node:test';import assert from 'node:assert/strict';
import {Writable,PassThrough} from 'node:stream';import {join} from 'node:path';
import {createServer} from 'node:http';
import {NativeBudget} from '../../dist/server/native-budget.js';
import {DeepSeekGateway} from '../../dist/server/deepseek-gateway.js';
import {MagpieAdmissionPipe} from '../../dist/server/magpie-control.js';
import {magpieRouteHash} from '../../dist/server/magpie-route.js';
import {hash,DomainError,networkFailureError} from '../../dist/server/security.js';import {harness} from '../helpers.mjs';
import {classifyNetworkResponse} from '../../dist/server/network-failure.js';
import {offlineCustomBudget,offlineCustomQualification} from '../fixtures/custom-budget.mjs';
const authority={scopeId:'OFFLINE_MAGPIE_MODEL_BRIDGE',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2};
const route=()=>({runtime:'dsh',provider:'deepseek-official',protocol:'anthropic-messages',model:'deepseek-flash',authentication:'api_key',authRef:'offline_auth',accountRef:'offline_account',upstreamAccountRef:'deepseek-official/0123456789'});
const price=()=>({provider:'deepseek-official',model:'deepseek-flash',currency:'CNY',source:'OFFLINE_PRICE_NOT_AUTHORIZATION',expiresAt:new Date(Date.now()+60000).toISOString(),maxInputTokens:1048576,inputMissMicrosPerMillion:2000000,inputHitMicrosPerMillion:40000,outputMicrosPerMillion:8000000});
const body=()=>JSON.stringify({model:'deepseek-flash',max_tokens:128,messages:[{role:'user',content:'OFFLINE synthetic request'}],stream:false});
const terminalTool=role=>({name:role==='planner2'?'submit_engineering_plan':'submit_review',input_schema:{type:'object'}});
const scope=(payload,mode='custom')=>({schema:'dream-maker.native-request-binding.v1',projectId:'offline_project',runId:'offline_run',engineeringMode:mode,configurationHash:'a'.repeat(64),planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),dispatchId:'offline_dispatch',generation:'offline_owner',role:'executor',roleId:'executor-1',work:{kind:'TASK',taskIdHash:'d'.repeat(64),executorSliceId:null},bodyHash:payload.bodyHash,routeHash:payload.routeHash});
async function setup(t,options={}){
 const {MagpieDshRequestTransport}=await import('../../dist/server/magpie-model-transport.js');
 let gateway,budget,control;
 // Register before harness cleanup: Windows cannot remove a still-open SQLite file.
 t.after(async()=>{try{if(gateway)await gateway.close();else await control?.close();}finally{budget?.close();}});
 const h=harness(t);budget=new NativeBudget(join(h.dir,'magpie-model-budget.sqlite'),authority,undefined,undefined,'FULL_DM',options.customBudget??offlineCustomBudget,offlineCustomQualification);const output=new PassThrough();let finish,writes=0,requests=0,stops=0,checks=0,preparedBody,abortClose,wire='';const statuses=[];
 const responseModel=options.responseModel??'deepseek-flash';
  const protocol=options.wire??'anthropic-messages';
  const selectedRoute=options.route??(options.wire?{...route(),protocol:options.wire}:route());
  const upstreamPath=protocol==='anthropic-messages'?'/v1/messages':'/v1/chat/completions';
 const closed=new Promise(r=>finish=r),epoch='offline_model_epoch',secret='sk-magpie-key-'+'f'.repeat(48);
 const input=new Writable({write(bytes,_encoding,callback){
  const raw=bytes.toString().replace(/\n$/,''),frame=JSON.parse(raw);writes++;
  if(frame.type==='issue'){const a=frame.request,accepted=options.issueDenied!==true;output.write(JSON.stringify({type:'issued',schema:'dream-maker.magpie-issued-key.v1',epoch,id:a.id,reservationId:a.reservationId,controlHash:hash(raw),accepted,...(accepted?{upstreamKeyId:'e'.repeat(24),upstreamKey:secret,expiresAtMs:Date.now()+120000}:{})})+'\n');}
  else{const a=frame.admission;assert.equal(budget.requests()[0].routerAdmission.status,'INTENT');output.write(JSON.stringify({type:'admission',schema:'dream-maker.magpie-admission-ack.v2',epoch,id:a.id,reservationId:a.reservationId,controlHash:hash(raw),accepted:options.denied!==true})+'\n');}
  callback();
 }});
 control=new MagpieAdmissionPipe({input,output,closed,stop:async()=>{stops++;finish();}},budget,{epoch,binaryHash:'1'.repeat(64),ackTimeoutMs:5000});
 const addressForTransport=options.actualAddress??'127.0.0.1:12345';
 const account={...selectedRoute,...(options.capabilities?{capabilities:options.capabilities}:{})};
 const session={control,close:()=>control.close(),observation:{address:addressForTransport,epoch,accounts:[account]},prepareModelPayload(selected,raw){
  const parsed=JSON.parse(raw),wire=JSON.stringify({...parsed,model:selected.provider+'/'+selected.model});preparedBody=wire;
   return Object.freeze({schema:'dream-maker.magpie-model-payload.v1',route:Object.freeze({...selected}),routeHash:magpieRouteHash(selected),body:wire,bodyHash:hash(wire),method:'POST',path:upstreamPath,maxOutputTokens:parsed.max_tokens,executionGranted:false});
 }};
 const probeRole=options.role??'executor',probeRoleId=probeRole==='executor'?'executor-1':probeRole;
 const probeContext=options.probe?{schema:'dream-maker.custom-probe-budget.v1',probeId:'custom_probe_OFFLINE_GATEWAY',bindingHash:'2'.repeat(64),projectId:'offline_project',runId:'offline_run',configurationHash:'a'.repeat(64),planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),role:probeRole,roleId:probeRoleId,dispatchId:'offline_dispatch',generation:'offline_owner',routeHash:magpieRouteHash(route()),flowBudget:{currency:'CNY',maxMicros:50000000},roleBudget:{currency:'CNY',maxMicros:50000000}}:undefined;
 const probePermit=probeContext?budget.beginCustomProbe(probeContext):undefined;let probeChecks=0;
   const channel=new MagpieDshRequestTransport({session,budget,route:selectedRoute,...(options.role?{role:options.role}:{}),bindRequest:payload=>{const bound=scope(payload,options.mode);return options.probe?{...bound,role:probeRole,roleId:probeRoleId,work:{kind:'QUALIFICATION',probeId:probeContext.probeId,bindingHash:probeContext.bindingHash}}:options.role?{...bound,role:options.foreignRole??options.role,roleId:options.foreignRole??options.role,work:{kind:'SUPERVISION'}}:bound;},assertCurrent(){checks++;if(options.staleAfterGrant&&writes===2)throw new DomainError('NATIVE_REQUEST_BINDING_STALE',409);},transport:async(url,init)=>{
   requests++;assert.equal(url,'http://'+addressForTransport+upstreamPath);assert.equal(init.redirect,'error');assert.equal(init.body,preparedBody);assert.equal(init.headers['content-type'],'application/json');assert.match(init.headers.authorization,/^Bearer [a-f0-9]{64}$/);
  const row=budget.requests()[0];assert.equal(row.routerAdmission.status,'ACKNOWLEDGED');assert.equal(row.usageStatus,'PENDING');assert.equal(row.binding.bodyHash,hash(init.body));
   if(options.role&&!options.probe&&!options.route&&protocol==='anthropic-messages'){
   const sent=JSON.parse(init.body),name=options.roleToolName??terminalTool(options.role).name;
   assert.deepEqual(sent.tools,[terminalTool(options.role)]);
   assert.deepEqual(sent.tool_choice,{type:'tool',name});
    assert.deepEqual(sent.thinking,{type:'disabled'});
  }
   if(options.role&&!options.probe&&!options.route&&protocol==='chat-completions')
    assert.deepEqual(JSON.parse(init.body).tools,[]);
  if(options.transportFailure)throw options.transportFailure;
  if(options.actualAddress)return fetch(url,init);
  if(options.disconnect)throw Object.assign(Error('OFFLINE private transport detail'),{code:'ECONNRESET'});
  if(options.cancelAtResponse)abortClose=gateway.close();
  if(options.probe){assert.deepEqual(JSON.parse(init.body).tools,[]);assert.equal(JSON.parse(init.body).tool_choice,undefined);assert.equal(row.customProbe.probeId,probeContext.probeId);}
  if(options.toolEcho){
   const value=options.toolEcho==='valid'?'README.md':options.toolEcho.includes('key')?secret:init.headers.authorization.slice(7);
   const encoded=options.toolEcho.startsWith('escaped')?[...value].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join(''):value;
   const args='{"path":"'+encoded+'"'+(options.toolEcho.includes('duplicate')?',"path":"README.md"':'')+'}',fragments=args.match(/.{1,7}/g),event=value=>'data: '+JSON.stringify(value)+'\n\n';
   const toolName=options.responseToolName??(options.toolEcho==='terminal'?terminalTool(options.role).name:'read_file');
   const initial=options.toolEcho==='terminal'?options.role==='planner2'?{tasks:[]}:{verdict:'PASS',findings:[]}:{};
   const toolDelta=options.toolEcho==='terminal'?'':fragments.map(part=>event({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:part}})).join('');
   const payload=event({type:'message_start',message:{id:'offline_response',model:responseModel}})+event({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'offline_tool',name:toolName,input:initial}})+
    toolDelta+event({type:'content_block_stop',index:0})+event({type:'message_delta',delta:{stop_reason:'tool_use'}})+event({type:'message_stop'});
   return new Response(payload,{headers:{'content-type':'text/event-stream'}});
  }
  if(options.chatToolResponse)
   return Response.json({id:'offline_response',model:responseModel,choices:[{index:0,message:{content:null,tool_calls:[{id:'offline_tool',type:'function',function:{name:'read_file',arguments:{PRIVATE_ARGUMENT_CANARY:true}}}]},finish_reason:'tool_calls'}]});
  if(options.streamResponse){
   const event=value=>'data: '+JSON.stringify(value)+'\n\n';
   const payload=event({type:'message_start',message:{id:'offline_response',model:responseModel,usage:{input_tokens:8,output_tokens:0}}})+
    event({type:'content_block_start',index:0,content_block:{type:'text',text:''}})+
    event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'offline result'}})+
    event({type:'content_block_stop',index:0})+
    event({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}})+
    event({type:'message_stop'});
   return new Response(payload,{headers:{'content-type':'text/event-stream'}});
  }
  return Response.json({id:'offline_response',model:responseModel,type:'message',role:'assistant',content:[{type:'text',text:options.echoKey?secret:options.echoToken?init.headers.authorization.slice(7):'offline result'}],stop_reason:'end_turn'});
  }});
 const probeGuard=bound=>{probeChecks++;assert.equal(bound.role,probeRole);assert.equal(bound.work.kind,'QUALIFICATION');if(options.probeGuard==='promise')return Promise.resolve();if(options.probeGuard==='boolean')return false;if(options.probeGuard==='stale'&&requests>0||options.probeGuard==='late'&&probeChecks>=3)throw new DomainError('CUSTOM_PROBE_CONTEXT_STALE',409);};
  gateway=new DeepSeekGateway(budget,options.price??price,'',128,1,()=>{throw Error('DIRECT_PROVIDER_ROUTE_MUST_NOT_RUN');},protocol,!!options.probe,undefined,undefined,undefined,channel,options.probe?{permit:options.copiedProbePermit?{...probePermit}:probePermit,assertCurrent:probeGuard}:undefined,selectedRoute?.model);
 gateway.server.prependListener('request',(_request,response)=>{const write=response.write.bind(response),end=response.end.bind(response),head=response.writeHead.bind(response);response.write=(chunk,...args)=>{wire+=String(chunk);return write(chunk,...args);};response.end=(chunk,...args)=>{if(chunk)wire+=String(chunk);return end(chunk,...args);};response.writeHead=(status,...args)=>{statuses.push(status);return head(status,...args);};});
 const address=await gateway.start();
 const request=(query="")=>{
  const base=options.toolEcho||options.streamResponse?{...JSON.parse(body()),stream:true}:JSON.parse(body());
   const payload=options.role&&protocol==='anthropic-messages'?{...base,tools:[options.roleToolName?{name:options.roleToolName,input_schema:{type:'object'}}:terminalTool(options.role)],tool_choice:{type:'tool',name:options.roleToolName??terminalTool(options.role).name}}:base;
   const endpoint=protocol==='anthropic-messages'?'/messages':'/chat/completions';
   const auth=protocol==='anthropic-messages'?{'x-api-key':address.token}:{authorization:'Bearer '+address.token};
   return fetch(address.url+endpoint+query,{method:'POST',headers:{'content-type':'application/json',...auth},body:JSON.stringify(options.route?{...base,model:options.route.model,tools:[]}:payload)});
 };
 return{budget,gateway,channel,request,writes:()=>writes,requests:()=>requests,stops:()=>stops,checks:()=>checks,probeChecks:()=>probeChecks,probePermit,preparedBody:()=>preparedBody,wire:()=>wire,statuses,abortClosed:()=>abortClose};
}
test('Claude reviewer streams text through its reserved string route',async t=>{
 const model='claude-sonnet-5',provider='string';
 const selected={...route(),runtime:'claude',model,provider,upstreamAccountRef:'string/0123456789'};
 const x=await setup(t,{role:'reviewer',route:selected,responseModel:model,streamResponse:true,price:()=>({...price(),model,provider})});
 assert.equal((await x.request('?beta=true&extra=1')).status,400);
 const res=await x.request('?beta=true'),result=await res.text();
 assert.equal(res.status,200,result);assert.match(result,/offline result/);
 assert.equal(x.requests(),1);assert.equal(x.gateway.receipts()[0].completionObserved,true);
 assert.deepEqual(JSON.parse(x.preparedBody()).tools,[]);
 assert.equal(x.gateway.confirmedSupervisorOutput(model,'offline result').responseId,x.gateway.receipts()[0].responseId);
 for(const [m,s] of [[model,'different output'],['another-model','offline result']])
  assert.throws(()=>x.gateway.confirmedSupervisorOutput(m,s),{code:'ROLE_EXECUTION_IDENTITY_UNVERIFIED'});
});

for(const role of ['planner2','reviewer'])test('v5 Claude '+role+' accepts the fixed beta entry for its explicit Messages account',async t=>{
 const model='claude-sonnet-5',provider='offline-claude-relay';
 const selected={...route(),runtime:'claude',model,provider,upstreamAccountRef:provider+'/0123456789'};
 const x=await setup(t,{role,route:selected,capabilities:[{model,protocol:'anthropic-messages'}],responseModel:model,
  streamResponse:true,price:()=>({...price(),model,provider})});
 assert.equal(x.channel.claudeSupervisor,true);
 assert.equal((await x.request('?beta=true&extra=1')).status,400);
 const response=await x.request('?beta=true'),text=await response.text();
 assert.equal(response.status,200,text);assert.match(text,/offline result/);
 assert.deepEqual(JSON.parse(x.preparedBody()).tools,[]);
 assert.equal(JSON.parse(x.preparedBody()).tool_choice,undefined);
 assert.equal(x.gateway.confirmedSupervisorOutput(model,'offline result').outcome,'COMPLETE');
 assert.equal(x.budget.requests()[0].binding.role,role);
 assert.equal(x.requests(),1);
});

for(const [label,error,classification,retry] of [
 ['nested TLS failure',new TypeError('OFFLINE_PRIVATE_CAUSE_DETAIL',{cause:Object.assign(new Error('OFFLINE_PRIVATE_CAUSE_DETAIL'),{code:'CERT_HAS_EXPIRED'})}),'TLS_HANDSHAKE_FAILURE',true],
 ['nested deliberate abort',new TypeError('OFFLINE_PRIVATE_CAUSE_DETAIL',{cause:Object.assign(new Error('OFFLINE_PRIVATE_CAUSE_DETAIL'),{code:'ABORT_ERR'})}),'STREAM_INTERRUPTED',false],
 ['attached service policy',networkFailureError(classifyNetworkResponse({status:403,body:'{"error":{"code":"unsupported_country_region_territory"}}',requestId:'OFFLINE_PRIVATE_CAUSE_DETAIL'})),'REGION_OR_POLICY_RESTRICTED',false],
])test('Magpie preserves '+label+' without retrying or disclosing the original exception',async t=>{
 const x=await setup(t,{transportFailure:error}),response=await x.request(),text=await response.text();
 assert.equal(response.status,502);
 assert.equal(x.requests(),1);assert.equal(x.writes(),2);
 const receipt=x.gateway.receipts()[0];
 assert.equal(receipt.networkFailureClass,classification);
 assert.equal(receipt.automaticRetryAllowed,retry);
 if(label==='nested deliberate abort')assert.equal(receipt.transportErrorCode,'ABORT_ERR');
 const rows=x.budget.requests();assert.equal(rows.length,1);assert.equal(rows[0].usageStatus,'UNKNOWN');
 assert.equal(rows[0].chargedMicros,rows[0].reservedMicros);
 assert.equal(text.includes('OFFLINE_PRIVATE_CAUSE_DETAIL'),false);
 assert.equal(JSON.stringify({receipt,rows}).includes('OFFLINE_PRIVATE_CAUSE_DETAIL'),false);
 assert.equal(receipt.outcome,'MAGPIE_MODEL_TRANSPORT_LOST');
});

test('actual loopback socket loss retains the real fetch cause and never sends a second model request',async t=>{
 let actualRequests=0;
 const server=createServer((req,res)=>{
  actualRequests++;req.resume();req.on('end',()=>res.destroy());
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const address=server.address();assert.ok(address&&typeof address==='object');
 const x=await setup(t,{actualAddress:'127.0.0.1:'+address.port});
 const response=await x.request();assert.equal(response.status,502);await response.text();
 assert.equal(actualRequests,1);assert.equal(x.requests(),1);
 const receipt=x.gateway.receipts()[0];
 assert.equal(receipt.networkFailureClass,'STREAM_INTERRUPTED');
 assert.equal(receipt.transportErrorCode,'UND_ERR_SOCKET');
 assert.equal(receipt.outcome,'MAGPIE_MODEL_TRANSPORT_LOST');
 const rows=x.budget.requests();assert.equal(rows.length,1);assert.equal(rows[0].usageStatus,'UNKNOWN');
 assert.equal(rows[0].chargedMicros,rows[0].reservedMicros);
});

test('the original Gateway reserves final Magpie bytes and sends only after the original grant ACK',async t=>{
 const x=await setup(t),response=await x.request();assert.equal(response.status,200);assert.equal((await response.json()).content[0].text,'offline result');
 assert.equal(x.writes(),2);assert.equal(x.requests(),1);assert.ok(x.checks()>=3);
 const rows=x.budget.requests();assert.equal(rows.length,1);assert.equal(rows[0].binding.bodyHash,hash(x.preparedBody()));assert.equal(rows[0].binding.engineeringMode,'custom');assert.equal(rows[0].routerAdmission.status,'ACKNOWLEDGED');assert.equal(rows[0].usageStatus,'UNKNOWN');assert.equal(rows[0].outcome,'COMPLETE');
 // The Go gate applies the grant expiry to the entire upstream stream. Do not
 // silently reintroduce the old 30-second reasoning-turn cutoff; price expiry is earlier here.
 assert.equal(rows[0].routerAdmission.expiresAtMs,Date.parse(rows[0].price.expiresAt));
 assert.equal(JSON.stringify(rows).includes('sk-magpie-key-'),false);assert.equal(x.gateway.receipts()[0].observedModel,'deepseek-flash');assert.equal(x.gateway.receipts()[0].upstream,'http://127.0.0.1:12345/v1/messages');
});

test('the original Gateway accepts only the fixed Magpie canonical model and records the bare model ID',async t=>{
 const x=await setup(t,{probe:true,role:'planner2',responseModel:'deepseek-official/deepseek-flash',streamResponse:true}),response=await x.request();
 assert.equal(response.status,200);const text=await response.text();assert.match(text,/offline result/);
 const receipt=x.gateway.receipts()[0];assert.equal(receipt.responseModelMatched,true);assert.equal(receipt.observedModel,'deepseek-flash');assert.equal(receipt.outcome,'COMPLETE');
});
test('Magpie cannot widen model acceptance beyond the exact prepared canonical route',async t=>{
 const x=await setup(t,{probe:true,role:'planner2',responseModel:'deepseek-other/deepseek-flash',streamResponse:true}),response=await x.request();
 assert.equal(response.status,502);await response.json();const receipt=x.gateway.receipts()[0];
 assert.equal(receipt.responseModelMatched,false);assert.equal(receipt.observedModel,null);assert.equal(receipt.outcome,'MODEL_GATEWAY_RESPONSE_MODEL_MISMATCH');
});

for(const role of ['planner2','reviewer'])test('Custom '+role+' reserves and grants its own role budget with only its terminal tool and retains UNKNOWN usage',async t=>{
 const x=await setup(t,{role}),response=await x.request();assert.equal(response.status,200);await response.json();const row=x.budget.requests()[0];assert.equal(row.role,role);assert.equal(row.binding.role,role);assert.equal(row.binding.roleId,role);assert.equal(row.binding.work.kind,'SUPERVISION');assert.equal(row.customBudget.roleId,role);assert.equal(row.routerAdmission.status,'ACKNOWLEDGED');assert.equal(row.usageStatus,'UNKNOWN');assert.ok(row.chargedMicros>0);assert.equal(x.writes(),2);assert.equal(x.requests(),1);assert.equal(x.gateway.receipts()[0].minimalResponseVerified,false);
});
for(const role of ['planner2','reviewer'])test('Custom '+role+' rejects an unexpected declared tool before reservation or router issue',async t=>{
 const x=await setup(t,{role,roleToolName:'untrusted_write'}),response=await x.request();assert.equal(response.status,400);assert.equal((await response.json()).error.code,'CUSTOM_SUPERVISION_TOOLSET_INVALID');assert.equal(x.budget.requests().length,0);assert.equal(x.writes(),0);assert.equal(x.requests(),0);
});
for(const role of ['planner2','reviewer'])test('Custom '+role+' receives and forwards its exact terminal tool response',async t=>{
 const x=await setup(t,{role,toolEcho:'terminal'}),response=await x.request(),text=await response.text();assert.equal(response.status,200);assert.match(text,/submit_(?:engineering_plan|review)/);assert.equal(x.gateway.receipts()[0].completionObserved,true);assert.equal(x.gateway.receipts()[0].minimalResponseVerified,false);
});
test('Custom supervisor cannot borrow the other role before reservation or grant',async t=>{
 const x=await setup(t,{role:'planner2',foreignRole:'reviewer'}),response=await x.request();assert.equal(response.status,409);assert.equal(x.budget.requests().length,0);assert.equal(x.writes(),0);assert.equal(x.requests(),0);
});
test('Custom supervisor role cap refuses before reading a key or granting the router',async t=>{
 const x=await setup(t,{role:'reviewer',customBudget:binding=>{const cap=offlineCustomBudget(binding);cap.role.maxMicros=0;return cap;}}),response=await x.request();assert.equal(response.status,409);assert.equal((await response.json()).error.code,'CUSTOM_ROLE_BUDGET_EXCEEDED');assert.equal(x.writes(),0);assert.equal(x.requests(),0);assert.equal(x.budget.requests().length,0);
});
for(const role of ['planner2','reviewer'])test('Custom '+role+' cannot receive or execute a model tool response or promote it to a minimum probe',async t=>{
 const x=await setup(t,{role,toolEcho:'valid'});let received='';
 try{const response=await x.request();received=await response.text();}catch{/* The rejected tool block intentionally closes the stream before release. */}
 assert.equal(received.includes('input_json_delta'),false);assert.equal(x.wire().includes('input_json_delta'),false);assert.equal(x.wire().includes('tool_use'),false);
 const receipt=x.gateway.receipts()[0];assert.equal(receipt.outcome,'CUSTOM_SUPERVISION_TOOL_RESPONSE_DENIED');assert.equal(receipt.completionObserved,false);assert.equal(receipt.minimalResponseVerified,false);assert.equal(x.budget.requests()[0].usageStatus,'UNKNOWN');assert.equal(x.requests(),1);
});
test('chat-completions Custom supervisor rejects model tool calls before parsing their arguments',async t=>{
 const x=await setup(t,{role:'reviewer',wire:'chat-completions',chatToolResponse:true}),response=await x.request();
 assert.equal(response.status,502);assert.equal((await response.json()).error.code,'CUSTOM_SUPERVISION_TOOL_RESPONSE_DENIED');
 const receipt=x.gateway.receipts()[0];assert.equal(receipt.outcome,'CUSTOM_SUPERVISION_TOOL_RESPONSE_DENIED');
 assert.equal(receipt.toolArgumentFailureDetail,null);assert.equal(receipt.completionObserved,false);
 assert.equal(x.budget.requests()[0].usageStatus,'UNKNOWN');assert.equal(x.requests(),1);
});
test('the controller-fixed Custom role cannot be changed after its channel is constructed',async t=>{
 const x=await setup(t,{role:'planner2'});assert.equal(x.channel.role,'planner2');assert.equal(x.channel.responseModel,'deepseek-official/deepseek-flash');assert.throws(()=>{x.channel.role='executor';},TypeError);assert.throws(()=>{x.channel.responseModel='foreign/model';},TypeError);assert.equal(x.budget.requests().length,0);assert.equal(x.writes(),0);
});
test('Classic cannot borrow the Custom channel or reserve a model request',async t=>{
 const x=await setup(t,{mode:'classic'}),response=await x.request();assert.equal(response.status,409);assert.equal((await response.json()).error.code,'CLASSIC_MAGPIE_FORBIDDEN');assert.equal(x.writes(),0);assert.equal(x.requests(),0);assert.equal(x.budget.requests().length,0);
});
test('the original Gateway refuses a Custom role cap before issuing a key, grant or upstream request',async t=>{
 const x=await setup(t,{customBudget:binding=>{const caps=offlineCustomBudget(binding);caps.role.maxMicros=0;return caps;}}),response=await x.request();
 assert.equal(response.status,409);assert.equal((await response.json()).error.code,'CUSTOM_ROLE_BUDGET_EXCEEDED');assert.equal(x.writes(),0);assert.equal(x.requests(),0);assert.equal(x.budget.requests().length,0);
});
test('a known Magpie issuance denial settles the original hold as UNKNOWN without retry or router intent',async t=>{
 const x=await setup(t,{issueDenied:true}),response=await x.request();assert.equal(response.status,502);assert.equal((await response.json()).error.code,'MAGPIE_ISSUANCE_DENIED');
 assert.equal(x.writes(),1);assert.equal(x.requests(),0);assert.equal(x.gateway.receipts().length,1);
 const row=x.budget.requests()[0];assert.equal(row.routerAdmission,undefined);assert.equal(row.usageStatus,'UNKNOWN');assert.equal(row.outcome,'MAGPIE_ISSUANCE_DENIED');assert.equal(row.chargedMicros,row.reservedMicros);
});
for(const [name,options] of [['denied grant',{denied:true}],['stale dispatch after grant',{staleAfterGrant:true}],['disconnected upstream',{disconnect:true}]])test(name+' cannot retry or invent a zero cost',async t=>{
 const x=await setup(t,options),response=await x.request();assert.equal(response.status,502);await response.json();assert.equal(x.writes(),2);assert.equal(x.requests(),options.disconnect?1:0);const row=x.budget.requests()[0];assert.equal(row.usageStatus,'UNKNOWN');assert.equal(row.chargedMicros,row.reservedMicros);assert.ok(row.reservedMicros>0);assert.equal(x.gateway.receipts().length,1);
});
for(const options of [{echoKey:true},{echoToken:true}])test('an issued key or admission token is rejected before it reaches the agent response '+JSON.stringify(options),async t=>{
 const x=await setup(t,options),response=await x.request();assert.equal(response.status,502);const result=await response.text();assert.equal(result.includes('sk-magpie-key-'),false);assert.equal(JSON.parse(result).error.code,'MODEL_GATEWAY_SECRET_IN_RESPONSE');assert.equal(x.requests(),1);assert.equal(x.budget.requests()[0].usageStatus,'UNKNOWN');
});
test('one pending reservation has one exact request object and at most one physical send',async t=>{
 const x=await setup(t),prepared=x.channel.prepare(body()),row=x.budget.reserve('executor',price(),128,undefined,prepared.binding),signal=new AbortController().signal;
 await assert.rejects(x.channel.send({...prepared},row.id,signal),{code:'MAGPIE_MODEL_REQUEST_ALREADY_USED'});assert.equal(x.writes(),0);
 const response=await x.channel.send(prepared,row.id,signal);await response.json();
 await assert.rejects(x.channel.send(prepared,row.id,signal),{code:'MAGPIE_MODEL_REQUEST_ALREADY_USED'});assert.equal(x.requests(),1);assert.equal(x.writes(),2);assert.equal(x.budget.requests()[0].usageStatus,'PENDING');
});
for(const toolEcho of ['split_token','split_key','escaped_token','escaped_key','escaped_duplicate_token','escaped_duplicate_key'])test('assembled tool parameters cannot release '+toolEcho+' to the agent',async t=>{
 const x=await setup(t,{toolEcho});let received='';
 try{const response=await x.request(),reader=response.body.getReader();for(;;){const chunk=await reader.read();if(chunk.done)break;received+=new TextDecoder().decode(chunk.value);}}catch{/* Stream closes on the rejected block; original receipt is authoritative. */}
 assert.equal(received.includes('input_json_delta'),false);assert.equal(received.includes('tool_use'),false);assert.equal(x.gateway.receipts()[0].outcome,'MODEL_GATEWAY_SECRET_IN_RESPONSE');assert.equal(x.budget.requests()[0].usageStatus,'UNKNOWN');assert.equal(x.budget.requests()[0].chargedMicros,x.budget.requests()[0].reservedMicros);assert.equal(x.requests(),1);
});
test('a complete safe tool parameter transcript still reaches the agent unchanged',async t=>{
 const x=await setup(t,{toolEcho:'valid'}),response=await x.request(),text=await response.text();assert.equal(response.status,200);const frames=text.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));
 const args=frames.filter(frame=>frame.type==='content_block_delta').map(frame=>frame.delta.partial_json).join('');assert.deepEqual(JSON.parse(args),{path:'README.md'});assert.equal(frames.at(-1).type,'message_stop');assert.equal(x.gateway.receipts()[0].completionObserved,true);assert.equal(x.requests(),1);
});

for(const role of ['planner2','executor','reviewer'])test('Custom '+role+' minimum probe uses its opaque hold, no tools and original ACK before observing completion',async t=>{
 const x=await setup(t,{probe:true,role}),response=await x.request();assert.equal(response.status,200);await response.json();const row=x.budget.requests()[0],receipt=x.gateway.receipts()[0];
 assert.equal(row.binding.work.kind,'QUALIFICATION');assert.equal(row.customProbe.role,role);assert.equal(row.routerAdmission.status,'ACKNOWLEDGED');assert.equal(row.usageStatus,'UNKNOWN');assert.equal(receipt.minimalResponseVerified,true);assert.equal(receipt.completionObserved,true);assert.ok(x.probeChecks()>=2);assert.equal(x.writes(),2);assert.equal(x.requests(),1);assert.equal(x.budget.summary().phase,'PROBE');
 const again=await x.request();assert.equal(again.status,409);assert.equal(x.budget.requests().length,1);assert.equal(x.requests(),1);
});
test('copied Custom probe permit is refused before hold, issue or send',async t=>{
 const x=await setup(t,{probe:true,role:'reviewer',copiedProbePermit:true}),response=await x.request();assert.equal(response.status,409);assert.equal((await response.json()).error.code,'CUSTOM_PROBE_PERMIT_INVALID');assert.equal(x.budget.requests().length,0);assert.equal(x.requests(),0);assert.equal(x.writes(),0);
});
for(const probeGuard of ['promise','boolean'])test('Custom probe currentness cannot be authorized by a '+probeGuard,async t=>{
 const x=await setup(t,{probe:true,role:'planner2',probeGuard}),response=await x.request();assert.equal(response.status,409);assert.equal((await response.json()).error.code,'CUSTOM_PROBE_CURRENT_RESULT_INVALID');assert.equal(x.budget.requests().length,0);assert.equal(x.requests(),0);assert.equal(x.writes(),0);
});
test('a changed Custom probe context at completion cannot become a qualification receipt',async t=>{
 const x=await setup(t,{probe:true,role:'planner2',probeGuard:'stale'}),response=await x.request();assert.equal(response.status,502);await response.json();assert.equal(x.gateway.receipts()[0].minimalResponseVerified,false);assert.equal(x.gateway.receipts()[0].outcome,'CUSTOM_PROBE_CONTEXT_STALE');assert.equal(x.budget.requests()[0].usageStatus,'UNKNOWN');assert.equal(x.requests(),1);
});
test('even the Custom executor minimum probe rejects a streamed tool response without releasing tool bytes',async t=>{
 const x=await setup(t,{probe:true,role:'executor',toolEcho:'valid'}),response=await x.request();assert.equal(response.status,502);const text=await response.text();assert.equal(JSON.parse(text).error.code,'CUSTOM_PROBE_TOOL_RESPONSE_DENIED');assert.equal(text.includes('tool_use'),false);assert.equal(x.gateway.receipts()[0].minimalResponseVerified,false);assert.equal(x.budget.requests()[0].usageStatus,'UNKNOWN');
});
test('final Custom currentness refusal occurs before any non-streaming response body or success header is released',async t=>{
 const x=await setup(t,{probe:true,role:'reviewer',probeGuard:'late'});try{const response=await x.request();await response.text();}catch{/* The failed handler may close the local socket. */}
 assert.equal(x.wire().includes('offline result'),false);assert.equal(x.statuses.includes(200),false);assert.equal(x.gateway.receipts()[0].minimalResponseVerified,false);assert.equal(x.budget.requests()[0].usageStatus,'UNKNOWN');
});
test('cancellation wins even if a transport ignores abort and returns a full non-streaming response',async t=>{
 const x=await setup(t,{probe:true,role:'reviewer',cancelAtResponse:true});try{const response=await x.request();await response.text();}catch{/* Cancellation intentionally closes the local socket. */}await x.abortClosed();
 assert.equal(x.wire().includes('offline result'),false);assert.equal(x.statuses.includes(200),false);assert.equal(x.gateway.receipts()[0].minimalResponseVerified,false);assert.equal(x.gateway.receipts()[0].outcome,'MODEL_GATEWAY_DISCONNECTED');assert.equal(x.budget.requests()[0].usageStatus,'UNKNOWN');
});
test('Custom probe gateway purpose cannot mix direct keys, repeat allowance, Classic or engineering permits',async t=>{
 const x=await setup(t,{probe:true,role:'executor'}),probe={permit:x.probePermit,assertCurrent:()=>{}},create=(patch={})=>new DeepSeekGateway(x.budget,price,patch.key??'',128,patch.maximum??1,()=>{throw Error('NO_DIRECT_PROVIDER');},patch.wire??'anthropic-messages',true,patch.classic,patch.bind,patch.engineering,patch.noMagpie?undefined:x.channel,probe);
 for(const patch of [{key:'OFFLINE_NOT_A_REAL_KEY'},{maximum:2},{wire:'chat-completions'},{classic:{}},{bind:()=>{}},{engineering:{permit:{},assertCurrent:()=>{}}},{noMagpie:true}])assert.throws(()=>create(patch),{code:'CUSTOM_PROBE_GATEWAY_PURPOSE_INVALID'});
 assert.equal(x.budget.requests().length,0);assert.equal(x.writes(),0);assert.equal(x.requests(),0);
});
