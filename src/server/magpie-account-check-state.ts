import type {Store} from './store.js';import type {InspectCustomAccountSources} from '../shared/custom-account-sources.js';
import type {MagpieAccountCheckView,MagpieAccountRecoveryView} from '../shared/magpie-account-check.js';import {DomainError,hash,id,now,object} from './security.js';
import type {MagpieCustodyBinding} from './magpie-account-custody.js';
export interface AccountCheckIntent {schema:'dream-maker.magpie-account-check-intent.v1';operationHash:string;requestHash:string;actor:string;selection:InspectCustomAccountSources;flowConfigHash:string;sourceBindingHash:string;createdAt:string;scope:'REGISTERED_MEMORY_TRANSFER_ONLY';contentHash:string}
type Intent=AccountCheckIntent;
interface Result {schema:'dream-maker.magpie-account-check-result.v1';operationHash:string;intentHash:string;view:MagpieAccountCheckView;contentHash:string}
const fail=():never=>{throw new DomainError('MAGPIE_ACCOUNT_CHECK_INTEGRITY',409);};
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const projectId=(v:unknown):v is string=>typeof v==='string'&&/^project_[a-f0-9]{20}$/.test(v);
const time=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function exact(raw:unknown,keys:string[]):Record<string,unknown>{const d=Object.getOwnPropertyDescriptors(object(raw));if(Reflect.ownKeys(d).length!==keys.length||keys.some(k=>!d[k]?.enumerable||!Object.hasOwn(d[k],'value')))return fail();return Object.fromEntries(keys.map(k=>[k,d[k].value]));}
function json(text:unknown):unknown{try{if(typeof text!=='string'||text.length>8192)return fail();return JSON.parse(text);}catch{return fail();}}
export function accountCheckSelection(raw:unknown):InspectCustomAccountSources {
 const v=exact(raw,['projectId','specHash','profileHash','preparation']),p=exact(v.preparation,['identityHash','contentHash']);
 if(!projectId(v.projectId)||!digest(v.specHash)||!digest(v.profileHash)||!digest(p.identityHash)||!digest(p.contentHash))return fail();
 return{projectId:v.projectId,specHash:v.specHash,profileHash:v.profileHash,preparation:{identityHash:p.identityHash,contentHash:p.contentHash}};
}
export function accountCheckBinding(raw:unknown):MagpieCustodyBinding {const v=exact(raw,['flowConfigHash','sourceBindingHash']);if(!digest(v.flowConfigHash)||!digest(v.sourceBindingHash))return fail();return{flowConfigHash:v.flowConfigHash,sourceBindingHash:v.sourceBindingHash};}
function readIntent(raw:unknown):Intent {
 const v=exact(raw,['schema','operationHash','requestHash','actor','selection','flowConfigHash','sourceBindingHash','createdAt','scope','contentHash']),selection=accountCheckSelection(v.selection),{contentHash,...body}=v;
 if(v.schema!=='dream-maker.magpie-account-check-intent.v1'||!digest(v.operationHash)||v.requestHash!==hash(selection)||typeof v.actor!=='string'||!/^local-session:[a-f0-9]{64}$/.test(v.actor)||!digest(v.flowConfigHash)||!digest(v.sourceBindingHash)||!time(v.createdAt)||v.scope!=='REGISTERED_MEMORY_TRANSFER_ONLY'||contentHash!==hash(body))return fail();return v as unknown as Intent;
}
function readView(raw:unknown,intent:Intent):MagpieAccountCheckView {
 const v=exact(raw,['schema','projectId','scope','historical','status','selection','flowConfigHash','sourceBindingHash','checkedAt','accountCount','processClosed','reason','accountVerified','modelVerified','customExecutionGranted']);
 if(v.schema!=='dream-maker.magpie-account-check.v1'||v.projectId!==intent.selection.projectId||v.scope!==intent.scope||v.historical!==true||hash(accountCheckSelection(v.selection))!==intent.requestHash||v.flowConfigHash!==intent.flowConfigHash||!time(v.checkedAt)||typeof v.accountVerified!=='boolean'||v.modelVerified!==false||v.customExecutionGranted!==false)return fail();
 const hasAccount=v.accountCount!==null,hasBinding=v.sourceBindingHash!==null;
 if(hasAccount!==hasBinding||hasAccount&&(!Number.isSafeInteger(v.accountCount)||Number(v.accountCount)<1||Number(v.accountCount)>8||v.sourceBindingHash!==intent.sourceBindingHash))return fail();
 if(v.status==='PASSED'){if(!hasAccount||v.processClosed!==true||v.reason!==null)return fail();}
 else if(v.status==='UNCERTAIN'){if(hasAccount||v.processClosed!==false||v.reason!=='CLEANUP_UNCERTAIN')return fail();}
 else if(v.status==='FAILED'){if(typeof v.reason!=='string'||!['COMPONENT_NOT_BOUND','BUSY','CHECK_FAILED','SELECTION_CHANGED'].includes(v.reason)||v.processClosed!==null&&v.processClosed!==true||hasAccount&&v.processClosed!==true)return fail();}
 else return fail();return structuredClone(v) as unknown as MagpieAccountCheckView;
}
function history(store:Store):{intents:Intent[];results:Result[];ownerships:AccountCheckOwnership[];recoveries:AccountCheckRecovery[]} {
 try{
  const load=(kind:string)=>{const rows=store.db.prepare('SELECT project_id,run_id,data FROM records WHERE kind=? ORDER BY rowid LIMIT 1025').all(kind);if(rows.length>1024)throw new DomainError('MAGPIE_ACCOUNT_CHECK_HISTORY_LIMIT',409);return rows;};
  const intents=load('MagpieAccountCheckIntent').map(row=>{const v=readIntent(json(row.data));if(row.project_id!==v.selection.projectId||row.run_id!==null)return fail();return v;});
  if(new Set(intents.map(v=>v.operationHash)).size!==intents.length)return fail();
  const results=load('MagpieAccountCheckResult').map(row=>{
   const v=exact(json(row.data),['schema','operationHash','intentHash','view','contentHash']),{contentHash,...body}=v,intent=intents.find(i=>i.operationHash===v.operationHash);
   if(!intent||row.project_id!==intent.selection.projectId||row.run_id!==null||v.schema!=='dream-maker.magpie-account-check-result.v1'||v.intentHash!==intent.contentHash||contentHash!==hash(body))return fail();readView(v.view,intent);return v as unknown as Result;
  });if(new Set(results.map(v=>v.operationHash)).size!==results.length)return fail();
  // A completed HTTP receipt must retain its exact journal. It cannot hide missing
  // process evidence or become a fresh operation after restore/corruption.
  const receipts=store.db.prepare("SELECT key,request_hash,response FROM requests WHERE status='done' AND key GLOB 'POST:/api/projects/*/flow-account-check:*' LIMIT 1025").all();if(receipts.length>1024)throw new DomainError('MAGPIE_ACCOUNT_CHECK_HISTORY_LIMIT',409);
  for(const row of receipts){const receipt=exact(json(row.response),['schema','operationHash','requestHash','resultHash']),intent=intents.find(i=>i.operationHash===receipt.operationHash),result=results.find(r=>r.operationHash===receipt.operationHash),match=/^POST:(\/api\/projects\/(project_[a-f0-9]{20})\/flow-account-check):(.*)$/.exec(String(row.key));
   if(!intent||!result||!match||match[2]!==intent.selection.projectId||receipt.schema!=='dream-maker.magpie-account-check-request.v1'||receipt.requestHash!==row.request_hash||receipt.resultHash!==hash(result.view)||receipt.operationHash!==hash({method:'POST',path:match[1],key:match[3],actor:intent.actor}))return fail();
   const s=intent.selection;if(receipt.requestHash!==hash({specHash:s.specHash,profileHash:s.profileHash,preparation:s.preparation,confirmed:true}))return fail();
  }
  const ownerships=load('MagpieAccountCheckOwnership').map(row=>{const raw=json(row.data),op=object(raw).operationHash,intent=intents.find(i=>i.operationHash===op);if(!intent||row.project_id!==intent.selection.projectId||row.run_id!==null)return fail();return readOwnership(raw,intent);});
  if(new Set(ownerships.map(v=>v.operationHash)).size!==ownerships.length)return fail();
  const recoveries=load('MagpieAccountCheckRecovery').map(row=>{
   const v=exact(json(row.data),['schema','operationHash','intentHash','ownershipHash','recordsHash','proofsHash','evidence','actor','recoveredAt','contentHash']),{contentHash,...body}=v,intent=intents.find(i=>i.operationHash===v.operationHash),ownership=ownerships.find(o=>o.operationHash===v.operationHash),result=results.find(r=>r.operationHash===v.operationHash);
   if(!intent||!ownership||row.project_id!==intent.selection.projectId||row.run_id!==null||v.schema!=='dream-maker.magpie-account-check-recovery.v1'||v.intentHash!==intent.contentHash||v.ownershipHash!==ownership.contentHash||result&&result.view.status!=='UNCERTAIN'||typeof v.actor!=='string'||!/^local-session:[a-f0-9]{64}$/.test(v.actor)||!digest(v.recordsHash)||!digest(v.proofsHash)||v.proofsHash!==hash(v.evidence)||!time(v.recoveredAt)||contentHash!==hash(body)||v.recordsHash!==hash(accountCheckProcessJournal(store,intent,ownership)))return fail();return v as unknown as AccountCheckRecovery;
  });if(new Set(recoveries.map(v=>v.operationHash)).size!==recoveries.length)return fail();
  return{intents,results,ownerships,recoveries};
 }catch(error){if(error instanceof DomainError)throw error;return fail();}
}
function put(store:Store,kind:'MagpieAccountCheckIntent'|'MagpieAccountCheckResult',pid:string,value:Intent|Result){
 // A fixed, validated nonsecret projection, not generic text logging or a new store.
 store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run(id('rec'),kind,pid,null,JSON.stringify(value),now());
}
export function beginAccountCheck(store:Store,raw:unknown,rawBinding:MagpieCustodyBinding,actor:string,operationHash:string):Intent {
 const selection=accountCheckSelection(raw),binding=accountCheckBinding(rawBinding);store.project(selection.projectId);
 const body={schema:'dream-maker.magpie-account-check-intent.v1' as const,operationHash,requestHash:hash(selection),actor,selection,...binding,createdAt:now(),scope:'REGISTERED_MEMORY_TRANSFER_ONLY' as const},candidate=readIntent({...body,contentHash:hash(body)});
 return store.tx(()=>{const state=history(store),old=state.intents.find(i=>i.operationHash===operationHash);if(old){if(old.requestHash!==candidate.requestHash||old.actor!==actor||old.flowConfigHash!==binding.flowConfigHash||old.sourceBindingHash!==binding.sourceBindingHash)throw new DomainError('IDEMPOTENCY_KEY_REUSED',409);return old;}if(state.intents.length>=1024)throw new DomainError('MAGPIE_ACCOUNT_CHECK_HISTORY_LIMIT',409);put(store,'MagpieAccountCheckIntent',selection.projectId,candidate);return candidate;});
}
export function finishAccountCheck(store:Store,intent:Intent,raw:unknown):void {
 const checked=readIntent(intent),view=readView(raw,checked);
 store.tx(()=>{const state=history(store),saved=state.intents.find(i=>i.operationHash===checked.operationHash);if(!saved||saved.contentHash!==checked.contentHash)return fail();const old=state.results.find(r=>r.operationHash===checked.operationHash);if(old){if(hash(old.view)!==hash(view))throw new DomainError('MAGPIE_ACCOUNT_CHECK_RESULT_EXISTS',409);return;}
  const body={schema:'dream-maker.magpie-account-check-result.v1' as const,operationHash:checked.operationHash,intentHash:checked.contentHash,view};put(store,'MagpieAccountCheckResult',checked.selection.projectId,{...body,contentHash:hash(body)});
 });
}
export function accountCheckOperation(store:Store,operationHash:string):{intent:Intent;view:MagpieAccountCheckView}|null {
 const state=history(store),intent=state.intents.find(i=>i.operationHash===operationHash);return intent?{intent,view:projectView(intent,state.results.find(r=>r.operationHash===operationHash))}:null;
}
function projectView(intent:Intent,result:Result|undefined):MagpieAccountCheckView {
 return result?structuredClone(result.view):{schema:'dream-maker.magpie-account-check.v1',projectId:intent.selection.projectId,scope:intent.scope,historical:true,status:'UNCERTAIN',selection:structuredClone(intent.selection),flowConfigHash:intent.flowConfigHash,sourceBindingHash:null,checkedAt:intent.createdAt,accountCount:null,processClosed:false,reason:'CLEANUP_UNCERTAIN',accountVerified:false,modelVerified:false,customExecutionGranted:false};
}
export function latestAccountCheck(store:Store,pid:string):MagpieAccountCheckView {
 store.project(pid);const state=history(store),intent=state.intents.filter(i=>i.selection.projectId===pid).at(-1);
 return intent?projectView(intent,state.results.find(r=>r.operationHash===intent.operationHash)):{schema:'dream-maker.magpie-account-check.v1',projectId:pid,scope:'REGISTERED_MEMORY_TRANSFER_ONLY',historical:true,status:'NOT_RUN',selection:null,flowConfigHash:null,sourceBindingHash:null,checkedAt:null,accountCount:null,processClosed:null,reason:null,accountVerified:false,modelVerified:false,customExecutionGranted:false};
}
export function accountChecksUncertain(store:Store):boolean {
 try{const state=history(store);return state.intents.some(intent=>{const result=state.results.find(r=>r.operationHash===intent.operationHash);return(!result||result.view.status==='UNCERTAIN')&&!state.recoveries.some(r=>r.operationHash===intent.operationHash);});}catch{return true;}
}

