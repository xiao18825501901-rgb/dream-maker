import type {Store} from './store.js';
import type {Run} from '../shared/types.js';
import {DomainError,hash,object} from './security.js';
import {runDeadline,reviewWindowEvidence,taskDeadlineWaiverEvidence} from './review-window.js';
import {unstartedReviewBasis} from './unstarted-review.js';

const PACKET_HASH=/^[a-f0-9]{64}$/,WIRE_PACKET_BYTES=512000;
const PRE_DISPATCH_PACKET_RECOVERY_REASONS=new Set(['REVIEW_PACKET_LIMIT','REVIEW_ROLE_EVIDENCE_REQUIRED']);
const REPAIR_PACKET_RECOVERY_REASONS=new Set(['REVIEW_PACKET_LIMIT','REVIEW_CUSTODY_EVIDENCE_INCOMPLETE']);
const POST_REVIEW_REPAIR_OUTCOMES=new Set(['COMPLETED','REVIEW_PREPARATION_REPLAY_INVALID','RUNNER_RPC_ERROR']);

/** Eligibility only. Engine must also rebuild byte-complete material, check owned
 * process cleanup, current approvals/source, and current native admission. No verdict is changed. */
export function reviewPreparationBasis(store:Store,run:Run,expectedPacketHash:string,options:{expiredWindowApproval?:boolean;allowPacketRebuild?:boolean}={}){
    const fail=():never=>{throw new DomainError('REVIEW_PREPARATION_RECOVERY_NOT_ALLOWED',409);};
    const preAdmission=run.reason==='REVIEW_ADMISSION_BINDING_INVALID';
    const probeBindingRecovery=run.reason==='NATIVE_PROBE_MISSING'||run.reason==='NATIVE_PROBE_BINDING_CHANGED';
    const coldInitializeRecovery=run.reason==='RPC_REQUEST_TIMEOUT';
    const customPreDispatch=run.flowName==='custom'&&run.flowConfig?.mode==='custom'&&
        run.reason==='REVIEW_ROLE_EVIDENCE_REQUIRED'&&!options.expiredWindowApproval&&!run.reviewWindow;
    if(!/^[a-f0-9]{64}$/.test(expectedPacketHash)||run.mode!=='live'||run.flowName!=='classic'&&!customPreDispatch||
        run.state!=='BLOCKED'||run.phase!=='REVIEWING'||![...PRE_DISPATCH_PACKET_RECOVERY_REASONS,'REVIEW_CUSTODY_EVIDENCE_INCOMPLETE','RPC_EXPECTED_ECHO_LIMIT','REVIEW_ADMISSION_BINDING_INVALID','NATIVE_PROBE_MISSING','NATIVE_PROBE_BINDING_CHANGED','RPC_REQUEST_TIMEOUT'].includes(run.reason??'')||run.review!==null||
        !run.tasks.length||run.tasks.some(t=>t.status!=='implemented')||
        !run.verification?.ok||run.verification.treeHash!==run.treeHash||
        (preAdmission?run.calls!==run.maxCalls:probeBindingRecovery?run.calls>run.maxCalls:run.calls>=run.maxCalls)||
        (!(preAdmission||probeBindingRecovery||coldInitializeRecovery)&&!options.expiredWindowApproval&&Date.now()>=runDeadline(store,run))||options.expiredWindowApproval&&run.reviewWindow!==undefined)return fail();
    const rows=store.db.prepare('SELECT id,kind,at,data FROM records WHERE project_id=? AND run_id=? ORDER BY rowid LIMIT 4097')
        .all(run.projectId,run.id).map(row=>({id:String(row.id),kind:String(row.kind),at:String(row.at),data:object(JSON.parse(String(row.data)))}));
    if(rows.length>4096)return fail();
    // Custom may recover only a first-packet construction failure. Never apply
    // Classic Codex replay/consumed-call recovery to a Custom runtime.
    if(customPreDispatch&&rows.some(row=>['ReviewPacket','Review','ReviewPreparationRecovery','ReviewPreparationReplayReservation'].includes(row.kind)||
        row.kind==='AgentSession'&&row.data.role==='reviewer'||row.kind.startsWith('Dispatch')&&row.data.kind==='reviewer'))return fail();
    if(coldInitializeRecovery){
        // The official app-server can time out before initialize completes. A
        // retry is allowed only after the exact Reviewer process is closed and
        // the original event trail proves no readiness, session, turn or effect.
        // Keep the failed attempt in history and spend the next approved call.
        if(options.expiredWindowApproval||run.calls>=run.maxCalls||run.repairCount>run.maxRepairs)return fail();
        const packets=rows.filter(row=>row.kind==='ReviewPacket'),reviewers=rows.filter(row=>row.kind==='DispatchGranted'&&row.data.kind==='reviewer');
        if(packets.length!==1||reviewers.length!==1)return fail();
        const packet=packets[0],grant=reviewers[0],savedHash=packet.data.sha256,body=object(packet.data.packet),history=body.sourceHistory;
        if(savedHash!==expectedPacketHash||hash(packet.data.packet)!==expectedPacketHash||
            body.schema!=='dream-maker.review-packet.v1'||body.runId!==run.id||body.specHash!==run.specHash||
            !Array.isArray(history)||object(history.at(-1)).treeHash!==run.treeHash||
            grant.data.mode!=='live'||typeof grant.data.dispatchId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(grant.data.dispatchId)||
            typeof grant.data.generation!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(grant.data.generation)||rows.indexOf(packet)>=rows.indexOf(grant))return fail();
        const dispatchId=String(grant.data.dispatchId),generation=String(grant.data.generation),
            finishes=rows.filter(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===dispatchId),
            processes=rows.filter(row=>row.kind==='OwnedProcessIntent'&&row.data.dispatchId===dispatchId);
        if(finishes.length!==1||finishes[0].data.outcome!=='RPC_REQUEST_TIMEOUT'||finishes[0].data.cleanupReturned!==true||
            finishes[0].data.generation!==generation||rows.indexOf(finishes[0])<=rows.indexOf(grant)||
            processes.length!==1||processes[0].data.platform!=='win32'||processes[0].data.generation!==generation||
            typeof processes[0].data.processId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(processes[0].data.processId)||
            rows.indexOf(processes[0])<=rows.indexOf(grant)||rows.indexOf(processes[0])>=rows.indexOf(finishes[0])||
            rows.filter(row=>row.kind==='OwnedProcessIntent'&&row.data.processId===processes[0].data.processId).length!==1)return fail();
        const cleanups=rows.filter(row=>row.kind==='OwnedProcessCleanup'&&row.data.processId===processes[0].data.processId);
        if(cleanups.length!==1||cleanups[0].data.dispatchId!==dispatchId||cleanups[0].data.generation!==generation||
            cleanups[0].data.cleanupReturned!==true||rows.indexOf(cleanups[0])<=rows.indexOf(processes[0])||
            rows.indexOf(cleanups[0])>=rows.indexOf(finishes[0])||
            run.roleIdentities?.reviewer||run.sessions.reviewer||
            rows.some(row=>row.kind==='ReviewPreparationRecovery'||row.kind==='ReviewPreparationReplayReservation'||row.kind==='Review'||
                row.kind==='AgentSession'&&(row.data.role==='reviewer'||row.data.dispatchId===dispatchId)||
                (row.kind==='ToolIntent'||row.kind==='ToolResult')&&row.data.dispatchId===dispatchId))return fail();
        const events=store.db.prepare('SELECT id,type,at,payload FROM events WHERE project_id=? AND run_id=? AND at>=? ORDER BY id LIMIT 1001')
            .all(run.projectId,run.id,grant.at).map(row=>({id:Number(row.id),type:String(row.type),at:String(row.at),data:object(JSON.parse(String(row.payload)))}));
        if(events.length>1000||events.length<4)return fail();
        const roleDispatches=events.filter(event=>event.type==='role.dispatch'),blocked=events.at(-1),
            preparations=events.filter(event=>event.type==='agent.event'&&event.data.method==='dm/codexPreparation');
        if(roleDispatches.length!==1||roleDispatches[0].data.state!=='REVIEWING'||roleDispatches[0].data.phase!=='REVIEWING'||
            !blocked||blocked.type!=='run.blocked'||blocked.data.state!=='BLOCKED'||blocked.data.phase!=='REVIEWING'||blocked.data.reason!=='RPC_REQUEST_TIMEOUT'||
            events.some(event=>!['role.dispatch','agent.event','run.blocked'].includes(event.type))||
            events.some(event=>event.type==='agent.event'&&![
                'dm/codexNetworkPath','dm/codexPreparation',
            ].includes(String(event.data.method))||event.data.method==='dm/codexPreparation'&&object(event.data.params??{}).role!=='reviewer'))return fail();
        const started=preparations.filter(event=>object(event.data.params).method==='initialize'&&object(event.data.params).status==='STARTED'),
            failed=preparations.filter(event=>object(event.data.params).method==='initialize'&&object(event.data.params).status==='FAILED');
        if(preparations.length!==2||started.length!==1||failed.length!==1)return fail();
        const startedAt=Date.parse(started[0].at),failedAt=Date.parse(failed[0].at),blockedAt=Date.parse(blocked.at),grantAt=Date.parse(grant.at);
        const startParams=object(started[0].data.params),failParams=object(failed[0].data.params);
        if(![grantAt,startedAt,failedAt,blockedAt].every(Number.isFinite)||!(grantAt<=startedAt&&startedAt<=failedAt&&failedAt<=blockedAt)||
            !Number.isSafeInteger(startParams.timeoutMs)||Number(startParams.timeoutMs)<1000||Number(startParams.timeoutMs)>90000||
            failParams.timeoutMs!==undefined&&failParams.timeoutMs!==startParams.timeoutMs||failParams.code!=='RPC_REQUEST_TIMEOUT'||
            !Number.isSafeInteger(failParams.elapsedMs)||Number(failParams.elapsedMs)<Number(startParams.timeoutMs))return fail();
        return {packetHash:expectedPacketHash,packetRecordId:packet.id,savedPacketHash:expectedPacketHash,
            dispatchId,preDispatch:false,preparationFailure:run.reason,replayConsumedCall:false,
            coldInitializeRecovery:true,dispatchIds:[dispatchId],basisHash:hash({rows,events}),version:run.version};
    }
    if(probeBindingRecovery){
        // A Reviewer dispatch can reach the local probe gate after the source or
        // configuration has changed. That failure occurs before a process exists,
        // before turn/start and before any Review or AgentSession. Reuse the same
        // already-consumed call once; any earlier model/tool side effect refuses it.
        const packets=rows.filter(row=>row.kind==='ReviewPacket'),
            markers=rows.filter(row=>row.kind==='ReviewPreparationRecovery'&&row.data.sourceHash===run.treeHash),
            reservations=rows.filter(row=>row.kind==='ReviewPreparationReplayReservation'),
            reviewers=rows.filter(row=>row.kind==='DispatchGranted'&&row.data.kind==='reviewer');
        if(packets.length!==2||markers.length!==1||reservations.length!==1||reviewers.length!==2)return fail();
        const marker=markers[0],reservation=reservations[0],first=reviewers[0],second=reviewers[1],
            saved=packets[1],oldPacket=packets[0];
        const coldProbeBindingRecovery=marker.data.replayConsumedCall===false&&marker.data.coldInitializeRecovery===true;
        // Chained cold-init-timeout variant: the persisted marker was written by
        // an earlier attempt that consumed one call, so the run has exactly one
        // more call than the marker records, and no repair has been consumed.
        if(options.expiredWindowApproval||
            (coldProbeBindingRecovery?run.repairCount>run.maxRepairs:run.repairCount!==run.maxRepairs))return fail();
        if(coldProbeBindingRecovery?run.calls!==Number(marker.data.calls)+1:run.calls!==run.maxCalls)return fail();
        if(saved.data.sha256!==expectedPacketHash||hash(saved.data.packet)!==expectedPacketHash||
            object(saved.data.packet).runId!==run.id||object(saved.data.packet).specHash!==run.specHash||
            object(saved.data.packet).schema!=='dream-maker.review-packet.v1'||
            marker.data.preparationFailure!==(coldProbeBindingRecovery?'RPC_REQUEST_TIMEOUT':'REVIEW_ADMISSION_BINDING_INVALID')||marker.data.replayConsumedCall!==(coldProbeBindingRecovery?false:true)||
            marker.data.modelDispatched!==false||marker.data.packetHash!==expectedPacketHash||
            marker.data.sourceHash!==run.treeHash||marker.data.specHash!==run.specHash||
            marker.data.planVersionHash!==run.planVersionHash||
            (coldProbeBindingRecovery?Number(marker.data.calls)+1!==run.calls:marker.data.calls!==run.calls)||
            marker.data.repairCount!==run.repairCount||marker.data.createdAt!==run.createdAt||marker.data.maxSeconds!==run.maxSeconds||
            !Array.isArray(marker.data.dispatchIds)||marker.data.dispatchIds.length!==1||marker.data.dispatchId!==marker.data.dispatchIds[0]||
            typeof first.data.dispatchId!=='string'||first.data.dispatchId!==marker.data.dispatchId||first.data.mode!=='live')return fail();
        const firstFinish=rows.filter(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===first.data.dispatchId),
            secondFinish=rows.filter(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===second.data.dispatchId);
        if(firstFinish.length!==1||firstFinish[0].data.outcome!==(coldProbeBindingRecovery?'RPC_REQUEST_TIMEOUT':'REVIEW_ADMISSION_BINDING_INVALID')||
            firstFinish[0].data.cleanupReturned!==true||firstFinish[0].data.generation!==first.data.generation||
            secondFinish.length!==1||!['NATIVE_PROBE_MISSING','NATIVE_PROBE_BINDING_CHANGED'].includes(String(secondFinish[0].data.outcome))||
            secondFinish[0].data.outcome!==run.reason||secondFinish[0].data.cleanupReturned!==true||
            secondFinish[0].data.generation!==second.data.generation||second.data.mode!=='live'||
            reservation.data.dispatchId!==second.data.dispatchId||reservation.data.generation!==second.data.generation||
            reservation.data.approvalRecordId!==marker.id||
            reservation.data.packetRecordId!==(coldProbeBindingRecovery?oldPacket.id:saved.id)||
            reservation.data.sourceHash!==run.treeHash||reservation.data.specHash!==run.specHash||reservation.data.role!=='reviewer'||
            reservation.data.modelDispatched!==false||rows.indexOf(second)<=rows.indexOf(saved)||
            rows.indexOf(reservation)<=rows.indexOf(second)||rows.indexOf(secondFinish[0])<=rows.indexOf(reservation))return fail();
        if(rows.some(row=>(row.kind==='OwnedProcessIntent'||row.kind==='ToolIntent'||row.kind==='ToolResult')&&row.data.dispatchId===second.data.dispatchId)||
            run.roleIdentities?.reviewer||run.sessions.reviewer||rows.some(row=>
                row.kind==='Review'||
                row.kind==='AgentSession'&&(row.data.role==='reviewer'||row.data.dispatchId===second.data.dispatchId)))return fail();
        if(rows.some(row=>row.kind==='ReviewPreparationReplayReservation'&&row.id!==reservation.id))return fail();
        if(marker.data.packetRebuilt===true){
            if(typeof marker.data.previousPacketRecordId!=='string'||marker.data.previousPacketRecordId!==oldPacket.id||
                marker.data.previousPacketHash!==oldPacket.data.sha256||hash(oldPacket.data.packet)!==oldPacket.data.sha256)return fail();
        }else if(marker.data.packetRecordId!==(coldProbeBindingRecovery?oldPacket.id:saved.id)){return fail();}
        if(rows.some(row=>row.kind==='ReviewPacket'&&rows.indexOf(row)>rows.indexOf(second)))return fail();
        if(rows.some(grant=>grant.kind==='DispatchGranted'&&!rows.some(finish=>
            finish.kind==='DispatchFinished'&&finish.data.dispatchId===grant.data.dispatchId&&
            finish.data.generation===grant.data.generation&&finish.data.cleanupReturned===true)))return fail();
        const events=store.db.prepare('SELECT id,type,at,payload FROM events WHERE project_id=? AND run_id=? ORDER BY id LIMIT 4097')
            .all(run.projectId,run.id).map(row=>({id:Number(row.id),type:String(row.type),at:String(row.at),data:object(JSON.parse(String(row.payload)))}));
        if(events.length>4096||events.some(row=>row.type==='agent.event'&&object(row.data.params??{}).role==='reviewer'&&
            ['turn/start','dm/codexAdmission','dm/codexCompletion'].includes(String(object(row.data.params??{}).method))))return fail();
        const blocked=events.filter(row=>row.type==='run.blocked').at(-1);
        if(!blocked||blocked.data.state!=='BLOCKED'||blocked.data.phase!=='REVIEWING'||blocked.data.reason!==run.reason)return fail();
        return {packetHash:expectedPacketHash,packetRecordId:saved.id,savedPacketHash:expectedPacketHash,packetRebuilt:false,
            dispatchId:String(second.data.dispatchId),preDispatch:false,preparationFailure:run.reason,replayConsumedCall:coldProbeBindingRecovery?false:true,
            ...(coldProbeBindingRecovery?{coldInitializeRecovery:true}:{}),probeBindingRecovery:true,
            dispatchIds:[String(first.data.dispatchId),String(second.data.dispatchId)],
            basisHash:hash({rows,events}),version:run.version};
    }
    if(preAdmission){
        // The official app-server acknowledged thread/start, but the local
        // admission wrapper refused the request before turn/start. Reuse only
        // that already-consumed call once, after the original process is
        // proven closed and no model/tool/session side effect exists.
        if(options.expiredWindowApproval||run.repairCount!==run.maxRepairs)return fail();
        const packets=rows.filter(row=>row.kind==='ReviewPacket'),saved=packets.at(-1);
        const grants=rows.filter(row=>row.kind==='DispatchGranted'),reviewers=grants.filter(row=>row.data.kind==='reviewer');
        if(packets.length!==1||!saved||reviewers.length!==1)return fail();
        const packet=object(saved.data.packet),granted=reviewers[0],savedPacketHash=saved.data.sha256;
        if(typeof savedPacketHash!=='string'||!PACKET_HASH.test(savedPacketHash)||hash(packet)!==savedPacketHash)return fail();
        const packetRebuilt=expectedPacketHash!==savedPacketHash;
        if(packetRebuilt&&(options.allowPacketRebuild!==true||Buffer.byteLength(JSON.stringify(packet))<=WIRE_PACKET_BYTES))return fail();
        if(packet.runId!==run.id||packet.specHash!==run.specHash||packet.schema!=='dream-maker.review-packet.v1'||
            granted.data.mode!=='live'||typeof granted.data.dispatchId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(granted.data.dispatchId)||
            typeof granted.data.generation!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(granted.data.generation))return fail();
        const dispatchId=granted.data.dispatchId,generation=granted.data.generation;
        const finishes=rows.filter(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===dispatchId);
        if(finishes.length!==1||finishes[0].data.outcome!=='REVIEW_ADMISSION_BINDING_INVALID'||finishes[0].data.cleanupReturned!==true||
            finishes[0].data.generation!==generation||rows.indexOf(finishes[0])<=rows.indexOf(granted))return fail();
        const processes=rows.filter(row=>row.kind==='OwnedProcessIntent'&&row.data.dispatchId===dispatchId);
        if(processes.length!==1||rows.indexOf(processes[0])<=rows.indexOf(granted)||rows.indexOf(processes[0])>=rows.indexOf(finishes[0]))return fail();
        const process=processes[0].data;
        if(process.platform!=='win32'||typeof process.processId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(process.processId)||
            process.generation!==generation||rows.filter(row=>row.kind==='OwnedProcessIntent'&&row.data.processId===process.processId).length!==1)return fail();
        const cleanups=rows.filter(row=>row.kind==='OwnedProcessCleanup'&&row.data.processId===process.processId);
        if(cleanups.length!==1||cleanups[0].data.dispatchId!==dispatchId||cleanups[0].data.generation!==generation||
            cleanups[0].data.cleanupReturned!==true||rows.indexOf(cleanups[0])<=rows.indexOf(processes[0])||
            rows.indexOf(cleanups[0])>=rows.indexOf(finishes[0]))return fail();
        if(run.roleIdentities?.reviewer||run.sessions.reviewer||rows.some(row=>
            row.kind==='ReviewPreparationRecovery'||row.kind==='ReviewPreparationReplayReservation'||
            row.kind==='Review'||
            row.kind==='AgentSession'&&(row.data.role==='reviewer'||row.data.dispatchId===dispatchId)||
            (row.kind==='ToolIntent'||row.kind==='ToolResult')&&row.data.dispatchId===dispatchId))return fail();
        const events=store.db.prepare('SELECT id,type,at,payload FROM events WHERE project_id=? AND run_id=? AND at>=? ORDER BY id LIMIT 1001')
            .all(run.projectId,run.id,granted.at).map(row=>({id:Number(row.id),type:String(row.type),at:String(row.at),data:object(JSON.parse(String(row.payload)))}));
        const blocked=events.at(-1);
        if(events.length>1000||!blocked||blocked.type!=='run.blocked'||
            blocked.data.state!=='BLOCKED'||blocked.data.phase!=='REVIEWING'||blocked.data.reason!=='REVIEW_ADMISSION_BINDING_INVALID')return fail();
        const roleDispatches=events.filter(event=>event.type==='role.dispatch'),roleDispatch=roleDispatches[0],
            grantAt=Date.parse(granted.at),roleDispatchAt=roleDispatch?Date.parse(roleDispatch.at):NaN,
            processAt=Date.parse(processes[0].at),finishAt=Date.parse(finishes[0].at);
        if(roleDispatches.length!==1||!roleDispatch||roleDispatch.data.role!==undefined&&roleDispatch.data.role!=='reviewer'||
            roleDispatch.data.state!=='REVIEWING'||roleDispatch.data.phase!=='REVIEWING'||roleDispatch.data.attempt!==run.attempt||
            roleDispatch.data.reason!==null||![grantAt,roleDispatchAt,processAt,finishAt].every(Number.isFinite)||
            grantAt>roleDispatchAt||roleDispatchAt>processAt||processAt>finishAt)return fail();
        const preparation=events.filter(event=>event.type==='agent.event'&&event.data.method==='dm/codexPreparation'&&object(event.data.params??{}).role==='reviewer');
        if(preparation.some(event=>{
            const value=object(event.data.params??{});
            return value.method==='turn/start'||value.method==='dm/codexAdmission'||value.method==='dm/codexCompletion'||
                value.status==='FAILED'&&value.code==='REVIEW_ADMISSION_BINDING_INVALID';
        })||!preparation.some(event=>object(event.data.params??{}).method==='thread/start'&&object(event.data.params??{}).status==='COMPLETED')||
            events.some(event=>event.type!=='run.blocked'&&event.type!=='agent.event'&&event.id!==roleDispatch.id)||
            events.some(event=>event.type==='agent.event'&&(event.data.method!=='dm/codexPreparation'||object(event.data.params??{}).role!=='reviewer')))return fail();
        return {packetHash:expectedPacketHash,packetRecordId:packetRebuilt?null:saved.id,savedPacketHash,packetRebuilt,
            ...(packetRebuilt?{previousPacketRecordId:saved.id,previousPacketHash:savedPacketHash}:{}),
            dispatchId,preDispatch:false,preparationFailure:run.reason,replayConsumedCall:true,
            dispatchIds:[dispatchId],basisHash:hash({rows,events}),version:run.version};
    }
    if(run.reason==='RPC_EXPECTED_ECHO_LIMIT'){
        if(options.expiredWindowApproval||!run.reviewOnlyWindow)return fail();
        const typed=unstartedReviewBasis(store,run),markers=rows.filter(row=>row.kind==='ReviewPreparationRecovery'&&row.data.sourceHash===run.treeHash);
        if(markers.length!==1||markers[0].data.preparationFailure==='RPC_EXPECTED_ECHO_LIMIT')return fail();
        const grants=rows.filter(row=>row.kind==='DispatchGranted');
        if(grants.some(g=>!rows.some(f=>f.kind==='DispatchFinished'&&f.data.dispatchId===g.data.dispatchId&&f.data.generation===g.data.generation&&f.data.cleanupReturned===true)))return fail();
        return {packetHash:expectedPacketHash,packetRecordId:typed.packetRecordId,savedPacketHash:typed.packetHash,dispatchId:typed.dispatchId,preDispatch:true,
            preparationFailure:run.reason,dispatchIds:grants.map(g=>String(g.data.dispatchId)),basisHash:typed.basisHash,version:run.version};
    }
    if(rows.some(row=>row.kind==='Review')){
        const reviews=rows.filter(row=>row.kind==='Review'),packets=rows.filter(row=>row.kind==='ReviewPacket'),saved=packets.at(-1),
            grants=rows.filter(row=>row.kind==='DispatchGranted'),grant=grants.at(-1);
        const oldReview=reviews[0],oldPacket=saved&&object(saved.data.packet),oldHistory=oldPacket?.sourceHistory;
        if(options.allowPacketRebuild===true&&reviews.length===1&&packets.length===1&&oldReview&&saved&&
            oldReview.data.source==='CODEX'&&oldReview.data.verdict==='CHANGES_REQUESTED'&&
            typeof oldReview.data.treeHash==='string'&&PACKET_HASH.test(oldReview.data.treeHash)&&oldReview.data.treeHash!==run.treeHash&&
            Array.isArray(oldHistory)&&object(oldHistory.at(-1)).treeHash===oldReview.data.treeHash&&saved.data.sha256!==expectedPacketHash){
            // A real Reviewer already reviewed the parent source. The Executor and
            // verifier completed a repair, but constructing the final packet then
            // failed before a current-source Reviewer dispatch. Rebuild only the
            // material; preserve the old Review and reserve a new Reviewer call.
            if(run.repairCount<1||!run.sessions.reviewer||run.roleIdentities?.reviewer?.sessionId!==run.sessions.reviewer||
                run.roleIdentities.reviewer.runner!=='CODEX_CLI'||typeof run.roleIdentities.reviewer.model!=='string'||!run.roleIdentities.reviewer.model||
                typeof saved.data.sha256!=='string'||!PACKET_HASH.test(saved.data.sha256)||hash(saved.data.packet)!==saved.data.sha256||
                oldPacket!.schema!=='dream-maker.review-packet.v1'||oldPacket!.runId!==run.id||oldPacket!.specHash!==run.specHash||
                rows.some(row=>row.kind==='ReviewPreparationRecovery'&&row.data.sourceHash===run.treeHash))return fail();
            const afterReview=rows.slice(rows.indexOf(oldReview)+1),
                queued=afterReview.filter(row=>row.kind==='DispatchQueued'),
                postGrants=afterReview.filter(row=>row.kind==='DispatchGranted'),
                dispatchIds=postGrants.map(row=>String(row.data.dispatchId));
            if(!postGrants.length||dispatchIds.some(value=>!/^[A-Za-z0-9_-]{1,200}$/.test(value))||new Set(dispatchIds).size!==dispatchIds.length||
                !postGrants.some(row=>row.data.kind==='executor')||!postGrants.some(row=>row.data.kind==='verifier')||
                postGrants.some(row=>!['executor','verifier'].includes(String(row.data.kind)))||
                afterReview.some(row=>['DispatchQueued','DispatchGranted','DispatchFinished'].includes(row.kind)&&row.data.kind==='reviewer')||
                afterReview.some(row=>row.kind==='AgentSession'&&row.data.role==='reviewer'))return fail();
            for(const queuedDispatch of queued){
                const matches=postGrants.filter(row=>row.data.dispatchId===queuedDispatch.data.dispatchId);
                if(matches.length!==1||matches[0].data.kind!==queuedDispatch.data.kind||
                    matches[0].data.generation!==queuedDispatch.data.generation||rows.indexOf(matches[0])<=rows.indexOf(queuedDispatch))return fail();
            }
            for(const postGrant of postGrants){
                const dispatchId=String(postGrant.data.dispatchId),generation=String(postGrant.data.generation),
                    queueMatches=queued.filter(row=>row.data.dispatchId===dispatchId),
                    finishes=afterReview.filter(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===dispatchId);
                if(!/^[A-Za-z0-9_-]{1,200}$/.test(generation)||queueMatches.length!==1||finishes.length!==1||
                    finishes[0].data.outcome!=='COMPLETED'||finishes[0].data.cleanupReturned!==true||
                    finishes[0].data.generation!==generation||rows.indexOf(finishes[0])<=rows.indexOf(postGrant))return fail();
            }
            if(queued.length!==postGrants.length||afterReview.some(row=>row.kind==='DispatchFinished'&&!dispatchIds.includes(String(row.data.dispatchId))))return fail();
            const step=afterReview.filter(row=>row.kind==='Step').at(-1);
            if(!step||step.data.phase!=='REVIEWING'||step.data.specHash!==run.specHash||
                step.data.treeHash!==run.treeHash||step.data.attempt!==run.attempt)return fail();
            const events=store.db.prepare('SELECT id,type,at,payload FROM events WHERE project_id=? AND run_id=? ORDER BY id LIMIT 4097')
                .all(run.projectId,run.id).map(row=>({id:Number(row.id),type:String(row.type),at:String(row.at),data:object(JSON.parse(String(row.payload)))}));
            let phaseIndex=-1;for(let index=events.length-1;index>=0;index--){if(events[index].type==='run.phase'){phaseIndex=index;break;}}
            let blockedIndex=events.length-1,window=null;
            if(run.reviewWindow!==undefined){
                try{window=reviewWindowEvidence(store,run);}catch{return fail();}
                const tail=events.at(-1);
                if(!window||window.sourceHash!==run.treeHash||window.evidenceId!==run.verification.evidenceId||
                    (window.packetHash!==expectedPacketHash&&options.allowPacketRebuild!==true)||
                    !tail||tail.type!=='run.review-window.approved'||
                    tail.data.recordId!==run.reviewWindow.recordId||tail.data.sha256!==run.reviewWindow.sha256)return fail();
                blockedIndex--;
            }
            const blocked=events[blockedIndex],phaseEvent=phaseIndex>=0?events[phaseIndex]:undefined,
                afterPhase=phaseIndex>=0?events.slice(phaseIndex+1,blockedIndex):[];
            if(events.length>4096||!phaseEvent||phaseEvent.data.state!=='REVIEWING'||phaseEvent.data.phase!=='REVIEWING'||
                afterPhase.length!==1||afterPhase[0].type!=='step.started'||
                afterPhase[0].data.state!=='REVIEWING'||afterPhase[0].data.phase!=='REVIEWING'||
                !blocked||blocked.type!=='run.blocked'||blocked.data.state!=='BLOCKED'||
                blocked.data.phase!=='REVIEWING'||!REPAIR_PACKET_RECOVERY_REASONS.has(String(blocked.data.reason)))return fail();
            return {packetHash:expectedPacketHash,approvalPacketHash:window?.packetHash??null,packetRecordId:null,savedPacketHash:String(saved.data.sha256),packetRebuilt:true,
                previousPacketRecordId:saved.id,previousPacketHash:String(saved.data.sha256),dispatchId:null,preDispatch:true,
                preparationFailure:run.reason,replayConsumedCall:false,dispatchIds,basisHash:hash({rows,events}),version:run.version};
        }
        if(options.allowPacketRebuild===true&&reviews.length>=2){
            // A long-running Classic can complete more than one real Reviewer
            // cycle. Rebuild only the final packet after proving each historical
            // packet/session/review and every post-review dispatch is closed.
            const firstReview=reviews[0]!,lastReview=reviews.at(-1)!,
                reviewerSessions=rows.filter(row=>row.kind==='AgentSession'&&row.data.role==='reviewer'),
                reviewerGrants=grants.filter(row=>row.data.kind==='reviewer');
            if(!saved||packets.length!==reviews.length||reviewerSessions.length!==reviews.length||reviewerGrants.length!==reviews.length||
                run.repairCount<reviews.length||run.repairCount>run.maxRepairs||!run.sessions.reviewer||
                run.roleIdentities?.reviewer?.sessionId!==run.sessions.reviewer||run.roleIdentities.reviewer.runner!=='CODEX_CLI'||
                typeof run.roleIdentities.reviewer.model!=='string'||!run.roleIdentities.reviewer.model||
                typeof saved.data.sha256!=='string'||!PACKET_HASH.test(saved.data.sha256)||hash(saved.data.packet)!==saved.data.sha256||
                saved.data.sha256===expectedPacketHash||
                rows.some(row=>row.kind==='ReviewPreparationRecovery'&&row.data.sourceHash===run.treeHash)||
                rows.some(row=>row.kind==='ReviewPreparationReplayReservation'&&row.data.sourceHash===run.treeHash))return fail();
            const reviewHashes=reviews.map(row=>row.data.treeHash),
                sessionIds=reviewerSessions.map(row=>row.data.sessionId);
            if(reviewHashes.some(value=>typeof value!=='string'||!PACKET_HASH.test(value)||value===run.treeHash)||
                new Set(reviewHashes).size!==reviewHashes.length||
                sessionIds.some(value=>typeof value!=='string'||!value)||new Set(sessionIds).size!==sessionIds.length||
                sessionIds.at(-1)!==run.sessions.reviewer)return fail();
            for(let index=0;index<reviews.length;index++){
                const review=reviews[index]!,packet=packets[index]!,grant=reviewerGrants[index]!,session=reviewerSessions[index]!,
                    packetBody=object(packet.data.packet),history=packetBody.sourceHistory,
                    packetHash=packet.data.sha256,reviewHash=review.data.treeHash,
                    dispatchId=grant.data.dispatchId,generation=grant.data.generation;
                if(typeof packetHash!=='string'||!PACKET_HASH.test(packetHash)||hash(packet.data.packet)!==packetHash||
                    packetBody.schema!=='dream-maker.review-packet.v1'||packetBody.runId!==run.id||packetBody.specHash!==run.specHash||
                    !Array.isArray(history)||object(history.at(-1)).treeHash!==reviewHash||
                    review.data.source!=='CODEX'||review.data.verdict!=='CHANGES_REQUESTED'||review.data.packetHash!==packetHash||
                    grant.data.mode!=='live'||typeof dispatchId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(dispatchId)||
                    typeof generation!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(generation)||session.data.dispatchId!==dispatchId||
                    typeof session.data.sessionId!=='string'||session.data.sessionId!==sessionIds[index])return fail();
                const queued=rows.filter(row=>row.kind==='DispatchQueued'&&row.data.dispatchId===dispatchId),
                    finishes=rows.filter(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===dispatchId),finish=finishes[0];
                if(queued.length!==1||queued[0].data.kind!=='reviewer'||queued[0].data.mode!=='live'||queued[0].data.generation!==generation||
                    finishes.length!==1||!finish||finish.data.outcome!=='COMPLETED'||finish.data.cleanupReturned!==true||
                    finish.data.generation!==generation||rows.indexOf(packet)>=rows.indexOf(queued[0])||
                    rows.indexOf(queued[0])>=rows.indexOf(grant)||rows.indexOf(grant)>=rows.indexOf(finish)||
                    rows.indexOf(finish)>=rows.indexOf(session)||rows.indexOf(session)>=rows.indexOf(review))return fail();
            }
            const firstReviewIndex=rows.indexOf(firstReview),lastReviewIndex=rows.indexOf(lastReview),afterFirst=rows.slice(firstReviewIndex+1),afterLast=rows.slice(lastReviewIndex+1),
                postQueues=afterFirst.filter(row=>row.kind==='DispatchQueued'),
                postGrants=afterFirst.filter(row=>row.kind==='DispatchGranted'),
                postFinishes=afterFirst.filter(row=>row.kind==='DispatchFinished'),
                reviewerGrantIds=new Set(reviewerGrants.map(row=>String(row.data.dispatchId)));
            if(afterLast.some(row=>row.kind==='AgentSession'&&row.data.role==='reviewer'||
                ['DispatchQueued','DispatchGranted','DispatchFinished'].includes(row.kind)&&row.data.kind==='reviewer')||
                postQueues.length!==postGrants.length||postFinishes.length!==postGrants.length)return fail();
            for(const grant of postGrants){
                const dispatchId=String(grant.data.dispatchId),generation=String(grant.data.generation),kind=String(grant.data.kind),
                    queued=postQueues.filter(row=>row.data.dispatchId===dispatchId),
                    finishes=postFinishes.filter(row=>row.data.dispatchId===dispatchId),finish=finishes[0];
                if(!/^[A-Za-z0-9_-]{1,200}$/.test(dispatchId)||!['reviewer','executor','verifier'].includes(kind)||
                    queued.length!==1||queued[0].data.kind!==kind||queued[0].data.mode!=='live'||queued[0].data.generation!==generation||
                    finishes.length!==1||!finish||finish.data.generation!==generation||finish.data.cleanupReturned!==true||
                    rows.indexOf(queued[0])>=rows.indexOf(grant)||rows.indexOf(grant)>=rows.indexOf(finish)||
                    !POST_REVIEW_REPAIR_OUTCOMES.has(String(finish.data.outcome))||kind==='reviewer'&&!reviewerGrantIds.has(dispatchId))return fail();
                if(kind!=='reviewer'&&finish.data.outcome!=='COMPLETED'){
                    if(rows.some(row=>row.data.dispatchId===dispatchId&&(row.kind==='AgentSession'||row.kind==='ToolIntent'||row.kind==='ToolResult')))return fail();
                    for(const process of rows.filter(row=>row.kind==='OwnedProcessIntent'&&row.data.dispatchId===dispatchId)){
                        const cleanups=rows.filter(row=>row.kind==='OwnedProcessCleanup'&&row.data.processId===process.data.processId);
                        if(cleanups.length!==1||cleanups[0].data.dispatchId!==dispatchId||cleanups[0].data.generation!==generation||
                            cleanups[0].data.cleanupReturned!==true||rows.indexOf(cleanups[0])<=rows.indexOf(process)||rows.indexOf(cleanups[0])>=rows.indexOf(finish))return fail();
                    }
                }
            }
            const lastGrants=afterLast.filter(row=>row.kind==='DispatchGranted'),lastFinishes=afterLast.filter(row=>row.kind==='DispatchFinished');
            if(!lastGrants.length||lastGrants.some(row=>row.data.kind!=='executor'&&row.data.kind!=='verifier')||
                !lastGrants.some(grant=>grant.data.kind==='executor'&&lastFinishes.some(finish=>finish.data.dispatchId===grant.data.dispatchId&&finish.data.outcome==='COMPLETED'))||
                !lastGrants.some(grant=>grant.data.kind==='verifier'&&lastFinishes.some(finish=>finish.data.dispatchId===grant.data.dispatchId&&finish.data.outcome==='COMPLETED')))return fail();
            const step=afterLast.filter(row=>row.kind==='Step').at(-1);
            if(!step||step.data.phase!=='REVIEWING'||step.data.specHash!==run.specHash||step.data.treeHash!==run.treeHash||step.data.attempt!==run.attempt)return fail();
            const events=store.db.prepare('SELECT id,type,at,payload FROM events WHERE project_id=? AND run_id=? ORDER BY id LIMIT 4097')
                .all(run.projectId,run.id).map(row=>({id:Number(row.id),type:String(row.type),at:String(row.at),data:object(JSON.parse(String(row.payload)))}));
            if(events.length>4096)return fail();
            const waiver=taskDeadlineWaiverEvidence(store,run),waiverRef=run.taskDeadlineWaiver!,lastReviewAt=Date.parse(lastReview.at);
            if(!waiver||!Number.isFinite(lastReviewAt)||
                events.filter(row=>row.type==='run.task-deadline-waiver.approved'&&row.data.recordId===waiverRef.recordId&&
                    row.data.sha256===waiverRef.sha256).length!==1)return fail();
            if(run.reviewWindow!==undefined){
                const windowRef=run.reviewWindow,window=reviewWindowEvidence(store,run);
                if(!window||events.filter(row=>row.type==='run.review-window.approved'&&row.data.recordId===windowRef.recordId&&
                    row.data.sha256===windowRef.sha256).length!==1)return fail();
            }
            const reviewerEventsAfterReview=events.filter(row=>{
                const at=Date.parse(row.at),params=object(row.data.params??{});
                if(!Number.isFinite(at)||at<lastReviewAt)return false;
                return row.type==='role.dispatch'&&row.data.role==='reviewer'||row.type==='agent.event'&&params.role==='reviewer'&&
                    ['turn/start','dm/codexAdmission','dm/codexCompletion'].includes(String(params.method));
            });
            if(reviewerEventsAfterReview.length)return fail();
            let phaseIndex=-1;for(let index=events.length-1;index>=0;index--){if(events[index].type==='run.phase'){phaseIndex=index;break;}}
            if(phaseIndex<0)return fail();
            const phase=events[phaseIndex]!,afterPhase=events.slice(phaseIndex+1),blocked=afterPhase.at(-1);
            if(afterPhase.length!==2||phase.data.state!=='REVIEWING'||phase.data.phase!=='REVIEWING'||
                afterPhase[0].type!=='step.started'||afterPhase[0].data.state!=='REVIEWING'||afterPhase[0].data.phase!=='REVIEWING'||
                !blocked||blocked.type!=='run.blocked'||blocked.data.state!=='BLOCKED'||blocked.data.phase!=='REVIEWING'||
                blocked.data.reason!==run.reason||!REPAIR_PACKET_RECOVERY_REASONS.has(String(run.reason)))return fail();
            return {packetHash:expectedPacketHash,packetRecordId:null,savedPacketHash:String(saved.data.sha256),packetRebuilt:true,
                previousPacketRecordId:saved.id,previousPacketHash:String(saved.data.sha256),dispatchId:null,preDispatch:true,
                preparationFailure:run.reason,replayConsumedCall:false,dispatchIds:lastGrants.map(row=>String(row.data.dispatchId)),
                basisHash:hash({rows,events}),version:run.version};
        }
        if(options.expiredWindowApproval||!run.sessions.reviewer||run.roleIdentities?.reviewer?.sessionId!==run.sessions.reviewer||
            reviews.some(row=>row.data.source!=='CODEX'||row.data.treeHash===run.treeHash)||
            rows.some(row=>row.kind==='ReviewPreparationRecovery'&&row.data.sourceHash===run.treeHash)||
            !saved||saved.data.sha256!==expectedPacketHash||hash(saved.data.packet)!==expectedPacketHash||
            object(saved.data.packet).runId!==run.id||object(saved.data.packet).specHash!==run.specHash||!grant||grant.data.kind!=='reviewer'||rows.indexOf(saved)>=rows.indexOf(grant))return fail();
        const packet=object(saved.data.packet),history=packet.sourceHistory;
        if(!Array.isArray(history)||object(history.at(-1)).treeHash!==run.treeHash||reviews.some(row=>rows.indexOf(row)>=rows.indexOf(saved)))return fail();
        const finishes=rows.filter(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===grant.data.dispatchId);
        if(finishes.length!==1||finishes[0].data.outcome!=='REVIEW_PACKET_LIMIT'||finishes[0].data.cleanupReturned!==true||finishes[0].data.generation!==grant.data.generation||rows.indexOf(finishes[0])<=rows.indexOf(grant)||
            grants.some(g=>!rows.some(f=>f.kind==='DispatchFinished'&&f.data.dispatchId===g.data.dispatchId&&f.data.generation===g.data.generation&&f.data.cleanupReturned===true)))return fail();
        const events=store.db.prepare("SELECT id,payload FROM events WHERE project_id=? AND run_id=? AND type='agent.event' AND at>=? ORDER BY id LIMIT 1001").all(run.projectId,run.id,grant.at);
        if(events.length>1000||events.some(row=>{const e=object(JSON.parse(String(row.payload)));return e.method!=='dm/codexPreparation'||object(e.params).role!=='reviewer';}))return fail();
        return {packetHash:expectedPacketHash,packetRecordId:saved.id,dispatchId:String(grant.data.dispatchId),preDispatch:true,dispatchIds:grants.map(g=>String(g.data.dispatchId)),basisHash:hash({rows,events}),version:run.version};
    }
    if(run.roleIdentities?.reviewer||run.sessions.reviewer||rows.some(row=>['Review','ReviewPreparationRecovery'].includes(row.kind)||
        row.kind==='AgentSession'&&row.data.role==='reviewer'))return fail();
    const packets=rows.filter(row=>row.kind==='ReviewPacket'),saved=packets.at(-1);
    const grants=rows.filter(row=>row.kind==='DispatchGranted'),reviewers=grants.filter(row=>row.data.kind==='reviewer');
    if(packets.length===0){
        // A packet-size error can occur before even entering the reviewer runner.
        // No earlier packet/turn is invented: caller binds the newly rebuilt packet.
        const step=rows.filter(row=>row.kind==='Step').at(-1);
        if(reviewers.length||rows.some(row=>row.data.kind==='reviewer'&&row.kind.startsWith('Dispatch'))||
            !step||step.data.phase!=='REVIEWING'||step.data.specHash!==run.specHash||step.data.treeHash!==run.treeHash||step.data.attempt!==run.attempt)return fail();
        if(grants.some(grant=>{const finished=rows.filter(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===grant.data.dispatchId);
            return finished.length!==1||finished[0].data.cleanupReturned!==true||finished[0].data.generation!==grant.data.generation||rows.indexOf(finished[0])<=rows.indexOf(grant);}))return fail();
        const events=store.db.prepare('SELECT id,type,payload FROM events WHERE project_id=? AND run_id=? ORDER BY id LIMIT 4097').all(run.projectId,run.id);
        if(events.length>4096||events.some(row=>{const e=object(JSON.parse(String(row.payload)));
            return row.type==='agent.event'&&object(e.params??{}).role==='reviewer';}))return fail();
        let last=events.at(-1);
        if(run.reviewWindow){
            const approval=reviewWindowEvidence(store,run),event=last&&object(JSON.parse(String(last.payload)));
            if(!approval||last?.type!=='run.review-window.approved'||event?.recordId!==run.reviewWindow.recordId||event?.sha256!==run.reviewWindow.sha256)return fail();
            last=events.at(-2);
        }
        const failure=last&&object(JSON.parse(String(last.payload)));
        if(!last||last.type!=='run.blocked'||failure?.state!=='BLOCKED'||failure.phase!=='REVIEWING'||
            !PRE_DISPATCH_PACKET_RECOVERY_REASONS.has(String(failure.reason))||failure.reason!==run.reason)return fail();
        return {packetHash:expectedPacketHash,packetRecordId:null,dispatchId:null,preDispatch:true,preparationFailure:run.reason,
            dispatchIds:grants.map(row=>String(row.data.dispatchId)),basisHash:hash({rows,events}),version:run.version};
    }
    if(run.reason==='REVIEW_ROLE_EVIDENCE_REQUIRED')return fail();
    if(packets.length!==1||!saved||saved.data.sha256!==expectedPacketHash||hash(saved.data.packet)!==expectedPacketHash)return fail();
    const packet=object(saved.data.packet);
    if(packet.runId!==run.id||packet.specHash!==run.specHash||packet.schema!=='dream-maker.review-packet.v1')return fail();
    if(reviewers.length!==1)return fail();const granted=reviewers[0];
    const finishes=rows.filter(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===granted.data.dispatchId),finished=finishes[0];
    if(finishes.length!==1||finished.data.outcome!=='REVIEW_PACKET_LIMIT'||finished.data.cleanupReturned!==true||
        finished.data.generation!==granted.data.generation||rows.indexOf(finished)<=rows.indexOf(granted))return fail();
    if(grants.some(grant=>!rows.some(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===grant.data.dispatchId&&row.data.cleanupReturned===true)))return fail();
    // The typed local packet exception occurs before Codex turn/start. Corroborate
    // its failed dispatch with the original event trail; any admission/turn is ineligible.
    const events=store.db.prepare("SELECT payload FROM events WHERE project_id=? AND run_id=? AND type='agent.event' AND at>=? ORDER BY id LIMIT 1001").all(run.projectId,run.id,granted.at);
    if(events.length>1000||events.some(row=>{const e=object(JSON.parse(String(row.payload)));return e.method!=='dm/codexPreparation'||object(e.params).role!=='reviewer';}))return fail();
    return {packetHash:expectedPacketHash,packetRecordId:saved.id,dispatchId:String(granted.data.dispatchId),preDispatch:false,
        dispatchIds:grants.map(row=>String(row.data.dispatchId)),basisHash:hash({rows,events}),version:run.version};
}

