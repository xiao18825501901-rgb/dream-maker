import type {CustomFlowConfigSnapshot} from '../../shared/flow-configuration.js';
import type {MagpieControlObservation} from '../magpie-owned.js';
import type {NativeBudget,NativePrice} from '../native-budget.js';
import {assertNativePriceForRoute} from '../native-budget.js';
import {DomainError,hash} from '../security.js';
import {customFlowProfile} from '../flow-profiles.js';
import {customMagpieApiRuntime} from './custom-role-identity.js';
import {customBudgetRemaining} from './custom-budget.js';
import {selectCustomMagpieMember} from './custom-magpie-catalog.js';

/** Validate every candidate's static policy before accessing account custody or spend history. */
export function preparedMemberScope(snapshot:CustomFlowConfigSnapshot,roleId:string){
 const {accounts,roles,groups,privacy,timeZone}=snapshot;
 const profile=customFlowProfile({mode:'custom',laya:false,accounts,roles,groups,privacy,timeZone,budget:snapshot.budget});
 const role=roleId===roles.planner2.id?'planner2':roleId===roles.reviewer.id?'reviewer':'executor';
 const actor=role==='executor'?roles.executors.find(r=>r.id===roleId):roles[role];
 const group=groups.find(g=>actor?.model.kind==='group'&&g.id===actor.model.id);
 const selected=group?.members.find(m=>m.id===actor?.selectedMemberId);
 if(!actor||!group||!selected||privacy.deniedDataLabels.length||actor.transport!=='magpie'||actor.nativeException||!customMagpieApiRuntime(role,actor.runtime)||group.members.some(member=>!member.permissions.includes('source_read')))throw new DomainError('CUSTOM_MAGPIE_SELECTION_SCOPE_INVALID',409);
 const account=accounts.find(a=>a.provider===selected.provider&&a.authRef===selected.authRef&&a.accountRef===selected.accountRef);
 if(account?.authentication!=='api_key'||actor.budget.currency!=='CNY')throw new DomainError('CUSTOM_MAGPIE_ESTIMATE_UNAVAILABLE',409);
 return {actor,role,selected,profile} as const;
}
/** Read-only estimate for one request on the account selected in this preparation. */
export function recommendPreparedMember(snapshot:CustomFlowConfigSnapshot,roleId:string,observation:Readonly<MagpieControlObservation>,budget:Pick<NativeBudget,'requests'|'estimateCustomSelection'>,maxOutputTokens:number,quote:(role:'planner2'|'executor'|'reviewer',provider:string,model:string)=>NativePrice){
 const {actor,role,selected,profile}=preparedMemberScope(snapshot,roleId),configurationHash=hash(snapshot);
 let remaining:ReturnType<typeof customBudgetRemaining>|undefined;
 const expiries=new Map<string,number>();
 const result=selectCustomMagpieMember(profile,role,roleId,observation,(binding,route)=>{
  if(route.authRef!==selected.authRef||route.accountRef!==selected.accountRef||route.provider!==selected.provider||route.authentication!=='api_key'||binding.currency!=='CNY')return;
  remaining??=customBudgetRemaining(budget.requests(),{projectId:snapshot.projectId,runId:snapshot.runId,configurationHash,roleId},{flow:snapshot.budget,role:actor.budget});
  try{
   const price=quote(role,route.provider,route.model);
   assertNativePriceForRoute(price,{provider:route.provider,model:route.model,currency:binding.currency});
   const reserveMicros=budget.estimateCustomSelection(price,maxOutputTokens),expiresAtMs=Date.parse(price.expiresAt);
   expiries.set(binding.routeHash,expiresAtMs);
   return {...binding,...remaining,reserveMicros,expiresAtMs};
  }catch{return;}
 },selected.id);
 return {scope:result.scope,profileHash:snapshot.profile.contentHash,flowConfigHash:configurationHash,roleId,groupId:result.groupId,memberId:result.memberId,reserveMicros:result.reserveMicros,currency:result.binding.currency,expiresAtMs:expiries.get(result.binding.routeHash)!};
}