export interface AccountCheckOwnership {
 schema:'dream-maker.magpie-account-check-ownership.v1';operationHash:string;intentHash:string;
 dispatchId:string;generation:string;platform:string;contentHash:string;
}
function readOwnership(raw:unknown,intent:Intent):AccountCheckOwnership {
 const v=exact(raw,['schema','operationHash','intentHash','dispatchId','generation','platform','contentHash']),{contentHash,...body}=v;
 if(v.schema!=='dream-maker.magpie-account-check-ownership.v1'||v.operationHash!==intent.operationHash||v.intentHash!==intent.contentHash||v.dispatchId!=='magpie_check_'+hash({operationHash:intent.operationHash,intentHash:intent.contentHash}).slice(0,20)||typeof v.generation!=='string'||!/^magpie_check_owner_[a-f0-9]{20}$/.test(v.generation)||!['win32','linux','darwin'].includes(String(v.platform))||contentHash!==hash(body))return fail();
 return v as unknown as AccountCheckOwnership;
}
/** Private ownership scope, persisted before the original NativeOwner may launch. */
export function beginAccountCheckOwnership(store:Store,intent:Intent):AccountCheckOwnership {
 return store.tx(()=>{
  const saved=accountCheckOperation(store,intent.operationHash);if(!saved||saved.intent.contentHash!==intent.contentHash)return fail();
  if(accountCheckOwnership(store,intent))throw new DomainError('MAGPIE_ACCOUNT_CHECK_OWNERSHIP_EXISTS',409);
  const body={schema:'dream-maker.magpie-account-check-ownership.v1' as const,operationHash:intent.operationHash,intentHash:intent.contentHash,dispatchId:'magpie_check_'+hash({operationHash:intent.operationHash,intentHash:intent.contentHash}).slice(0,20),generation:id('magpie_check_owner'),platform:process.platform};
  const value=readOwnership({...body,contentHash:hash(body)},intent);
  store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run(id('rec'),'MagpieAccountCheckOwnership',intent.selection.projectId,null,JSON.stringify(value),now());return value;
 });
}
export function accountCheckOwnership(store:Store,intent:Intent):AccountCheckOwnership|null {
 return history(store).ownerships.find(o=>o.operationHash===intent.operationHash)??null;
}

