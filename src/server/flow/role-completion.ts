import type {Config,ExecutionIdentity,Role,Run,Review} from '../../shared/types.js';
import {CUSTOM_ROLE_POLICY,TARGET_ROLE_POLICY,executionIdentity} from '../role-policy.js';
import {customExecutionIdentity} from './custom-role-identity.js';
import {DomainError} from '../security.js';
import type {Store} from '../store.js';
import {completedDocumentationEngineeringRoles} from '../documentation-continuation.js';
import {verifiedExecutorRoleIdentities} from './executor-role-evidence.js';

/** Adapter-owned runner evidence, never a model-written display/source name. */
export function reviewSourceForRunner(runner:ExecutionIdentity['runner']):Review['source'] {
 if(runner==='CODEX_CLI')return 'CODEX';
 if(runner==='DSH')return 'DSH';
 if(runner==='INDEPENDENT_API')return 'INDEPENDENT_API';
 if(runner==='KIMI_SERVER')return 'KIMI_SERVER';
 throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
}

/** The Custom reviewer may be DSH, but only when every frozen identity field
 * and its independent session still match the original Engine records. */
export function completedCustomReviewSource(run:Run):Review['source'] {
 const identity=run.roleIdentities?.reviewer;if(!identity||identity.sessionId!==run.sessions.reviewer)throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
 const out={text:'',sessionId:identity.sessionId,model:identity.model,identity,usage:{role:'reviewer' as const,requestId:identity.requestId,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN' as const}};
 customExecutionIdentity(run,'reviewer',out);
 if(identity.runner==='CLAUDE_CODE'||identity.runner==='OPENCODE_CLI'||identity.runner==='CLINE_CLI')return identity.runner;
 return reviewSourceForRunner(identity.runner);
}

/** A model-written source/display name cannot identify the actual reviewer. */
export function completedReviewSource(run:Run,config:Config):Review['source'] {
 if(run.mode==='demo')return 'DEMO_RULES';
 if(run.flowName==='custom')return completedCustomReviewSource(run);
 const identity=run.roleIdentities?.reviewer;if(!identity||identity.sessionId!==run.sessions.reviewer)throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
 const out={text:'',sessionId:identity.sessionId,model:identity.model,identity,usage:{role:'reviewer' as const,requestId:identity.requestId,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN' as const}};
 executionIdentity('reviewer',config,out);
 return reviewSourceForRunner(identity.runner);
}

/** Completed adapter evidence, not a verifier flag or the model's own summary. */
export function completedEngineeringRoles(run:Run,config:Config,store?:Store):boolean {
 if(run.mode==='demo')return true;
 if(run.documentationContinuation)return !!store&&completedDocumentationEngineeringRoles(store,run);
 const custom=run.flowName==='custom';
 if(run.rolePolicy!==(custom?CUSTOM_ROLE_POLICY:TARGET_ROLE_POLICY))return false;
 if(custom){
  if(!store)return false;
  try{verifiedExecutorRoleIdentities(run,store);}catch{return false;}
 }
 return (['planner2','executor','reviewer'] as const).every((role:Role)=>{
  const identity=run.roleIdentities?.[role];if(!identity)return false;
  if(custom&&role!=='executor'&&(identity.sessionId!==run.sessions[role]||!run.usage.some(u=>u.role===role&&u.requestId===identity.requestId)))return false;
  try{
   const out={text:'',sessionId:identity.sessionId,model:identity.model,identity,usage:{role,requestId:identity.requestId,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN' as const}};
   if(custom)customExecutionIdentity(run,role,out);else executionIdentity(role,config,out);return true;
  }catch{return false;}
 })&&run.sessions.planner2!==run.sessions.reviewer&&(!custom||(run.executorRoleIdentities??[]).every(identity=>
  identity.sessionId!==run.sessions.planner2&&identity.sessionId!==run.sessions.reviewer));
}
