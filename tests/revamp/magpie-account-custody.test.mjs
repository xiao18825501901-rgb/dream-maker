// OFFLINE capability boundary. Synthetic values and a syntactically valid frozen snapshot;
// NativeOwner/Store integration has separate tests. No account/model or process qualification.
import test from 'node:test';import assert from 'node:assert/strict';
import {hash} from '../../dist/server/security.js';
const key='UNMARKED_SYNTHETIC_CUSTODY_VALUE_NOT_REAL';
function snapshot(){
 const role=(id,write=false)=>({id,provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},transport:'magpie',nativeException:false,permissions:write?['source_read','source_write']:['source_read'],budget:{currency:'CNY',maxMicros:1000000}});
 return{schema:'dream-maker.flow-config.v2',mode:'custom',projectId:'project_offline',runId:'run_offline',plan:{versionId:'spec_offline',revision:1,contentHash:'a'.repeat(64),specHash:'b'.repeat(64)},profile:{revision:1,contentHash:'c'.repeat(64)},accounts:[{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE'}],roles:{planner2:role('planner2'),executors:[role('worker-one',true)],reviewer:role('reviewer')},groups:[],privacy:{deniedProviders:[],deniedDataLabels:[]},budget:{currency:'CNY',maxMicros:2000000},timeZone:'Asia/Shanghai',laya:{enabled:false,mode:'off',roles:[]},magpie:{ownership:'DM_ONLY',routing:'MODELS_ONLY'},qualification:'NOT_VERIFIED',configurationFingerprint:'d'.repeat(64)};
}
async function rig(options={}){
 const api=await import('../../dist/server/magpie-account-custody.js'),frozen=snapshot(),binding={flowConfigHash:hash(frozen),sourceBindingHash:'e'.repeat(64)},reads=[];let current={...binding};
 const input={snapshot:frozen,binding,sources:[{provider:'deepseek-official',authentication:'api_key',authRef:'AUTH_ONE',accountRef:'ACCOUNT_ONE',secretEnv:'DEEPSEEK_API_KEY'}],dshKeyEnv:'DEEPSEEK_API_KEY',getSecret:name=>{reads.push(name);return key;},assertCurrent:()=>current,...options};
 const issue=()=>api.createMagpieAccountCustody(input);return{api,input,binding,reads,issue,change:()=>current={...binding,sourceBindingHash:'f'.repeat(64)}};
}
test('string reviewer consumes its frozen Messages endpoint and model list once',async()=>{
 const x=await rig(),a={provider:'string',authentication:'api_key',authRef:'STRING_TEST',accountRef:'STRING_ONE'};
 const endpoint={protocol:'anthropic-messages',baseUrl:'https://string.example.test/anthropic'};
 x.input.snapshot.accounts.push(a);
 Object.assign(x.input.snapshot.roles.reviewer,a,{runtime:'claude',model:{kind:'model',id:'claude-sonnet-5'}});
 x.input.sources.push({...a,secretEnv:'DM_CUSTOM_STRING_API_KEY',models:['claude-sonnet-5'],endpoint});
 x.input.binding.flowConfigHash=hash(x.input.snapshot);
 x.input.assertCurrent=()=>x.input.binding;
 x.input.getSecret=name=>key+name;
 const ticket=x.issue();
 const held=x.api.consumeMagpieAccountCustody(ticket,x.input.binding).find(account=>account.provider==='string');
 assert.deepEqual(held.endpoint,endpoint);assert.deepEqual(held.models,['claude-sonnet-5']);
 assert.throws(()=>x.api.consumeMagpieAccountCustody(ticket,x.input.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_INVALID'});
});

test('Claude custody uses the exact account and prefers its Messages capability before checking translated builds',async()=>{
 const x=await rig(),vendor={provider:'vendor-one',authentication:'api_key'},model='org/Exact';
 const first={...vendor,authRef:'FIRST_VENDOR',accountRef:'FIRST_ACCOUNT'},selected={...vendor,authRef:'SECOND_VENDOR',accountRef:'SECOND_ACCOUNT'};
 const cap=(protocol,path)=>({model,protocol,endpoint:'https://vendor.example.test/v1/'+path});
 const chat=cap('chat-completions','chat/completions'),messages=cap('anthropic-messages','messages'),responses=cap('openai-responses','responses');
 const source={...selected,secretEnv:'DM_CUSTOM_SECOND_API_KEY',capabilities:[responses]};
 x.input.snapshot.accounts.push(first,selected);
 x.input.sources.push({...first,secretEnv:'DM_CUSTOM_FIRST_API_KEY',capabilities:[messages]},source);
 let checks=0;x.input.bridgeCandidateHash=()=>{checks++;return '78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6';};
 for(const role of ['planner2','reviewer']){
  const previous=x.input.snapshot.roles[role];x.input.snapshot.roles[role]={...previous,...selected,runtime:'claude',model:{kind:'model',id:model}};
  x.input.binding.flowConfigHash=hash(x.input.snapshot);
  for(const caps of [[responses],[chat],[responses,chat,{...messages,model:'org/exact'}]]){
   source.capabilities=caps;assert.throws(x.issue,{code:'MAGPIE_ACCOUNT_MODEL_UNSUPPORTED'});
  }
  for(const caps of [[chat,messages,responses],[responses,chat,messages]]){
   source.capabilities=caps;x.api.revokeMagpieAccountCustody(x.issue());
  }
  x.input.snapshot.roles[role]=previous;
 }
 assert.equal(checks,6);assert.deepEqual(x.reads,[]);
});

test('the read-only CLI build cannot release Pi executor credentials for either native tool wire',async()=>{
 const x=await rig(),account={provider:'vendor-one',authentication:'api_key',authRef:'AUTH_VENDOR',accountRef:'ACCOUNT_VENDOR'},model='org/Pi';
 x.input.snapshot.accounts.push(account);
 Object.assign(x.input.snapshot.roles.executors[0],account,{runtime:'pi',model:{kind:'model',id:model}});
 const source={...account,secretEnv:'DM_CUSTOM_VENDOR_API_KEY',capabilities:[]};x.input.sources.push(source);
 x.input.binding.flowConfigHash=hash(x.input.snapshot);
 let checks=0;x.input.bridgeCandidateHash=()=>{checks++;return '78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6';};
 for(const [protocol,path] of [['openai-responses','responses'],['anthropic-messages','messages']]){
  source.capabilities=[{model,protocol,endpoint:'https://vendor.example.test/v1/'+path}];
  assert.throws(x.issue,{code:'MAGPIE_ACCOUNT_MODEL_UNSUPPORTED'});
 }
 assert.equal(checks,2);assert.deepEqual(x.reads,[]);
});

test('only an exact translated selection consults the binary pin before any credential read',async()=>{
 const x=await rig();let checks=0;
 const account={provider:'vendor-one',authentication:'api_key',authRef:'AUTH_VENDOR',accountRef:'ACCOUNT_VENDOR'};
 const model='org/model';
 x.input.snapshot.accounts.push(account);
 Object.assign(x.input.snapshot.roles.planner2,account,{runtime:'cline',model:{kind:'model',id:model}});
 const cap={model,protocol:'openai-responses',endpoint:'https://vendor.example.test/v1/responses'};
 x.input.sources.push({...account,secretEnv:'DM_CUSTOM_VENDOR_API_KEY',capabilities:[cap]});
 x.input.binding.flowConfigHash=hash(x.input.snapshot);
 x.input.bridgeCandidateHash=()=>{checks++;return '0'.repeat(64);};
 assert.throws(x.issue,{code:'MAGPIE_ACCOUNT_MODEL_UNSUPPORTED'});assert.equal(checks,1);
 cap.model='other';assert.throws(x.issue,{code:'MAGPIE_ACCOUNT_MODEL_UNSUPPORTED'});assert.equal(checks,1);
 Object.assign(cap,{model,protocol:'chat-completions',endpoint:'https://vendor.example.test/v1/chat/completions'});
 x.api.revokeMagpieAccountCustody(x.issue());assert.equal(checks,1);assert.deepEqual(x.reads,[]);
 Object.assign(cap,{protocol:'openai-responses',endpoint:'https://vendor.example.test/v1/responses'});
 const reviewed='78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6';x.input.bridgeCandidateHash=()=>reviewed;
 x.input.assertCurrent=()=>x.input.binding;
 for(const wrong of [undefined,'0'.repeat(64)]){
  const ticket=x.issue();assert.throws(()=>x.api.consumeMagpieAccountCustody(ticket,x.input.binding,wrong),{code:'MAGPIE_ACCOUNT_CUSTODY_STALE'});
  assert.equal(x.api.magpieAccountCustodyPending(ticket),false);assert.deepEqual(x.reads,[]);
 }
 x.input.getSecret=name=>{x.reads.push(name);return key+name;};
 const held=x.api.consumeMagpieAccountCustody(x.issue(),x.input.binding,reviewed);
 assert.equal(held.find(a=>a.accountRef===account.accountRef).capabilities[0].model,model);
 assert.deepEqual(x.reads,['DEEPSEEK_API_KEY','DM_CUSTOM_VENDOR_API_KEY']);for(const a of held)a.key='';
});

test('a custody is opaque, reads only on consumption, and cannot be reused',async()=>{
 const x=await rig(),ticket=x.issue();assert.deepEqual(x.reads,[]);assert.equal(JSON.stringify(ticket),'{}');assert.deepEqual(Reflect.ownKeys(ticket),[]);assert.equal(Object.isFrozen(ticket),true);
 const accounts=x.api.consumeMagpieAccountCustody(ticket,x.binding);assert.deepEqual(x.reads,['DEEPSEEK_API_KEY']);assert.equal(accounts.length,1);assert.equal(accounts[0].key,key);assert.equal(accounts[0].authRef,'AUTH_ONE');assert.throws(()=>x.api.consumeMagpieAccountCustody(ticket,x.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_INVALID'});
 accounts[0].key='';
});
test('JSON, clone, proxy and accessors cannot forge a controller custody',async()=>{
 const x=await rig(),ticket=x.issue();for(const fake of [{},JSON.parse(JSON.stringify(ticket)),structuredClone(ticket),new Proxy(ticket,{})])assert.throws(()=>x.api.consumeMagpieAccountCustody(fake,x.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_INVALID'});
 const accessor={...x.binding};let invoked=0;Object.defineProperty(accessor,'flowConfigHash',{enumerable:true,get(){invoked++;return x.binding.flowConfigHash;}});assert.throws(()=>x.api.consumeMagpieAccountCustody(ticket,accessor));assert.equal(invoked,0);assert.deepEqual(x.reads,[]);
 x.api.revokeMagpieAccountCustody(ticket);
});
test('drift or a foreign binding refuses before reading and retires the original ticket',async()=>{
 const x=await rig(),ticket=x.issue();x.change();assert.throws(()=>x.api.consumeMagpieAccountCustody(ticket,x.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_STALE'});assert.deepEqual(x.reads,[]);assert.throws(()=>x.api.consumeMagpieAccountCustody(ticket,x.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_INVALID'});
 const y=await rig(),other=y.issue();assert.throws(()=>y.api.consumeMagpieAccountCustody(other,{...y.binding,sourceBindingHash:'0'.repeat(64)}),{code:'MAGPIE_ACCOUNT_CUSTODY_STALE'});assert.deepEqual(y.reads,[]);
});
test('the source is rechecked after credential resolution and failures reveal no thrown text',async()=>{
 const x=await rig();x.input.getSecret=name=>{x.reads.push(name);x.change();return key;};const ticket=x.issue();assert.throws(()=>x.api.consumeMagpieAccountCustody(ticket,x.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_STALE'});assert.deepEqual(x.reads,['DEEPSEEK_API_KEY']);
 const y=await rig({getSecret:()=>{throw Error(key);}}),bad=y.issue();assert.throws(()=>y.api.consumeMagpieAccountCustody(bad,y.binding),e=>e.code==='MAGPIE_ACCOUNT_SOURCE_UNAVAILABLE'&&!e.message.includes(key));
 const z=await rig({getSecret:()=>undefined}),missing=z.issue();assert.throws(()=>z.api.consumeMagpieAccountCustody(missing,z.binding),{code:'MAGPIE_ACCOUNT_SECRET_INVALID'});
});
test('revocation, cancellation and expiry make the ticket unusable without reading a value',async()=>{
 const c=new AbortController(),x=await rig({signal:c.signal}),ticket=x.issue();c.abort();assert.throws(()=>x.api.consumeMagpieAccountCustody(ticket,x.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_INVALID'});assert.deepEqual(x.reads,[]);
 const y=await rig({maxAgeMs:20}),expired=y.issue();await new Promise(r=>setTimeout(r,35));assert.throws(()=>y.api.consumeMagpieAccountCustody(expired,y.binding),{code:'MAGPIE_ACCOUNT_CUSTODY_INVALID'});assert.deepEqual(y.reads,[]);
 const z=await rig(),revoked=z.issue();z.api.revokeMagpieAccountCustody(revoked);z.api.revokeMagpieAccountCustody(revoked);assert.throws(()=>z.api.consumeMagpieAccountCustody(revoked,z.binding));
});
test('unsupported identities, models or duplicate sources refuse before credential access',async()=>{
 for(const change of [x=>x.input.snapshot.roles.planner2.runtime='copilot-sdk',x=>x.input.snapshot.roles.reviewer.model.id='not-the-supported-model',x=>x.input.sources.push({...x.input.sources[0],authRef:'OTHER',accountRef:'OTHER_ACCOUNT'}),x=>x.input.sources[0].secretEnv='PATH']){
  const x=await rig();change(x);x.input.binding.flowConfigHash=hash(x.input.snapshot);assert.throws(x.issue);assert.deepEqual(x.reads,[]);
 }
});
test('caller mutations cannot replace frozen source references after issue',async()=>{
 const x=await rig(),ticket=x.issue();x.input.sources[0].secretEnv='PATH';x.input.snapshot.roles.planner2.authRef='ATTACKER';const result=x.api.consumeMagpieAccountCustody(ticket,x.binding);assert.deepEqual(x.reads,['DEEPSEEK_API_KEY']);assert.equal(result[0].authRef,'AUTH_ONE');result[0].key='';
});
const messages={model:'deepseek-flash',protocol:'anthropic-messages',endpoint:'https://api.deepseek.com/anthropic/v1/messages'};
test('explicit source metadata is validated in full before reading credentials',async()=>{
 const {resolveCustomAccountSources}=await import('../../dist/server/custom-account-sources.js');
 const x=await rig(),source={...x.input.sources[0],capabilities:[messages]};
 const parse=(accounts,version='v2')=>resolveCustomAccountSources(x.input.snapshot,{schema:'dream-maker.custom-account-sources.'+version,accounts},x.input.dshKeyEnv);
 assert.deepEqual(parse([source]),[source]);assert.throws(()=>parse([source],'v1'));assert.throws(()=>parse(x.input.sources));
 const merge=registered=>resolveCustomAccountSources(x.input.snapshot,{schema:'dream-maker.custom-account-sources.v2',accounts:[source]},x.input.dshKeyEnv,{accounts:[registered],contentHash:'f'.repeat(64)});
 assert.deepEqual(merge(x.input.sources[0]),[source]);
 assert.throws(()=>merge({...x.input.sources[0],authRef:'OTHER_REF',accountRef:'OTHER_ACCOUNT'}),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});
 const other={...source,provider:'gateway',secretEnv:'DM_CUSTOM_GATEWAY_API_KEY',authRef:'AUTH_OTHER',accountRef:'ACCOUNT_OTHER'};
 for(const patch of [{authRef:source.authRef},{accountRef:source.accountRef},{secretEnv:source.secretEnv},{secretEnv:'PATH'},{model:'extra'},{models:['extra']},{endpoint:{}},{capabilities:[]},{capabilities:[messages,messages]}])assert.throws(()=>parse([source,{...other,...patch}]),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});
 for(const patch of [{protocol:'x'},{protocol:'chat-completions'},{endpoint:'http://a.example.test/v1/messages'},{endpoint:'https://127.0.0.1/v1/messages'},{endpoint:'https://a.localhost/v1/messages'},{endpoint:'https://user@a.example.test/v1/messages'},{endpoint:'https://a.example.test/v1/messages?token=x'},{endpoint:'https://a.example.test/v1/../messages'},{model:'bad://model'}])assert.throws(()=>parse([source,{...other,capabilities:[{...messages,...patch}]}]),{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});
 assert.throws(()=>parse([{...source,capabilities:[{...messages,endpoint:'https://other.example.test/v1/messages'}]}]));
 assert.throws(()=>parse([{...source,capabilities:[{model:messages.model,protocol:'openai-responses',endpoint:'https://api.deepseek.com/v1/responses'}]}]));
 let invoked=false;const accessor=[];Object.defineProperty(accessor,0,{enumerable:true,get(){invoked=true;return messages;}});
 assert.throws(()=>parse([{...source,capabilities:accessor}]));assert.equal(invoked,false);assert.deepEqual(x.reads,[]);
});
test('custody checks the frozen role wire before reads and retains an independent capability copy',async()=>{
 const x=await rig(),source=x.input.sources[0];
 source.capabilities=[{...messages,protocol:'chat-completions',endpoint:'https://api.deepseek.com/v1/chat/completions'}];
 assert.throws(x.issue,{code:'MAGPIE_ACCOUNT_MODEL_UNSUPPORTED'});assert.deepEqual(x.reads,[]);
 source.capabilities=[{...messages}];const ticket=x.issue();source.capabilities[0].model='other';
 const held=x.api.consumeMagpieAccountCustody(ticket,x.binding);assert.deepEqual(held[0].capabilities,[messages]);assert.deepEqual(x.reads,[source.secretEnv]);held[0].key='';
});
test('one provider serving the same model as another must still use the frozen role credential',async()=>{
 const x=await rig(),planner={provider:'gateway-a',authentication:'api_key',authRef:'PAID_PLANNER',accountRef:'PLANNER_ACCOUNT'};
 const reviewer={...planner,provider:'gateway-b',authRef:'PAID_REVIEWER',accountRef:'REVIEWER_ACCOUNT'};
 const config=x.input.snapshot;config.accounts.push(planner,reviewer);
 Object.assign(config.roles.planner2,planner,{runtime:'codex',model:{kind:'model',id:'shared'}});
 Object.assign(config.roles.reviewer,reviewer,{runtime:'claude',model:{kind:'model',id:'shared'}});
 x.input.sources[0].capabilities=[messages];
 const paid={model:'shared',protocol:'openai-responses',endpoint:'https://a.example.test/v1/responses'};
 const review={model:'shared',protocol:'anthropic-messages',endpoint:'https://b.example.test/v1/messages'};
 x.input.sources.push({...planner,secretEnv:'DM_CUSTOM_A_API_KEY',capabilities:[paid]},{...reviewer,secretEnv:'DM_CUSTOM_B_API_KEY',capabilities:[review]});
 x.input.binding.flowConfigHash=hash(config);x.input.assertCurrent=()=>x.input.binding;
 x.input.getSecret=name=>{x.reads.push(name);return key+'_'+name;};
 const {observeCustomAccountSources}=await import('../../dist/server/custom-account-sources.js');
 const view=observeCustomAccountSources(config,{schema:'dream-maker.custom-account-sources.v2',accounts:x.input.sources},null,x.input.dshKeyEnv,x.input.getSecret);
 assert.deepEqual(view.accounts.map(a=>a.status),Array(3).fill('AVAILABLE_UNVERIFIED'));
 assert.doesNotMatch(JSON.stringify(view),/example[.]test|DM_CUSTOM_|UNMARKED_SYNTHETIC/);x.reads.length=0;
 const ticket=x.issue();assert.deepEqual(x.reads,[]);
 const held=x.api.consumeMagpieAccountCustody(ticket,x.input.binding);assert.deepEqual(held.map(h=>[h.authRef,h.capabilities]),[['AUTH_ONE',[messages]],[planner.authRef,[paid]],[reviewer.authRef,[review]]]);
 for(const h of held)h.key='';x.reads.length=0;
 // The planner2 leg is Codex on model "shared"; the reviewer's Messages capability is for another
 // model, so this frozen model has no declared wire at all and custody refuses before any read.
 x.input.sources[1].capabilities=[{...review,model:'other-model'}];assert.throws(x.issue,{code:'MAGPIE_ACCOUNT_MODEL_UNSUPPORTED'});assert.deepEqual(x.reads,[]);
});
test('an eleven-provider manifest with 17 pairs reads only the one frozen key',async()=>{
 const x=await rig(),{resolveCustomAccountSources}=await import('../../dist/server/custom-account-sources.js');
 const many=n=>Array.from({length:n},(_,i)=>({...messages,model:i?'model-'+i:messages.model}));
 const accounts=Array.from({length:11},(_,i)=>i?{provider:'provider-'+i,authentication:'api_key',authRef:'AUTH_'+i,accountRef:'ACCOUNT_'+i,secretEnv:'DM_CUSTOM_PROVIDER_'+i+'_API_KEY',capabilities:many(17)}:{...x.input.sources[0],capabilities:many(17)});
 const parse=()=>resolveCustomAccountSources(x.input.snapshot,{schema:'dream-maker.custom-account-sources.v2',accounts},x.input.dshKeyEnv);
 x.input.sources=parse();assert.equal(x.input.sources.length,11);
 const ticket=x.issue(),held=x.api.consumeMagpieAccountCustody(ticket,x.binding);assert.equal(held.length,1);assert.deepEqual(held[0].capabilities,many(17));assert.deepEqual(x.reads,['DEEPSEEK_API_KEY']);held[0].key='';
 accounts[10].capabilities=many(64);assert.equal(parse()[10].capabilities.length,64);
 accounts[10].capabilities=many(65);assert.throws(parse,{code:'CUSTOM_ACCOUNT_SOURCES_INVALID'});
});
