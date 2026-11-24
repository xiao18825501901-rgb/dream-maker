// Explicit OFFLINE Store/Engine fixture. No Native qualification or real model.
import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {unstartedReviewFixture} from './unstarted-review.mjs';import {root} from '../helpers.mjs';
import {buildReviewPacket} from '../../dist/server/review-packet.js';import {hash} from '../../dist/server/security.js';
export async function reviewTransportRetryFixture(t,options={}){
 const x=await unstartedReviewFixture(t,{configure:h=>{h.config.codex.model='OFFLINE_CODEX';h.config.codex.permissionProfile='dream-maker-supervisor-data';h.config.codex.policyFile=join(h.dir,'readonly-policy.toml');writeFileSync(h.config.codex.policyFile,readFileSync(join(root,'config/codex-supervisor-windows.toml')));}});
 let r=x.h.store.run(x.r.id);await x.h.engine.approveReviewOnlyWindow(r.id,{confirmed:true,sourceHash:r.treeHash,expectedVersion:r.version,seconds:null},x.actor);
 if(options.sharedGeneration){x.h.store.record('DispatchGranted',x.p.id,r.id,{dispatchId:'OFFLINE_SAME_ENGINE_PRIOR',generation:'OFFLINE_TRANSPORT_GENERATION',kind:'reviewer',mode:'live'});x.h.store.record('DispatchFinished',x.p.id,r.id,{dispatchId:'OFFLINE_SAME_ENGINE_PRIOR',generation:'OFFLINE_TRANSPORT_GENERATION',outcome:'COMPLETED',cleanupReturned:true});}
 t.mock.timers.tick(1);r=x.h.store.run(r.id);r.reason='RUNNER_RPC_ERROR';r.calls=r.maxCalls-1;x.h.store.saveRun(r);
 const packet=buildReviewPacket(x.h.store,r,x.s),dispatchId='OFFLINE_TRANSPORT_REVIEW',generation='OFFLINE_TRANSPORT_GENERATION',processId='OFFLINE_TRANSPORT_PROCESS';
 x.h.store.record('ReviewPacket',x.p.id,r.id,{packet,sha256:hash(packet)});
 x.h.store.record('DispatchGranted',x.p.id,r.id,{dispatchId,generation,kind:'reviewer',mode:'live'});
 x.h.store.event(x.p.id,r.id,'role.dispatch',{state:'REVIEWING',phase:'REVIEWING'});
 x.h.store.record('OwnedProcessIntent',x.p.id,r.id,{dispatchId,generation,processId,platform:'win32'});
 x.h.store.event(x.p.id,r.id,'agent.event',{method:'dm/codexAdmission',params:{role:'reviewer',threadId:'OFFLINE_TRANSPORT_REVIEWER',model:'OFFLINE_CODEX',provider:'openai',authentication:'CHATGPT_SUBSCRIPTION',includedUsageAllowed:true,paidFallback:false,permissionProfile:'dream-maker-supervisor-data',policyHash:hash(readFileSync(x.h.config.codex.policyFile)),reviewPacketHash:hash(packet)}});
 x.h.store.record('OwnedProcessCleanup',x.p.id,r.id,{dispatchId,generation,processId,cleanupReturned:true});
 x.h.store.record('DispatchFinished',x.p.id,r.id,{dispatchId,generation,outcome:'RUNNER_RPC_ERROR',cleanupReturned:true});
 x.h.engine.nativeExecution={assertReady:()=>{},executor:()=>{throw Error('MODEL_FORBIDDEN');},verify:async()=>{throw Error('MODEL_FORBIDDEN');},close:async()=>{}};
 return {...x,r,dispatchId,generation,processId};
}