/** Recover a local Executor dispatch that the former replay gate rejected before
 * any process, session, tool or agent event. The reviewed source and counters stay
 * frozen; this proof never supplies implementation output or a review verdict. */
export function reviewPreparationDispatchRecovery(store:Store,run:Run){
    const fail=():never=>{throw new DomainError('REVIEW_PREPARATION_DISPATCH_RECOVERY_NOT_ALLOWED',409);};
    if(run.mode!=='live'||run.flowName!=='classic'||run.flowConfig?.mode!=='classic'||run.state!=='BLOCKED'||run.phase!=='REPAIRING'||
        run.reason!=='REVIEW_PREPARATION_REPLAY_INVALID'||!run.review||run.review.source!=='CODEX'||run.review.verdict!=='CHANGES_REQUESTED'||
        run.review.treeHash!==run.treeHash||!Array.isArray(run.review.findings)||!run.tasks.length||run.tasks.some(t=>t.status!=='implemented')||
        !run.verification?.ok||run.verification.treeHash!==run.treeHash||run.repairCount<1||run.repairCount>run.maxRepairs||
        run.calls>=run.maxCalls||run.failedFingerprints.at(-1)!==hash(JSON.stringify(run.review.findings)))return fail();
    const rows=store.db.prepare('SELECT id,kind,at,data FROM records WHERE project_id=? AND run_id=? ORDER BY rowid LIMIT 4097')
        .all(run.projectId,run.id).map(row=>({id:String(row.id),kind:String(row.kind),at:String(row.at),data:object(JSON.parse(String(row.data)))}));
    if(rows.length>4096||rows.some(row=>row.kind==='ReviewPreparationDispatchRecovery'))return fail();
    const reviews=rows.filter(row=>row.kind==='Review'),review=reviews.at(-1);
    if(!review||review.data.source!=='CODEX'||review.data.verdict!=='CHANGES_REQUESTED'||review.data.treeHash!==run.treeHash||
        !Array.isArray(review.data.findings)||hash(review.data.findings)!==hash(run.review.findings))return fail();
    const grant=rows.filter(row=>row.kind==='DispatchGranted').at(-1);
    if(!grant||grant.data.kind!=='executor'||grant.data.mode!=='live'||grant.data.cleanupReturned!==false||
        typeof grant.data.dispatchId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(grant.data.dispatchId)||
        typeof grant.data.generation!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(grant.data.generation))return fail();
    const dispatchId=grant.data.dispatchId,generation=grant.data.generation,grantIndex=rows.indexOf(grant),reviewIndex=rows.indexOf(review),
        queued=rows.filter(row=>row.kind==='DispatchQueued'&&row.data.dispatchId===dispatchId),
        finishes=rows.filter(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===dispatchId),finish=finishes[0],finishIndex=rows.indexOf(finish);
    if(queued.length!==1||queued[0].data.kind!=='executor'||queued[0].data.generation!==generation||
        finishes.length!==1||!finish||finish.data.generation!==generation||finish.data.outcome!==run.reason||
        finish.data.cleanupReturned!==true||reviewIndex>=rows.indexOf(queued[0])||rows.indexOf(queued[0])>=grantIndex||
        finishIndex!==grantIndex+1||finishIndex!==rows.length-1)return fail();
    const events=store.db.prepare('SELECT id,type,at,payload FROM events WHERE project_id=? AND run_id=? AND at>=? AND at<=? ORDER BY id LIMIT 1001')
        .all(run.projectId,run.id,grant.at,finish.at).map(row=>({id:Number(row.id),type:String(row.type),at:String(row.at),data:object(JSON.parse(String(row.payload)))}));
    if(events.length)return fail();
    const tail=store.db.prepare('SELECT id,type,at,payload FROM events WHERE project_id=? AND run_id=? ORDER BY id DESC LIMIT 1').get(run.projectId,run.id);
    if(!tail||tail.type!=='run.blocked')return fail();
    const blocked=object(JSON.parse(String(tail.payload)));
    if(blocked.state!=='BLOCKED'||blocked.phase!=='REPAIRING'||blocked.reason!==run.reason)return fail();
    return {schema:'dream-maker.review-preparation-dispatch-recovery.v1',sourceHash:run.treeHash,specHash:run.specHash,
        planVersionHash:run.planVersionHash,reviewRecordId:review.id,reviewHash:hash(review.data),dispatchId,generation,
        outcome:run.reason,calls:run.calls,repairCount:run.repairCount,createdAt:run.createdAt,maxSeconds:run.maxSeconds,
        modelDispatched:false,automaticRetry:false,basisHash:hash({rows,events,tail}),version:run.version};
}

