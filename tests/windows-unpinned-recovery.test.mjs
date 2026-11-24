// OFFLINE OS observation contract fixtures. Never qualifies a real process or model.
import test from 'node:test';import assert from 'node:assert/strict';
const base=639293327960559627n,ticks=n=>String(base+BigInt(n)),date=n=>new Date(Number((base-621355968000000000n)/10000n)+n).toISOString();
function fixture(){
 const jobId='windows_job_'+'a'.repeat(20),binding={jobId,parentPid:50,parentTicks:ticks(-1000),rootPid:99,rootTicks:ticks(0)};
 const observation={schema:'dream-maker.windows-job-os-snapshot.v1',enumeration:'TOOLHELP_FROZEN_LIST_WITH_BOUND_IDENTITIES',identitiesBound:true,bootTicks:ticks(-100000000),captureStartTicks:ticks(10000),at:date(1000),processCount:2,
 processes:[{pid:1,parent:0,session:0,createdTicks:ticks(-100000000),identityBasis:'HANDLE_BOUND_IDENTITY',image:'OFFLINE_PARENT'},
 {pid:2,parent:1,session:1,createdTicks:ticks(100),identityBasis:'POST_FREEZE_BOUND_IDENTITY',image:'OFFLINE_PROTECTED'}],
 jobs:[0,1].map(n=>({path:`\\Sessions\\${n}\\BaseNamedObjects\\DreamMaker_${jobId}`,status:'ABSENT',active:0})).concat({path:`\\BaseNamedObjects\\DreamMaker_${jobId}`,status:'ABSENT',active:0})};
 const clock={schema:'dream-maker.windows-clock-observation.v1',enabled:true,at:date(2000),oldestTime:'2020-01-01T00:00:00.000Z',limit:4097,changes:[],coverage:{classic:true,serviceRunning:true,servicePid:1,serviceCreatedTicks:ticks(-100000000),startRecord:{id:100,at:date(-3000)},lastRecordId:103,recordIds:[100,101,102,103],startRecordIds:[100],stopOrClearRecordIds:[],clockRecordIds:[]}};return{binding,observation,clock};
}
async function check(f){return(await import('../dist/server/flow/windows-job-recovery.js')).checkUnpinnedJobObservation(f.binding,f.observation,f.clock);}
test('complete frozen identities and all namespaces can prove an empty old tree without inventing a Pinned marker',async()=>{
 const f=fixture(),proof=await check(f);assert.equal(proof.jobId,f.binding.jobId);assert.equal(proof.basis,'FROZEN_PROCESS_ANCESTRY_AND_ALL_SESSION_JOBS');assert.equal(proof.postOriginProcesses,1);
});
for(const [name,alter,code] of [
 ['root still alive',f=>{f.observation.processes.push({pid:99,parent:1,session:1,createdTicks:ticks(0),identityBasis:'HANDLE_BOUND_IDENTITY',image:'OFFLINE_ROOT'});f.observation.processCount++;},'PROCESS_OWNERSHIP_ACTIVE'],
 ['original parent still alive',f=>{f.observation.processes.push({pid:50,parent:1,session:1,createdTicks:ticks(-1000),identityBasis:'HANDLE_BOUND_IDENTITY',image:'OFFLINE_OWNER'});f.observation.processCount++;},'PROCESS_OWNERSHIP_ACTIVE'],
 ['orphan compiler descendant',f=>{f.observation.processes[1].parent=777;},'WINDOWS_INTENT_OBSERVATION_UNPROVEN'],
 ['equal parent and child creation tick',f=>{f.observation.processes[0].createdTicks=f.observation.processes[1].createdTicks;},'WINDOWS_INTENT_OBSERVATION_UNPROVEN'],
 ['identity exactly at capture start',f=>{f.observation.processes[1].createdTicks=f.observation.captureStartTicks;},'WINDOWS_INTENT_OBSERVATION_UNPROVEN'],
 ['incomplete enumeration',f=>{f.observation.processCount++;},'WINDOWS_INTENT_OBSERVATION_UNPROVEN'],
 ['missing session lookup',f=>{f.observation.jobs.splice(1,1);},'WINDOWS_INTENT_OBSERVATION_UNPROVEN'],
 ['job has a live member',f=>{f.observation.jobs[1]={...f.observation.jobs[1],status:'QUERIED',active:1};},'PROCESS_OWNERSHIP_ACTIVE'],
 ['job query denied',f=>{f.observation.jobs[1].status='ACCESS_DENIED';},'WINDOWS_INTENT_OBSERVATION_UNPROVEN'],
 ['clock rollback',f=>{f.clock.changes.push({recordId:101,oldTime:date(1000),newTime:date(-1000)});f.clock.coverage.clockRecordIds=[101];},'WINDOWS_INTENT_OBSERVATION_UNPROVEN'],
 ['missing clock history',f=>{f.clock.oldestTime=date(500);},'WINDOWS_INTENT_OBSERVATION_UNPROVEN']
])test('unpinned recovery refuses '+name,async()=>{const f=fixture();alter(f);await assert.rejects(check(f),{code});});
test('PID reuse cannot give an old orphan a new parent',async()=>{
 const f=fixture();f.observation.processes.push({pid:777,parent:1,session:1,createdTicks:ticks(500),identityBasis:'HANDLE_BOUND_IDENTITY',image:'OFFLINE_REUSED'});f.observation.processCount++;f.observation.processes[1].parent=777;
 await assert.rejects(check(f),{code:'WINDOWS_INTENT_OBSERVATION_UNPROVEN'});
});
for(const [name,alter] of [
 ['missing coverage',f=>{delete f.clock.coverage;}],
 ['log record gap',f=>{f.clock.coverage.recordIds.splice(1,1);}],
 ['logging restarted',f=>{f.clock.coverage.startRecordIds.push(102);}],
 ['logging stopped or cleared',f=>{f.clock.coverage.stopOrClearRecordIds.push(102);}]
])test('history coverage refuses '+name,async()=>{const f=fixture();alter(f);await assert.rejects(check(f),{code:'WINDOWS_INTENT_OBSERVATION_UNPROVEN'});});
test('sub-millisecond clock rollback cannot pass a millisecond-rounded comparison',async()=>{
 const full=n=>{const value=base+BigInt(n),ms=Number((value-621355968000000000n)/10000n);return new Date(ms).toISOString().slice(0,19)+'.'+String(value%10000000n).padStart(7,'0')+'Z';};
 const f=fixture();f.clock.changes=[{recordId:101,oldTime:full(1000),newTime:full(500)}];f.clock.coverage.clockRecordIds=[101];
 assert.equal(Date.parse(f.clock.changes[0].oldTime),Date.parse(f.clock.changes[0].newTime));await assert.rejects(check(f),{code:'WINDOWS_INTENT_OBSERVATION_UNPROVEN'});
});
