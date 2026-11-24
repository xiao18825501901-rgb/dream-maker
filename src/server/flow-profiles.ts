import type {CustomFlowProfile,CustomRoleProfile,ProfileBudget,FlowProfileVersion} from '../shared/flow-profile.js';
import type {Store} from './store.js';
import type {DatabaseSync} from 'node:sqlite';
import {DomainError,hash,hasSecret,object,integer,choose,now} from './security.js';
import {canReviseAfterFlow} from './flow/conclusion.js';
function fail(code='FLOW_PROFILE_INPUT_INVALID'):never {throw new DomainError(code,400);}
function requireExplicitGroupMembers(configuration:CustomFlowProfile):void {
 const roles=[configuration.roles.planner2,...configuration.roles.executors,configuration.roles.reviewer];
 if(roles.some(role=>role.model.kind==='group'&&!role.selectedMemberId))fail('FLOW_PROFILE_GROUP_SCOPE_INVALID');
}
function fields(raw:unknown,keys:string[],optional:string[]=[]){const value=object(raw);if(keys.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!keys.includes(key)&&!optional.includes(key)))fail();return value;}
function ref(raw:unknown,model=false):string {
 if(typeof raw!=='string'||!(model?/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/:/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/).test(raw)
  ||raw.includes('://')||hasSecret(raw)||/^(?:Bearer|gh[opusr]_|github_pat_|eyJ)/i.test(raw))fail();return raw;
}
function list(raw:unknown,max:number,parse:(v:unknown)=>string):string[]{
 if(!Array.isArray(raw)||raw.length>max)fail();const result=raw.map(parse);if(new Set(result).size!==result.length)fail();return result;
}
const permissions=(v:unknown)=>list(v,2,x=>choose(x,['source_read','source_write']));
function budget(raw:unknown):ProfileBudget {const value=fields(raw,['currency','maxMicros']);return {currency:choose(value.currency,['CNY','USD']),maxMicros:integer(value.maxMicros,0,1000000000000)};}
function binding(raw:unknown):CustomRoleProfile {
 const value=fields(raw,['id','provider','authentication','authRef','accountRef','runtime','model','transport','nativeException','permissions','budget'],['selectedMemberId']);
 const model=fields(value.model,['kind','id']);if(typeof value.nativeException!=='boolean')fail();
 const selectedMemberId=value.selectedMemberId===undefined?undefined:ref(value.selectedMemberId);
 const result:CustomRoleProfile={id:ref(value.id),provider:ref(value.provider),authentication:choose(value.authentication,['oauth','api_key']),authRef:ref(value.authRef),accountRef:ref(value.accountRef),
  runtime:ref(value.runtime),model:{kind:choose(model.kind,['model','group']),id:ref(model.id,model.kind==='model')},transport:choose(value.transport,['magpie','native']),nativeException:value.nativeException,
  ...(selectedMemberId===undefined?{}:{selectedMemberId}),
  permissions:permissions(value.permissions) as CustomRoleProfile['permissions'],budget:budget(value.budget)};
 if(result.model.kind==='model'&&result.selectedMemberId!==undefined)fail('FLOW_PROFILE_GROUP_SCOPE_INVALID');
 if(result.transport==='native'&&(!result.nativeException||result.model.kind!=='model'))fail('FLOW_PROFILE_NATIVE_EXCEPTION_REQUIRED');
 if(!result.permissions.includes('source_read'))fail();return result;
}
/** Bounded strict input. Unknown proof/endpoint/credential/command fields are rejected. */
export function customFlowProfile(raw:unknown):CustomFlowProfile {
 const v=fields(raw,['mode','laya','accounts','roles','groups','privacy','budget','timeZone']);
 if(v.mode!=='custom'||v.laya!==false)fail('CUSTOM_LAYA_FORBIDDEN');
 const roles=fields(v.roles,['planner2','executors','reviewer']);
 if(!Array.isArray(roles.executors)||roles.executors.length<1||roles.executors.length>64)fail();
 const planner2=binding(roles.planner2),reviewer=binding(roles.reviewer),executors=roles.executors.map(binding),all=[planner2,...executors,reviewer];
 if(planner2.id!=='planner2'||reviewer.id!=='reviewer'||new Set(all.map(r=>r.id)).size!==all.length
  ||planner2.permissions.includes('source_write')||reviewer.permissions.includes('source_write'))fail('FLOW_PROFILE_ROLE_PERMISSIONS_INVALID');
 const privacy=fields(v.privacy,['deniedProviders','deniedDataLabels']),deniedProviders=list(privacy.deniedProviders,64,x=>ref(x)),deniedDataLabels=list(privacy.deniedDataLabels,64,x=>ref(x));
 const cap=budget(v.budget);if(all.some(role=>role.budget.currency!==cap.currency||role.budget.maxMicros>cap.maxMicros))fail('FLOW_PROFILE_BUDGET_SCOPE_INVALID');
 if(!Array.isArray(v.accounts)||v.accounts.length<1||v.accounts.length>128)fail();
 const accounts:CustomFlowProfile['accounts']=v.accounts.map(raw=>{
  const a=fields(raw,['provider','authentication','authRef','accountRef'],['label']);
  if(a.label!==undefined&&(typeof a.label!=='string'||!a.label.trim()||a.label.length>60||/[\x00-\x1f\x7f]/.test(a.label)||hasSecret(a.label)||/\b(?:gh[opusr]_|github_pat_|Bearer\s|eyJ[A-Za-z0-9_-]+\.)/.test(a.label)))fail();
  return {provider:ref(a.provider),authentication:choose(a.authentication,['oauth','api_key']),authRef:ref(a.authRef),accountRef:ref(a.accountRef),...(a.label===undefined?{}:{label:a.label as string})};
 });
 if(new Set(accounts.map(a=>a.authRef)).size!==accounts.length)fail('FLOW_PROFILE_ACCOUNT_SCOPE_INVALID');
 if(all.some(r=>!accounts.some(a=>a.provider===r.provider&&a.accountRef===r.accountRef&&a.authRef===r.authRef&&a.authentication===r.authentication)))fail('FLOW_PROFILE_ACCOUNT_SCOPE_INVALID');
 if(typeof v.timeZone!=='string'||v.timeZone.length>80)fail();try{new Intl.DateTimeFormat('en',{timeZone:v.timeZone});}catch{fail();}
 if(!Array.isArray(v.groups)||v.groups.length>16)fail();
 const groups:CustomFlowProfile['groups']=v.groups.map(raw=>{
  const g=fields(raw,['id','strategy','members']);if(!Array.isArray(g.members)||g.members.length<1||g.members.length>24)fail();
  const members=g.members.map(raw=>{const m=fields(raw,['id','provider','model','authRef','accountRef','permissions']);return {id:ref(m.id),provider:ref(m.provider),model:ref(m.model,true),authRef:ref(m.authRef),accountRef:ref(m.accountRef),permissions:permissions(m.permissions) as CustomRoleProfile['permissions']};});
  if(new Set(members.map(m=>m.id)).size!==members.length)fail();
  return {id:ref(g.id),strategy:choose(g.strategy,['failure_only','rotate','cost','smart']),members};
 });
 if(new Set(groups.map(g=>g.id)).size!==groups.length)fail();
 for(const role of all){
  if(deniedProviders.includes(role.provider))fail('FLOW_PROFILE_PRIVACY_DENIED');
  if(role.model.kind==='group'){
   const group=groups.find(g=>g.id===role.model.id);if(!group||role.transport!=='magpie')fail('FLOW_PROFILE_GROUP_SCOPE_INVALID');
   if(role.selectedMemberId!==undefined&&!group.members.some(m=>m.id===role.selectedMemberId))fail('FLOW_PROFILE_GROUP_SCOPE_INVALID');
   if(group.members.some(m=>!accounts.some(a=>a.authRef===m.authRef&&a.accountRef===m.accountRef&&a.provider===m.provider)||m.permissions.some(p=>!role.permissions.includes(p))))fail('FLOW_PROFILE_GROUP_SCOPE_INVALID');
  }
 }
 // Even an unused group cannot smuggle another account/provider into this frozen profile.
 if(groups.some(g=>!all.some(r=>r.model.kind==='group'&&r.model.id===g.id)||g.members.some(m=>deniedProviders.includes(m.provider))))fail('FLOW_PROFILE_GROUP_SCOPE_INVALID');
 const result:CustomFlowProfile={mode:'custom',laya:false,accounts,roles:{planner2,executors,reviewer},groups,privacy:{deniedProviders,deniedDataLabels},budget:cap,timeZone:v.timeZone};
 if(Buffer.byteLength(JSON.stringify(result))>100000)fail('FLOW_PROFILE_TOO_LARGE');return result;
}

