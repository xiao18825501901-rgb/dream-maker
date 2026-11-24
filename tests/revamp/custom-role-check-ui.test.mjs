// OFFLINE protocol fixtures; no accounts or model calls.
import test from 'node:test';import assert from 'node:assert/strict';
import {CustomRoleChecks,readCustomRoleCheck} from '../../dist/web/custom-role-check.js';
const selection={projectId:'p1',specHash:'a'.repeat(64),profileHash:'b'.repeat(64),preparation:{identityHash:'c'.repeat(64),contentHash:'d'.repeat(64)}},configurationHash='e'.repeat(64);
const status=(state='NOT_RUN')=>({schema:'dream-maker.custom-role-check.v1',projectId:'p1',role:'planner2',roleId:'planner2',selection,configurationHash,status:state,checkedAt:state==='NOT_RUN'?null:'2026-11-04T00:01:00.000Z',evidenceId:state==='PASSED_MINIMUM'?'OFFLINE_RECEIPT':null,model:state==='PASSED_MINIMUM'?'deepseek-flash':null,executionGranted:false,fourRoleLive:'NOT_RUN'});
const prepared=()=>({preparation:{schema:'dream-maker.custom-flow-preparation.v1',projectId:'p1',identityHash:selection.preparation.identityHash,contentHash:selection.preparation.contentHash,flowConfigHash:configurationHash,createdAt:'2026-11-04T00:00:00.000Z',scope:'CONFIGURATION_PREPARATION_ONLY',executionGranted:false,flowConfig:{schema:'dream-maker.flow-config.v2',mode:'custom',projectId:'p1',plan:{specHash:selection.specHash},profile:{contentHash:selection.profileHash},qualification:'NOT_VERIFIED'}},executionGranted:false});
function rig(extra={}){const calls=[],drafts=new Map();let current=true;const context={projectId:'p1',specHash:selection.specHash,profileHash:selection.profileHash,current:()=>current};
 const request=async(path,method='GET',body)=>{calls.push({path,method,body});if(extra.request)return extra.request(path,method,body);return path.endsWith('/flow-preparation')?prepared():status();};
 const storage={get:k=>drafts.get(k)??'',set:(k,v)=>(drafts.set(k,v),true),delete:k=>drafts.delete(k),getRequired:k=>drafts.get(k)??'',setRequired:(k,v)=>(drafts.set(k,v),true),deleteRequired:k=>(drafts.delete(k),true),withRequiredLock:async(k,work)=>work()};
 return{checks:new CustomRoleChecks({request},storage),calls,drafts,context,storage,request,close:()=>current=false};}
