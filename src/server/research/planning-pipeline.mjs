/** A finite, injected P1 research -> decision -> plan pipeline.
 * No model/provider implementation or production authorization is invented.
 * The host must implement claim/record/persist as durable transactions and must
 * recheck expectedInputHash inside persistDraft, not only in isCurrent(). */
import {GuardError,requireCondition as need,isRecord,id,text,digest,copy} from './common.mjs';
import {interviewPlanInput} from './interview-input.mjs';
import {selectReuseStrategy,buildPlannerContext} from './reuse-policy.mjs';
import {safeSearchKeywords} from './repository-clients.mjs';
import {validatePlanBody} from './plan-contract.mjs';
export async function runPlanningPipeline(input,deps,{signal}={}){
 need(isRecord(input)&&isRecord(deps),'INVALID_PIPELINE_INPUT');id(input.projectId);id(input.operationId);text(input.distribution,'DISTRIBUTION',100);
 for(const k of ['claim','record','isCurrent','makeSearchIntent','authorizePublicQuery','reviewCandidate','verifyAssessment','generatePlan','persistDraft'])need(typeof deps[k]==='function','PIPELINE_DEPENDENCY_REQUIRED');
 need(deps.research&&typeof deps.research.discover==='function','RESEARCH_DEPENDENCY_REQUIRED');
 need(input.interview?.projectId===input.projectId,'CROSS_PROJECT_INTERVIEW');
 const interview=interviewPlanInput(input.interview,input.description);
 need(Array.isArray(input.requirementIds)&&input.requirementIds.length>0,'REQUIREMENTS_REQUIRED');
 const binding={projectId:input.projectId,projectRevision:input.projectRevision,interviewRevision:input.interview.revision,parentPlanId:input.parentPlanId??null,description:input.description,answers:interview.answers,requirementIds:input.requirementIds,distribution:input.distribution,...(input.alternativeContext?{alternativeContext:copy(input.alternativeContext)}:{})};
 const inputHash=digest(binding),claim=await deps.claim({operationId:input.operationId,projectId:input.projectId,inputHash});
 need(isRecord(claim)&&typeof claim.acquired==='boolean','INVALID_PIPELINE_CLAIM');
 if(!claim.acquired)return{status:'EXISTING_OPERATION_REQUIRES_RECONCILIATION',operationId:input.operationId,inputHash};
 const check=async()=>{if(signal?.aborted)throw new GuardError('PLANNING_CANCELLED');need(await deps.isCurrent({projectId:input.projectId,inputHash,parentPlanId:binding.parentPlanId})===true,'PLANNING_INPUT_STALE_OR_FLOW_ACTIVE');};
 const stage=async(state,data={})=>{await check();await deps.record({operationId:input.operationId,projectId:input.projectId,inputHash,state,...data});};
 try{
  await stage('RESEARCH_INTENT');
  const proposed=await deps.makeSearchIntent(copy(binding),{signal});await check();
  const keywords=safeSearchKeywords(proposed.keywords);
  const disclosure=await deps.authorizePublicQuery({projectId:input.projectId,intentHash:inputHash,keywords:copy(keywords),queryHash:digest(keywords)});await check();
  await stage('SEARCHING');const research=await deps.research.discover({keywords,disclosure,intentHash:inputHash,signal});await check();
  const context={requirementIds:input.requirementIds,intentHash:inputHash,distribution:input.distribution};const assessments={};
  await stage('REVIEWING_SOURCES',{researchStatus:research.status,sourceCount:research.snapshots.length});
  for(const snapshot of research.snapshots){await check();const a=await deps.reviewCandidate(copy(snapshot),copy(context),{signal});await check();if(a)assessments[snapshot.snapshotHash]=a;}
  const decision=selectReuseStrategy(research.snapshots,assessments,context,{verifyAssessment:deps.verifyAssessment,now:deps.now?.()??Date.now()});
  await stage('DRAFTING_PLAN',{reuseMode:decision.mode});
  const plannerContext=buildPlannerContext({originalDescription:input.description,answers:interview.answers,research,decision});
  const generated=await deps.generatePlan(plannerContext,{signal});await check();
  need(isRecord(generated),'INVALID_PLAN_RESULT');
  // Model output cannot erase failed research or substitute a floating repository.
  const plan={...copy(generated),research:{status:research.status,sourceRefs:research.snapshots.map(s=>({webUrl:s.webUrl,commit:s.commit,snapshotHash:s.snapshotHash})),searchScope:research.searchScope,failures:research.failures},reuse:decision,inputBinding:{inputHash,interviewRevision:binding.interviewRevision,projectRevision:binding.projectRevision}};
  validatePlanBody(plan);
  await stage('SAVING_UNAPPROVED_PLAN');
  const draft=await deps.persistDraft({projectId:input.projectId,operationId:input.operationId,expectedInputHash:inputHash,expectedParentId:binding.parentPlanId,body:plan,signal});
  // Do not post-check isCurrent: saving the draft may correctly change the revision.
  await deps.record({operationId:input.operationId,projectId:input.projectId,inputHash,state:'DRAFT_SAVED',draftId:draft.id});
  return {status:'DRAFT_REQUIRES_USER_CONFIRMATION',draft,research,decision,inputHash};
 }catch(e){
  const code=e instanceof GuardError?e.code:'PLANNING_FAILED_OR_RESULT_UNCERTAIN';
  // Swallowing the original error left operators with only the generic code. Record the real cause on
  // stderr (no prompt or credential text, message clipped) before the caller-facing error is built.
  if(!(e instanceof GuardError))process.stderr.write('PLANNING_PIPELINE_CAUSE '+JSON.stringify({name:String(e&&e.name||''),message:String(e&&e.message||'').slice(0,300)})+'\n');
  throw e instanceof GuardError?e:new GuardError(code,503);
 }
}
