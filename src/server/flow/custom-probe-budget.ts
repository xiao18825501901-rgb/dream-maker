import type {ProfileBudget} from '../../shared/flow-profile.js';
import type {NativeRequestBinding} from '../../shared/native-request.js';
import {DomainError,object,hash,hasSecret} from '../security.js';
import {nativeRequestBinding} from '../native-request-binding.js';
import type {CustomRequestBudget} from './custom-budget.js';
import {requestBudgetSupplement,type RequestBudgetSupplement} from './custom-budget-supplement.js';

/** Immutable controller input, not a grant, balance, public configuration or account proof. */
export interface CustomProbeBudgetContext {
 schema:'dream-maker.custom-probe-budget.v1';probeId:string;bindingHash:string;
 projectId:string;runId:string;configurationHash:string;planVersionHash:string;specHash:string;
 role:'planner2'|'executor'|'reviewer';roleId:string;dispatchId:string;generation:string;routeHash:string;
 flowBudget:ProfileBudget;roleBudget:ProfileBudget;
 supplement?:RequestBudgetSupplement;
}
const fields=['schema','probeId','bindingHash','projectId','runId','configurationHash','planVersionHash','specHash','role','roleId','dispatchId','generation','routeHash','flowBudget','roleBudget'];
const fail=(code='CUSTOM_PROBE_CONTEXT_INVALID'):never=>{throw new DomainError(code,409);};
function exact(raw:unknown,keys:string[]){
 const d=Object.getOwnPropertyDescriptors(object(raw));
 if(Reflect.ownKeys(d).length!==keys.length||keys.some(k=>!d[k]?.enumerable||!Object.hasOwn(d[k],'value')))return fail();
 return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
export function customProbeBudgetContext(raw:unknown):CustomProbeBudgetContext {
 try{
  const hasSupplement=Object.hasOwn(object(raw),'supplement');
  const v=exact(raw,[...fields,...(hasSupplement?['supplement']:[])]),cap=(raw:unknown):ProfileBudget=>{const c=exact(raw,['currency','maxMicros']);if(!['CNY','USD'].includes(String(c.currency))||!Number.isSafeInteger(c.maxMicros)||Number(c.maxMicros)<0||Number(c.maxMicros)>1000000000000)return fail();return{currency:c.currency as 'CNY'|'USD',maxMicros:Number(c.maxMicros)};};
  const flowBudget=cap(v.flowBudget),roleBudget=cap(v.roleBudget);
  if(v.schema!=='dream-maker.custom-probe-budget.v1'||typeof v.probeId!=='string'||!/^custom_probe_[A-Za-z0-9_-]{1,100}$/.test(v.probeId)||
   !['bindingHash','configurationHash','planVersionHash','specHash','routeHash'].every(k=>typeof v[k]==='string'&&/^[a-f0-9]{64}$/.test(v[k] as string))||
   !['projectId','runId','roleId','dispatchId','generation'].every(k=>typeof v[k]==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v[k] as string))||
   !['planner2','executor','reviewer'].includes(String(v.role))||(v.role==='executor'?v.roleId==='planner2'||v.roleId==='reviewer':v.roleId!==v.role)||
   flowBudget.currency!==roleBudget.currency||roleBudget.maxMicros>flowBudget.maxMicros||hasSecret(JSON.stringify(v)))return fail();
  const supplement=hasSupplement?requestBudgetSupplement(v.supplement,flowBudget,roleBudget):undefined;
  return{...v,flowBudget,roleBudget,...(supplement?{supplement}:{})} as unknown as CustomProbeBudgetContext;
 }catch{return fail();}
}
/** Same final request identity used by the original Magpie hold/grant bridge. */
export function customProbeRequestBinding(context:CustomProbeBudgetContext,raw:unknown):NativeRequestBinding {
 try{
  const c=customProbeBudgetContext(context),b=nativeRequestBinding(raw,c.role),expected={schema:'dream-maker.native-request-binding.v1',projectId:c.projectId,runId:c.runId,engineeringMode:'custom',configurationHash:c.configurationHash,planVersionHash:c.planVersionHash,specHash:c.specHash,dispatchId:c.dispatchId,generation:c.generation,role:c.role,roleId:c.roleId,work:{kind:'QUALIFICATION',probeId:c.probeId,bindingHash:c.bindingHash},bodyHash:b.bodyHash,routeHash:c.routeHash};
  if(hash(b)!==hash(expected))return fail('CUSTOM_PROBE_BINDING_MISMATCH');return b;
 }catch{return fail('CUSTOM_PROBE_BINDING_MISMATCH');}
}
export function customProbeRequestLimits(c:CustomProbeBudgetContext):CustomRequestBudget {
 const v=customProbeBudgetContext(c);return{schema:'dream-maker.custom-request-budget.v1',projectId:v.projectId,runId:v.runId,configurationHash:v.configurationHash,roleId:v.roleId,flow:v.flowBudget,role:v.roleBudget,...(v.supplement?{supplement:v.supplement}:{})};
}