test('role model request needs a current read and separate consent; reads do not dispatch',async()=>{const x=rig();await assert.rejects(x.checks.probe(x.context,'planner2',true));assert.equal(x.calls.length,0);await x.checks.read(x.context,'planner2');await assert.rejects(x.checks.probe(x.context,'planner2',false));assert.equal(x.calls.filter(c=>c.path.endsWith('/flow-role-probe')).length,0);});
test('lost model response persists frozen refs and cannot be automatically retried after reopening',async()=>{let models=0;const x=rig({request:async(path)=>{if(path.endsWith('/flow-preparation'))return prepared();if(path.endsWith('/flow-role-probe')){models++;throw Error('OFFLINE_LOSS');}return status();}});await x.checks.read(x.context,'planner2');await assert.rejects(x.checks.probe(x.context,'planner2',true));assert.equal(models,1);assert.ok(x.drafts.size>0);
 x.checks=new CustomRoleChecks({request:x.request},x.storage);await x.checks.read(x.context,'planner2');await assert.rejects(x.checks.probe(x.context,'planner2',true));assert.equal(models,1);assert.ok(x.drafts.size>0);
});
test('late preparation after closing never starts a role call or changes retained drafts',async()=>{let release;const pending=new Promise(r=>release=r),x=rig({request:async()=>pending});const work=x.checks.read(x.context,'planner2');x.close();release(prepared());await work;assert.equal(x.calls.length,1);assert.equal(x.drafts.size,0);});
test('public role statuses reject foreign roles, authority escalation, private fields and invalid dates',()=>{assert.deepEqual(readCustomRoleCheck(status(),selection,'planner2',configurationHash),status());assert.deepEqual(readCustomRoleCheck(status('FAILED_NO_EFFECT'),selection,'planner2',configurationHash),status('FAILED_NO_EFFECT'));for(const change of [{projectId:'other'},{roleId:'reviewer'},{executionGranted:true},{fourRoleLive:'PASSED'},{privatePath:'F:/PRIVATE'},{status:'PASSED_MINIMUM',checkedAt:'yesterday',model:'deepseek-flash',evidenceId:'X'}])assert.throws(()=>readCustomRoleCheck({...status(),...change},selection,'planner2',configurationHash));});
test('one confirmed call retains a unique request identity and settles only that original request',async()=>{let submitted;const x=rig({request:async(path,method,body)=>{if(path.endsWith('/flow-preparation'))return prepared();if(path.endsWith('/flow-role-probe')){submitted=body;return{scope:'MINIMUM_ROLE_ONLY',executionGranted:false,fourRoleLive:'NOT_RUN'};}if(body.requestId){assert.equal(body.requestId,submitted.requestId);return status('PASSED_MINIMUM');}return status();}});await x.checks.read(x.context,'planner2');await x.checks.probe(x.context,'planner2',true);assert.match(submitted.requestId,/^[a-f0-9-]{36}$/);assert.equal(submitted.confirmed,true);assert.equal(x.drafts.size,0);assert.equal(x.calls.filter(c=>c.path.endsWith('/flow-role-probe')).length,1);await assert.rejects(x.checks.probe(x.context,'planner2',true));});
test('failure to persist the pending reference prevents any paid request',async()=>{const x=rig();await x.checks.read(x.context,'planner2');x.storage.setRequired=()=>false;await assert.rejects(x.checks.probe(x.context,'planner2',true));assert.equal(x.calls.filter(c=>c.path.endsWith('/flow-role-probe')).length,0);});
test('changed preparation or corrupted retained identity cannot authorize a request or erase records',async()=>{const x=rig();x.drafts.set('custom-role-pending:p1','CORRUPT');await assert.rejects(x.checks.read(x.context,'planner2'));assert.equal(x.calls.length,0);assert.equal(x.drafts.get('custom-role-pending:p1'),'CORRUPT');const y=rig({request:async()=>({...prepared(),executionGranted:true})});await assert.rejects(y.checks.read(y.context,'planner2'));assert.equal(y.calls.length,1);});
test('panel distinguishes an unread role and forbids preselected model-call consent',()=>{const x=rig(),r={id:'planner2',provider:'deepseek-official',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},budget:{maxMicros:1000000,currency:'CNY'}};const html=x.checks.panel(x.context,[r],false);assert.match(html,/最小验证|分别验证/);assert.match(html,/尚未接入/);assert.match(html,/data-action="custom-role-read"/);assert.match(html,/name="roleConsent-planner2"[^>]*disabled/);assert.doesNotMatch(html,/name="roleConsent-planner2"[^>]*checked/);});

