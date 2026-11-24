import type { Project,PlanVersion } from '../shared/types.js';
import { hash } from './security.js';
/** Business input only: approval/state changes do not create a new paid planning request. */
export function projectPlanInput(p:Project){return {
    name:p.name,idea:p.idea,mode:p.mode,questions:p.questions,answers:p.answers,answerHistory:p.answerHistory,
    publicResearch:p.publicResearch??null,planner1Binding:p.planner1Binding??null,planner1AuthMode:p.planner1AuthMode??null,
    ...(p.planner1Mode?{planner1Mode:p.planner1Mode}:{}),
    ...(p.userSpendingRequired?{userSpendingRequired:true as const}:{}),
    ...(p.alternativeContext?{alternativeContext:p.alternativeContext}:{}),...(p.alternativeConstraints?{alternativeConstraints:p.alternativeConstraints}:{})
};}
export function samePlanInput(p:Project,source:PlanVersion['source']):boolean {
    const {provenance,...saved}=source;
    return provenance==='CURRENT_PROJECT_INPUT'&&hash(projectPlanInput(p))===hash(saved);
}