/** Reserve the one existing reviewer call for a clean pre-admission retry.
 * Returning false means this is a new call and the caller must reserve budget
 * normally. A malformed or repeated replay is always rejected. */
export function reserveReviewPreparationReplay(store:Store,run:Run,role:string,dispatch:{dispatchId:string;generation:string}):boolean{
    if(role!=='reviewer')return false;
    const fail=():never=>{throw new DomainError('REVIEW_PREPARATION_REPLAY_INVALID',409);};
    const rows=store.db.prepare('SELECT id,kind,at,data FROM records WHERE project_id=? AND run_id=? ORDER BY rowid LIMIT 4097')
        .all(run.projectId,run.id).map(row=>({id:String(row.id),kind:String(row.kind),at:String(row.at),data:object(JSON.parse(String(row.data)))}));
    if(rows.length>4096)return fail();
    const markers=rows.filter(row=>row.kind==='ReviewPreparationRecovery'&&row.data.sourceHash===run.treeHash);
    if(!markers.length)return false;
    if(markers.length>2)return fail();
    const marker=markers.at(-1)!,data=marker.data;
    if(markers.length===2){
        const first=markers[0],second=markers[1];
        if(first.data.preparationFailure!=='REVIEW_ADMISSION_BINDING_INVALID'||
            second.data.preparationFailure!=='NATIVE_PROBE_MISSING'&&second.data.preparationFailure!=='NATIVE_PROBE_BINDING_CHANGED'||
            second.data.probeBindingRecovery!==true)return fail();
    }
    if(role!=='reviewer'||run.phase!=='REVIEWING'||!store.owns(run.projectId,run.id)||data.modelDispatched!==false||
        data.sourceHash!==run.treeHash||data.specHash!==run.specHash||data.planVersionHash!==run.planVersionHash||
        data.calls!==run.calls||data.repairCount!==run.repairCount||data.createdAt!==run.createdAt||data.maxSeconds!==run.maxSeconds||
        typeof data.packetHash!=='string'||!PACKET_HASH.test(data.packetHash))return fail();
    const localMaterialRebuild=data.replayConsumedCall===undefined&&data.preDispatch===true&&
        data.packetRecordId===null&&data.dispatchId===null&&data.packetRebuilt===undefined&&
        (data.preparationFailure===undefined||PRE_DISPATCH_PACKET_RECOVERY_REASONS.has(String(data.preparationFailure)));
    if(localMaterialRebuild){
        // The controller failed while constructing the first Reviewer packet. No
        // Reviewer call, process, session or packet existed. Rebuilding the material
        // is not a replay of a consumed model call, but bind the one new Reviewer
        // dispatch to this marker before the normal call reservation runs.
        if(markers.length!==1||rows.some(row=>row.kind==='ReviewPreparationReplayReservation'))return fail();
        const current=rows.filter(row=>row.kind==='ReviewPacket'&&row.data.sha256===data.packetHash&&
            hash(row.data.packet)===data.packetHash);
        if(current.length!==1||rows.some(row=>row.kind==='Review'||row.kind==='AgentSession'&&row.data.role==='reviewer'))return fail();
        if(typeof dispatch.dispatchId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(dispatch.dispatchId)||
            typeof dispatch.generation!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(dispatch.generation))return fail();
        const grants=rows.filter(row=>row.kind==='DispatchGranted'&&row.data.dispatchId===dispatch.dispatchId);
        if(grants.length!==1||grants[0].data.kind!=='reviewer'||grants[0].data.mode!=='live'||grants[0].data.generation!==dispatch.generation||
            rows.indexOf(current[0])<=rows.indexOf(marker)||rows.indexOf(grants[0])<=rows.indexOf(current[0])||
            rows.some(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===dispatch.dispatchId))return fail();
        const eventBoundaryId=store.event(run.projectId,run.id,'run.review-preparation.material-reserved',
            {approvalRecordId:marker.id,packetHash:data.packetHash,packetRecordId:current[0].id,dispatchId:dispatch.dispatchId,
                generation:dispatch.generation,sourceHash:run.treeHash,role,replayedCall:false});
        store.record('ReviewPreparationReplayReservation',run.projectId,run.id,{approvalRecordId:marker.id,approvalHash:hash(data),
            approvalPacketHash:data.packetHash,packetRecordId:current[0].id,sourceHash:run.treeHash,specHash:run.specHash,role,
            dispatchId:dispatch.dispatchId,generation:dispatch.generation,eventBoundaryId,modelDispatched:false,replayedCall:false});
        return false;
    }
    if(data.replayConsumedCall===false&&data.preDispatch===true&&data.packetRebuilt===true){
        if(markers.length!==1||data.packetRecordId!==null||data.dispatchId!==null||!REPAIR_PACKET_RECOVERY_REASONS.has(String(data.preparationFailure))||
            typeof data.previousPacketRecordId!=='string'||typeof data.previousPacketHash!=='string'||!PACKET_HASH.test(data.previousPacketHash))return fail();
        const previous=rows.find(row=>row.kind==='ReviewPacket'&&row.id===data.previousPacketRecordId),
            current=rows.filter(row=>row.kind==='ReviewPacket'&&row.id!==data.previousPacketRecordId&&
                row.data.sha256===data.packetHash&&hash(row.data.packet)===data.packetHash);
        if(!previous||previous.data.sha256!==data.previousPacketHash||hash(previous.data.packet)!==data.previousPacketHash||current.length!==1)return fail();
        if(rows.some(row=>row.kind==='ReviewPreparationReplayReservation'))throw new DomainError('REVIEW_PREPARATION_REPLAY_CONSUMED',409);
        const grants=rows.filter(row=>row.kind==='DispatchGranted'&&row.data.dispatchId===dispatch.dispatchId);
        if(grants.length!==1||grants[0].data.kind!=='reviewer'||grants[0].data.mode!=='live'||grants[0].data.generation!==dispatch.generation||
            rows.indexOf(current[0])<=rows.indexOf(marker)||rows.indexOf(grants[0])<=rows.indexOf(current[0])||
            rows.some(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===dispatch.dispatchId))return fail();
        return false;
    }
    if(data.replayConsumedCall===false&&data.preDispatch===false&&data.coldInitializeRecovery===true){
        if(markers.length!==1||data.preparationFailure!=='RPC_REQUEST_TIMEOUT'||
            typeof data.packetRecordId!=='string'||!data.packetRecordId||data.packetHash===undefined)return fail();
        const saved=rows.find(row=>row.kind==='ReviewPacket'&&row.id===data.packetRecordId);
        if(!saved||saved.data.sha256!==data.packetHash||hash(saved.data.packet)!==data.packetHash)return fail();
        if(rows.some(row=>row.kind==='ReviewPreparationReplayReservation'&&row.data.dispatchId!==dispatch.dispatchId))return fail();
        if(typeof dispatch.dispatchId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(dispatch.dispatchId)||
            typeof dispatch.generation!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(dispatch.generation))return fail();
        const grants=rows.filter(row=>row.kind==='DispatchGranted'&&row.data.dispatchId===dispatch.dispatchId);
        if(grants.length!==1||grants[0].data.kind!=='reviewer'||grants[0].data.mode!=='live'||grants[0].data.generation!==dispatch.generation||
            rows.indexOf(saved)>=rows.indexOf(grants[0])||rows.some(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===dispatch.dispatchId))return fail();
        if(rows.some(row=>row.kind==='ReviewPreparationReplayReservation'&&row.data.dispatchId===dispatch.dispatchId))
            throw new DomainError('REVIEW_PREPARATION_REPLAY_CONSUMED',409);
        const eventBoundaryId=store.event(run.projectId,run.id,'run.review-preparation.cold-initialize-reserved',
            {approvalRecordId:marker.id,packetHash:data.packetHash,packetRecordId:saved.id,dispatchId:dispatch.dispatchId,
                generation:dispatch.generation,sourceHash:run.treeHash,role,replayedCall:false});
        store.record('ReviewPreparationReplayReservation',run.projectId,run.id,{approvalRecordId:marker.id,approvalHash:hash(data),
            approvalPacketHash:data.packetHash,packetRecordId:saved.id,sourceHash:run.treeHash,specHash:run.specHash,role,
            dispatchId:dispatch.dispatchId,generation:dispatch.generation,eventBoundaryId,modelDispatched:false,replayedCall:false,
            coldInitializeRecovery:true});
        return false;
    }
    if(data.replayConsumedCall!==true)return fail();
    let saved;
    if(data.packetRebuilt===true){
        if(data.packetRecordId!==null||typeof data.previousPacketRecordId!=='string'||!data.previousPacketRecordId||
            typeof data.previousPacketHash!=='string'||!PACKET_HASH.test(data.previousPacketHash))return fail();
        const previous=rows.find(row=>row.kind==='ReviewPacket'&&row.id===data.previousPacketRecordId);
        if(!previous||previous.data.sha256!==data.previousPacketHash||hash(previous.data.packet)!==data.previousPacketHash)return fail();
        const currentPackets=rows.filter(row=>row.kind==='ReviewPacket'&&row.id!==previous.id&&
            row.data.sha256===data.packetHash&&hash(row.data.packet)===data.packetHash);
        if(currentPackets.length!==1)return fail();
        saved=currentPackets[0];
    }else{
        if(typeof data.packetRecordId!=='string'||!data.packetRecordId)return fail();
        saved=rows.find(row=>row.kind==='ReviewPacket'&&row.id===data.packetRecordId);
        if(!saved||saved.data.sha256!==data.packetHash||hash(saved.data.packet)!==data.packetHash)return fail();
    }
    const existing=rows.filter(row=>row.kind==='ReviewPreparationReplayReservation');
    if(markers.length===1){
        if(existing.length)throw new DomainError('REVIEW_PREPARATION_REPLAY_CONSUMED',409);
    }else{
        if(existing.length>1)throw new DomainError('REVIEW_PREPARATION_REPLAY_CONSUMED',409);
        if(existing.length!==1)return fail();
        const prior=existing[0].data,priorGrant=rows.find(row=>row.kind==='DispatchGranted'&&row.data.dispatchId===prior.dispatchId),
            priorFinish=rows.filter(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===prior.dispatchId);
        if(!priorGrant||priorGrant.data.kind!=='reviewer'||priorGrant.data.mode!=='live'||priorGrant.data.generation!==prior.generation||
            prior.approvalRecordId!==markers[0].id||prior.dispatchId!==data.dispatchId||prior.sourceHash!==run.treeHash||
            prior.specHash!==run.specHash||prior.role!=='reviewer'||prior.modelDispatched!==false||
            priorFinish.length!==1||priorFinish[0].data.generation!==prior.generation||priorFinish[0].data.cleanupReturned!==true||
            priorFinish[0].data.outcome!==data.preparationFailure)return fail();
    }
    if(typeof dispatch.dispatchId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(dispatch.dispatchId)||
        typeof dispatch.generation!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(dispatch.generation))return fail();
    const grants=rows.filter(row=>row.kind==='DispatchGranted'&&row.data.dispatchId===dispatch.dispatchId);
    if(grants.length!==1||grants[0].data.kind!=='reviewer'||grants[0].data.mode!=='live'||grants[0].data.generation!==dispatch.generation||
        rows.indexOf(grants[0])<=rows.indexOf(marker)||rows.indexOf(saved)>=rows.indexOf(grants[0])||
        rows.some(row=>row.kind==='DispatchFinished'&&row.data.dispatchId===dispatch.dispatchId))return fail();
    if(existing.some(row=>row.data.dispatchId===dispatch.dispatchId))throw new DomainError('REVIEW_PREPARATION_REPLAY_CONSUMED',409);
    const eventBoundaryId=store.event(run.projectId,run.id,'run.review-preparation.replay-reserved',
        {approvalRecordId:marker.id,packetHash:data.packetHash,packetRecordId:saved.id,dispatchId:dispatch.dispatchId,generation:dispatch.generation,sourceHash:run.treeHash,role});
    store.record('ReviewPreparationReplayReservation',run.projectId,run.id,{approvalRecordId:marker.id,approvalHash:hash(data),approvalPacketHash:data.packetHash,
        packetRecordId:saved.id,sourceHash:run.treeHash,specHash:run.specHash,role,dispatchId:dispatch.dispatchId,generation:dispatch.generation,eventBoundaryId,modelDispatched:false});
    return true;
}