test('the unread panel describes mixed supported routes without the old all-DSH restriction',()=>{
 const x=rig(),roles=[
  {id:'planner2',provider:'openai',runtime:'codex',model:{kind:'model',id:'gpt-6-luna'},budget:{maxMicros:1000000,currency:'CNY'}},
  {id:'executor-1',provider:'deepseek-official',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},budget:{maxMicros:1000000,currency:'CNY'}},
  {id:'reviewer',provider:'deepseek-official',runtime:'independent',model:{kind:'model',id:'deepseek-v4-pro'},budget:{maxMicros:1000000,currency:'CNY'}}
 ];
 const html=x.checks.panel(x.context,roles,false);
 assert.doesNotMatch(html,/目前只接入 DeepSeek 官方 API、DSH 和指定 deepseek-flash/);
 assert.match(html,/OpenAI 订阅规划/);
 assert.match(html,/DSH/);
 assert.match(html,/独立 API 审查/);
});
test('retained original request remains readable with a changed unsaved configuration and no dispatch context',async()=>{let submitted;const x=rig({request:async(path,method,body)=>{if(path.endsWith('/flow-preparation'))return prepared();if(path.endsWith('/flow-role-probe')){submitted=body;throw Error('OFFLINE_LOSS');}if(body.requestId){assert.equal(body.requestId,submitted.requestId);assert.equal(body.profileHash,selection.profileHash);return status('PASSED_MINIMUM');}return status();}});await x.checks.read(x.context,'planner2');await assert.rejects(x.checks.probe(x.context,'planner2',true));const html=x.checks.panel(null,[],false,false,'p1');assert.match(html,/data-action="custom-role-recover"/);await x.checks.readPending('p1',()=>true);assert.equal(x.drafts.size,0);assert.equal(x.calls.filter(c=>c.path.endsWith('/flow-role-probe')).length,1);});
test('recovery feedback remains visible independently from eligibility of the new unsaved draft',async()=>{const x=rig({request:async(path,method,body)=>{if(path.endsWith('/flow-preparation'))return prepared();if(path.endsWith('/flow-role-probe'))throw Error('OFFLINE_LOSS');return body.requestId?status('FAILED'):status();}});await x.checks.read(x.context,'planner2');await assert.rejects(x.checks.probe(x.context,'planner2',true));await x.checks.readPending('p1',()=>true);const html=x.checks.panel(null,[],false,false,'p1');assert.match(html,/上次验证失败/);assert.match(html,/原调用|原角色调用/);assert.doesNotMatch(html,/data-action="custom-role-recover"/);});
test('settling one tab cannot delete a different pending identity written before deletion',async()=>{const x=rig({request:async()=>status('PASSED_MINIMUM')}),old={schema:'dream-maker.custom-role-pending.v1',requestId:crypto.randomUUID(),selection,configurationHash,roleId:'planner2'},next={...old,requestId:crypto.randomUUID(),roleId:'reviewer'};x.drafts.set('custom-role-pending:p1',JSON.stringify(old));x.storage.deleteRequired=(key,expected)=>{x.drafts.set(key,JSON.stringify(next));if(expected!==undefined&&x.drafts.get(key)!==expected)return false;x.drafts.delete(key);return true;};await x.checks.readPending('p1',()=>true).catch(()=>{});assert.equal(x.drafts.get('custom-role-pending:p1'),JSON.stringify(next));});
test('closing an old view releases its held operation lock even when transport ignores cancellation',async()=>{const x=rig({request:async(path,method,body)=>path.endsWith('/flow-preparation')?prepared():path.endsWith('/flow-role-probe')?new Promise(()=>{}):body.requestId?status('PASSED_MINIMUM'):status()});assert.equal(typeof x.checks.cancelWait,'function');let locked=false;x.storage.withRequiredLock=async(k,work)=>{assert.equal(locked,false);locked=true;try{return await work();}finally{locked=false;}};await x.checks.read(x.context,'planner2');const waiting=x.checks.probe(x.context,'planner2',true),rejected=assert.rejects(waiting);await Promise.resolve();assert.equal(locked,true);x.checks.cancelWait();await rejected;assert.equal(locked,false);assert.equal(x.drafts.size,1);await x.checks.readPending('p1',()=>true);assert.equal(x.drafts.size,0);assert.equal(x.calls.filter(c=>c.path.endsWith('/flow-role-probe')).length,1);});
test('closing a view settles a hung independent original-request read without losing its reference',async()=>{const x=rig({request:()=>new Promise(()=>{})}),pending={schema:'dream-maker.custom-role-pending.v1',requestId:crypto.randomUUID(),selection,configurationHash,roleId:'planner2'};x.drafts.set('custom-role-pending:p1',JSON.stringify(pending));let settled=false;void x.checks.readPending('p1',()=>true).then(()=>settled=true,()=>settled=true);await Promise.resolve();x.checks.cancelWait();await new Promise(setImmediate);assert.equal(settled,true);assert.equal(x.drafts.get('custom-role-pending:p1'),JSON.stringify(pending));assert.equal(x.calls.filter(c=>c.path.endsWith('/flow-role-probe')).length,0);});
test('closing a view also settles an initial preparation read whose transport never returns',async()=>{const x=rig({request:()=>new Promise(()=>{})});let settled=false;void x.checks.read(x.context,'planner2').then(()=>settled=true,()=>settled=true);await Promise.resolve();x.checks.cancelWait();await new Promise(setImmediate);assert.equal(settled,true);assert.equal(x.calls.length,1);assert.equal(x.drafts.size,0);});
test('two browser actors cannot overwrite an unsettled reference between reading and persisting it',async()=>{let sends=0,armed=false,locked=false,second;const completions=[],x=rig({request:async(path,method,body)=>{if(path.endsWith('/flow-preparation'))return prepared();if(path.endsWith('/flow-role-probe')){sends++;return new Promise(resolve=>completions.push(()=>resolve({scope:'MINIMUM_ROLE_ONLY',executionGranted:false,fourRoleLive:'NOT_RUN'})));}return body.requestId?status('PASSED_MINIMUM'):status();}}),other=new CustomRoleChecks({request:x.request},x.storage);await x.checks.read(x.context,'planner2');await other.read(x.context,'planner2');
 const required=new Map();x.storage.setRequired=(k,v)=>(required.set(k,v),true);x.storage.deleteRequired=k=>(required.delete(k),true);
 x.storage.withRequiredLock=async(k,work)=>{if(locked)throw Error('OFFLINE_LOCK_BUSY');locked=true;try{return await work();}finally{locked=false;}};
 x.storage.getRequired=k=>{const before=required.get(k)??'';if(armed){armed=false;second=other.probe(x.context,'planner2',true).catch(()=>{});}return before;};armed=true;const first=x.checks.probe(x.context,'planner2',true);await Promise.resolve();
 try{assert.equal(sends,1,'shared storage alone is not an atomic operation reservation');}finally{for(const complete of completions)complete();await Promise.allSettled([first,second]);}
});

