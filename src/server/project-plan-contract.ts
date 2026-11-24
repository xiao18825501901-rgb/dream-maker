import { validatePlanBody } from './research/plan-contract.mjs';
import { DomainError,object,text,hasSecret } from './security.js';
import type { ProjectPlan,PlanRequirement } from '../shared/project-plan.js';
const strings=(v:unknown,max=200):string[]=>{
    if(!Array.isArray(v)||v.length>max)throw new DomainError('PLAN_LIST_INVALID',502);
    return v.map(s=>text(s,4000));
};
export function completeProjectPlan(raw:unknown,required:PlanRequirement[]):ProjectPlan {
    validatePlanBody(raw);const plan=object(raw);
    const requirements=plan.requirements as PlanRequirement[];
    for(const r of required)if(!requirements.some(x=>x.id===r.id&&x.text===r.text&&x.origin==='USER'&&JSON.stringify(x.sources)===JSON.stringify(r.sources)))
        throw new DomainError('P1_RAW_REQUIREMENT_CHANGED',502);
    if(requirements.some(r=>r.origin==='USER'&&!required.some(x=>x.id===r.id)))throw new DomainError('P1_INVENTED_USER_REQUIREMENT',502);
    const architecture=object(plan.architecture);text(architecture.summary,6000);text(architecture.runtime,1000);if(!strings(architecture.components,50).length)throw new DomainError('PLAN_ARCHITECTURE_REQUIRED',502);
    const data=object(plan.dataModel);strings(data.entities,100);text(data.persistence,4000);
    const interfaces=object(plan.interfaces);if(!strings(interfaces.userFlows,100).length)throw new DomainError('PLAN_USER_FLOW_REQUIRED',502);strings(interfaces.boundaries,100);
    const delivery=object(plan.delivery);text(delivery.type,300);text(delivery.howToUse,6000);
    if(typeof delivery.standalone!=='boolean'||typeof delivery.needsInternet!=='boolean')throw new DomainError('PLAN_USE_CONDITIONS_REQUIRED',502);
    strings(delivery.ongoingFees,50);const resources=object(plan.resources);
    for(const key of ['accounts','hardware','network','ongoingCosts'])strings(resources[key],50);
    for(const key of ['risks','milestones','assumptions','unknowns','outOfScope'])strings(plan[key]);
    if(!Array.isArray(plan.tasks)||!plan.tasks.length||plan.tasks.length>100)throw new DomainError('PLAN_TASKS_REQUIRED',502);
    const taskIds=new Set<string>(),covered=new Set<string>();
    for(const rawTask of plan.tasks){const task=object(rawTask),tid=text(task.id,80);if(taskIds.has(tid))throw new DomainError('PLAN_TASK_DUPLICATE',502);taskIds.add(tid);text(task.title,1000);text(task.check,4000);
        strings(task.dependsOn,100);for(const rid of strings(task.requirementIds,200)){if(!requirements.some(r=>r.id===rid))throw new DomainError('PLAN_TASK_REQUIREMENT_INVALID',502);covered.add(rid);}}
    if(requirements.some(r=>!covered.has(r.id)))throw new DomainError('PLAN_TASK_COVERAGE_MISSING',502);
    const visiting=new Set<string>(),done=new Set<string>(),tasks=plan.tasks as ProjectPlan['tasks'];
    const visit=(tid:string)=>{if(visiting.has(tid))throw new DomainError('PLAN_TASK_CYCLE',502);if(done.has(tid))return;const task=tasks.find(t=>t.id===tid);if(!task)throw new DomainError('PLAN_TASK_DEPENDENCY_MISSING',502);visiting.add(tid);task.dependsOn.forEach(visit);visiting.delete(tid);done.add(tid);};tasks.forEach(t=>visit(t.id));
    if(hasSecret(JSON.stringify(plan)))throw new DomainError('P1_PLAN_SENSITIVE_OUTPUT',502);
    return structuredClone(plan) as unknown as ProjectPlan;
}
