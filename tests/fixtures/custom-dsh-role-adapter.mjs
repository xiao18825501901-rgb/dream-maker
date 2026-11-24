// OFFLINE bridge fixture, not DSH or model evidence. Does not write project source.
export async function capabilities(){return{fixture:true,verified:false};}
export async function run(input){
 if(!['planner2','executor','reviewer'].includes(input.role)||!(input.provider==='alternate-provider'?input.model==='alternate-model':['deepseek-flash','deepseek-v4-pro'].includes(input.model)))throw Error('OFFLINE_ROLE_OR_MODEL_MISMATCH');
 return{text:'OFFLINE_ROLE_'+input.role,sessionId:'OFFLINE_SESSION_'+input.role};
}
export async function close(){}