test('a controller-proven no-effect failure requires a fresh explicit confirmation before one new call',async()=>{
 let submitted=[],failed=false;
 const x=rig({request:async(path,method,body)=>{
  if(path.endsWith('/flow-preparation'))return prepared();
  if(path.endsWith('/flow-role-probe')){
   submitted.push(body);
   if(submitted.length===1){failed=true;throw Error('OFFLINE_PRE_MODEL_REFUSAL');}
   return{scope:'MINIMUM_ROLE_ONLY',executionGranted:false,fourRoleLive:'NOT_RUN'};
  }
  if(body.requestId)return status('PASSED_MINIMUM');
  return status(failed?'FAILED_NO_EFFECT':'NOT_RUN');
 }});
 await x.checks.read(x.context,'planner2');
 await assert.rejects(x.checks.probe(x.context,'planner2',true));
 await x.checks.readPending('p1',()=>true);
 const role={id:'planner2',provider:'deepseek-official',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},budget:{maxMicros:1000000,currency:'CNY'}};
 await x.checks.read(x.context,'planner2');
 await assert.rejects(x.checks.probe(x.context,'planner2',false));
 assert.equal(submitted.length,1);
 await x.checks.probe(x.context,'planner2',true);
 assert.equal(submitted.length,2);
 assert.notEqual(submitted[1].requestId,submitted[0].requestId);
 assert.equal(x.drafts.size,0);
});

test('a no-effect failure is visible in plain Chinese and enables exactly the explicit retry control',async()=>{
 const x=rig({request:async(path,method,body)=>{
  if(path.endsWith('/flow-preparation'))return prepared();
  if(path.endsWith('/flow-role-probe'))throw Error('OFFLINE_PRE_MODEL_REFUSAL');
  return body.requestId?status('FAILED_NO_EFFECT'):status();
 }});
 await x.checks.read(x.context,'planner2');
 await assert.rejects(x.checks.probe(x.context,'planner2',true));
 await x.checks.readPending('p1',()=>true);
 const role={id:'planner2',provider:'deepseek-official',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},budget:{maxMicros:1000000,currency:'CNY'}};
 const html=x.checks.panel(x.context,[role],true);
 assert.match(html,/没有发出模型请求/);
 assert.match(html,/可以重新确认一次/);
 assert.match(html,/data-role-allowed="true"/);
 assert.match(html,/data-action="custom-role-probe" data-role-id="planner2"[^>]*>验证工程规划助手/);
});

test('an ordinary failed probe has no retry control',async()=>{
 const x=rig({request:async(path,method,body)=>{
  if(path.endsWith('/flow-preparation'))return prepared();
  if(path.endsWith('/flow-role-probe'))throw Error('OFFLINE_EFFECT_UNKNOWN');
  return body.requestId?status('FAILED'):status();
 }});
 await x.checks.read(x.context,'planner2');
 await assert.rejects(x.checks.probe(x.context,'planner2',true));
 await x.checks.readPending('p1',()=>true);
 const role={id:'planner2',provider:'deepseek-official',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},budget:{maxMicros:1000000,currency:'CNY'}};
 const html=x.checks.panel(x.context,[role],true);
 assert.match(html,/上次验证失败/);
 assert.match(html,/data-role-allowed="false"/);
});

test('a stale qualification explains that account or runtime evidence must be rechecked',async()=>{
 const x=rig({request:async(path)=>path.endsWith('/flow-preparation')?prepared():status('NOT_CURRENT')});
 await x.checks.read(x.context,'planner2');
 const role={id:'planner2',provider:'deepseek-official',runtime:'dsh',model:{kind:'model',id:'deepseek-flash'},budget:{maxMicros:1000000,currency:'CNY'}};
 const html=x.checks.panel(x.context,[role],true);
 assert.match(html,/账户来源、模型或运行环境有变化/);
 assert.match(html,/旧验证已失效/);
 assert.match(html,/没有重新调用模型/);
 assert.match(html,/data-role-allowed="false"/);
});
