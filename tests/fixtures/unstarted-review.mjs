// OFFLINE historical event fixture. Never native qualification or a real owner confirmation.
import {reviewWindowFixture} from './review-window.mjs';import {buildReviewPacket} from '../../dist/server/review-packet.js';import {hash} from '../../dist/server/security.js';
export async function unstartedReviewFixture(t,options={}){const x=await reviewWindowFixture(t,options);await x.h.engine.approveReviewWindow(x.r.id,x.request,x.actor);t.mock.timers.tick(3600001);
 const r=x.h.store.run(x.r.id);r.reason='RPC_EXPECTED_ECHO_LIMIT';r.calls=11;r.repairCount=r.maxRepairs;x.h.store.saveRun(r);
 const packet=buildReviewPacket(x.h.store,r,x.s),packetHash=hash(packet),dispatchId='OFFLINE_UNSTARTED_REVIEW',generation='OFFLINE_GENERATION',processId='OFFLINE_PROCESS';
 x.h.store.record('ReviewPreparationRecovery',r.projectId,r.id,{sourceHash:r.treeHash});
 x.h.store.record('ReviewPacket',r.projectId,r.id,{packet,sha256:packetHash});x.h.store.record('DispatchGranted',r.projectId,r.id,{kind:'reviewer',mode:'live',dispatchId,generation});
 x.h.store.record('OwnedProcessIntent',r.projectId,r.id,{dispatchId,generation,processId,platform:'win32'});
 x.h.store.event(r.projectId,r.id,'agent.event',{method:'dm/codexAdmission',params:{role:'reviewer',threadId:'OFFLINE_NEW_REVIEWER',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',includedUsageAllowed:true,paidFallback:false,permissionProfile:'dream-maker-supervisor-data',policyHash:'a'.repeat(64),reviewPacketHash:packetHash}});
 x.h.store.record('OwnedProcessCleanup',r.projectId,r.id,{dispatchId,generation,processId,cleanupReturned:true});x.h.store.record('DispatchFinished',r.projectId,r.id,{dispatchId,generation,outcome:'RPC_EXPECTED_ECHO_LIMIT',cleanupReturned:true});
 return {...x,r,dispatchId,packetHash};
}
