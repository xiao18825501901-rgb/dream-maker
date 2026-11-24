import {requireCondition as need,text} from './common.mjs';
export function interviewPlanInput(state,description){
 text(description,'DESCRIPTION',20000);need(state.status==='ENDED','USER_MUST_END_INTERVIEW');
 const answers=Object.values(state.answers).filter(a=>!a.skipped);
 return {originalDescription:description,answers,answerCount:answers.length,sourceInterviewRevision:state.revision,unknownsMustBeAssumptions:true};
}