interface AccountCheckRecovery {schema:'dream-maker.magpie-account-check-recovery.v1';operationHash:string;intentHash:string;ownershipHash:string;recordsHash:string;proofsHash:string;evidence:unknown;actor:string;recoveredAt:string;contentHash:string}
export interface AccountCheckProcessRecord {id:string;kind:string;data:Record<string,unknown>}
/** Controller-only journal. Full paths and OS metadata never enter its public view. */
export function accountCheckProcessJournal(store:Store,intent:Intent,ownership:AccountCheckOwnership):AccountCheckProcessRecord[] {
 try{
  const rows=store.db.prepare("SELECT id,kind,project_id,run_id,data FROM records WHERE kind!='MagpieAccountCheckOwnership' AND json_extract(data,'$.dispatchId')=? ORDER BY rowid LIMIT 129").all(ownership.dispatchId);if(rows.length>128)return fail();
  const kinds=['OwnedProcessIntent','OwnedProcessNotLaunched','OwnedProcessRootStarted','OwnedProcessRootExited','OwnedWindowsJobIntent','OwnedWindowsJobPinned','OwnedWindowsJobClosed','OwnedProcessCleanup'];
  return rows.map(row=>{const value=object(JSON.parse(String(row.data)));if(row.project_id!==intent.selection.projectId||row.run_id!==null||value.dispatchId!==ownership.dispatchId||value.generation!==ownership.generation||!kinds.includes(String(row.kind))||typeof value.processId!=='string'||!/^owned_process_[a-f0-9]{20}$/.test(value.processId))return fail();return{id:String(row.id),kind:String(row.kind),data:value};});
 }catch{return fail();}
}
export function accountCheckRecoveryTarget(store:Store,pid:string){
 store.project(pid);const state=history(store),unresolved=state.intents.filter(i=>i.selection.projectId===pid&&(!state.results.some(r=>r.operationHash===i.operationHash)||state.results.find(r=>r.operationHash===i.operationHash)!.view.status==='UNCERTAIN'));
 const intent=unresolved.find(i=>!state.recoveries.some(r=>r.operationHash===i.operationHash))??unresolved.at(-1);
 if(!intent)return null;const ownership=state.ownerships.find(o=>o.operationHash===intent.operationHash)??null,recovered=state.recoveries.find(r=>r.operationHash===intent.operationHash)??null;
 return{intent,ownership,recovered,targetHash:hash({operationHash:intent.operationHash,intentHash:intent.contentHash,ownershipHash:ownership?.contentHash??null})};
}
export function accountCheckRecoveryView(store:Store,pid:string,verified:()=>boolean=()=>false):MagpieAccountRecoveryView {
 const target=accountCheckRecoveryTarget(store,pid),base={schema:'dream-maker.magpie-account-recovery.v1' as const,projectId:pid,scope:'LOCAL_PROCESS_CLEANUP_ONLY' as const,accountVerified:verified(),modelVerified:false as const,customExecutionGranted:false as const};
 if(!target)return{...base,status:'NOT_REQUIRED',targetHash:null,checkedAt:null,processClosed:null,restartRequired:false,reason:null};
 return{...base,status:target.recovered?'RECOVERED':'REQUIRED',targetHash:target.targetHash,checkedAt:target.recovered?.recoveredAt??null,processClosed:!!target.recovered,restartRequired:!!target.recovered,reason:target.recovered?null:target.ownership?'CLEANUP_UNCERTAIN':'EVIDENCE_MISSING'};
}
export function finishAccountCheckRecovery(store:Store,pid:string,targetHash:string,recordsHash:string,evidence:unknown,actor:string,verified:()=>boolean=()=>false):MagpieAccountRecoveryView {
 return store.tx(()=>{
  const target=accountCheckRecoveryTarget(store,pid);if(!target||target.targetHash!==targetHash||!target.ownership||!digest(recordsHash)||!/^local-session:[a-f0-9]{64}$/.test(actor)||JSON.stringify(evidence).length>2048||recordsHash!==hash(accountCheckProcessJournal(store,target.intent,target.ownership)))throw new DomainError('MAGPIE_ACCOUNT_RECOVERY_STALE',409);
  if(!target.recovered){const body={schema:'dream-maker.magpie-account-check-recovery.v1' as const,operationHash:target.intent.operationHash,intentHash:target.intent.contentHash,ownershipHash:target.ownership.contentHash,recordsHash,proofsHash:hash(evidence),evidence,actor,recoveredAt:now()};store.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run(id('rec'),'MagpieAccountCheckRecovery',pid,null,JSON.stringify({...body,contentHash:hash(body)}),now());}
  return accountCheckRecoveryView(store,pid,verified);
 });
}