/** Versioned configuration in the original Store. It grants no Engine dispatch authority. */
export function readFlowProfiles(db:DatabaseSync,projectId:string):FlowProfileVersion[]{
  const result:FlowProfileVersion[]=[];
  for(const row of db.prepare('SELECT revision,operation_hash,sha256,data FROM engineering_profiles WHERE project_id=? ORDER BY revision').all(projectId)){
   let v:FlowProfileVersion;try{v=JSON.parse(String(row.data));}catch{throw new DomainError('FLOW_PROFILE_INTEGRITY_FAILED',409);}
   const {contentHash,...body}=v;
   if(hash(body)!==row.sha256||contentHash!==row.sha256||v.projectId!==projectId||v.revision!==row.revision||v.revision!==result.length+1
    ||v.parentHash!==(result.at(-1)?.contentHash??null)||v.operationHash!==row.operation_hash||v.schema!=='dream-maker.custom-profile-version.v1'
    ||v.scope!=='CONFIGURATION_ONLY'||v.serviceIdentity!=='NOT_VERIFIED'||v.executionGranted!==false||hash(customFlowProfile(v.configuration))!==hash(v.configuration)
    ||!/^local-session:[a-f0-9]{64}$/.test(v.confirmedBy)||!/^[a-f0-9]{64}$/.test(v.requestHash)||!Number.isFinite(Date.parse(v.confirmedAt)))throw new DomainError('FLOW_PROFILE_INTEGRITY_FAILED',409);
   result.push(v);
  }return result;
}
export class FlowProfiles {
 constructor(private store:Store){}
 private history(projectId:string){this.store.project(projectId);return readFlowProfiles(this.store.db,projectId);}
 current(projectId:string):FlowProfileVersion|null{return this.history(projectId).at(-1)??null;}
 confirm(projectId:string,raw:unknown,actor:string,operation:string):FlowProfileVersion {
  const request=fields(raw,['configuration','expectedRevision','confirmed']);if(request.confirmed!==true)throw new DomainError('FLOW_PROFILE_CONFIRMATION_REQUIRED',403);
   const configuration=customFlowProfile(request.configuration);requireExplicitGroupMembers(configuration);const expectedRevision=integer(request.expectedRevision,0,128);
  if(!/^local-session:[a-f0-9]{64}$/.test(actor)||!/^[A-Za-z0-9_.:-]{1,160}$/.test(operation))fail();
  const requestHash=hash({configuration,expectedRevision,actor}),operationHash=hash(operation);
  return this.store.tx(()=>{
   const history=this.history(projectId),replay=history.find(v=>v.operationHash===operationHash);
   if(replay){if(replay.requestHash!==requestHash)throw new DomainError('IDEMPOTENCY_CONFLICT',409);return replay;}
   if(this.store.runs(projectId).some(run=>!canReviseAfterFlow(this.store,run)))throw new DomainError('FLOW_TERMINATION_REQUIRED',409);
   const prior=history.at(-1);if((prior?.revision??0)!==expectedRevision)throw new DomainError('FLOW_PROFILE_REVISION_CONFLICT',409);
   if(history.length>=128)throw new DomainError('FLOW_PROFILE_HISTORY_LIMIT',409);
   const body={schema:'dream-maker.custom-profile-version.v1' as const,projectId,revision:expectedRevision+1,parentHash:prior?.contentHash??null,configuration,
    confirmedAt:now(),confirmedBy:actor,operationHash,requestHash,scope:'CONFIGURATION_ONLY' as const,serviceIdentity:'NOT_VERIFIED' as const,executionGranted:false as const};
   const version={...body,contentHash:hash(body)};
   this.store.db.prepare('INSERT INTO engineering_profiles(project_id,revision,operation_hash,sha256,data) VALUES(?,?,?,?,?)').run(projectId,version.revision,operationHash,version.contentHash,JSON.stringify(version));return version;
  });
 }
}
