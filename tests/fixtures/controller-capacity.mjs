// Deterministic capacity for OFFLINE controller/fixture tests only. No native runner is enabled.
// Actual EngineDispatch admission/resource tests and real OS probes keep their measured resources.
export function fixedControllerCapacity(engine){
 engine.dispatch.binding.measure=()=>({cpu:2,memoryMiB:4096,availableMemoryMiB:5120,sampledAt:new Date().toISOString()});
}
/** A rejected/queued operation must never leave a test waiting on an entry that cannot happen. */
export async function fixtureEntered(entry,work,release=()=>{}){
 let timer;
 try{await Promise.race([entry,work.then(()=>{throw Error('OFFLINE_FIXTURE_COMPLETED_BEFORE_ENTRY');}),
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('OFFLINE_FIXTURE_ENTRY_TIMEOUT')),5000);})]);}
 catch(error){release();await work.catch(()=>{});throw error;}
 finally{clearTimeout(timer);}
}
