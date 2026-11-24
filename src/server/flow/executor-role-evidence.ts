import type {AgentOutput,ExecutorRoleIdentity,Run} from '../../shared/types.js';
import type {Store} from '../store.js';
import {DomainError,object} from '../security.js';
import {customExecutionIdentity} from './custom-role-identity.js';

const fail=():never=>{throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);};
const bounded=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=500;

function assertEntry(run:Run,entry:ExecutorRoleIdentity):void {
    if(!bounded(entry.executorRoleId)||!bounded(entry.sessionId)||!bounded(entry.requestId)||!bounded(entry.dispatchId)||!bounded(entry.generation)||
        entry.taskId!==undefined&&!bounded(entry.taskId)||entry.sliceId!==undefined&&!bounded(entry.sliceId)||entry.roleId!==entry.executorRoleId)fail();
    const out:AgentOutput={
        text:'',sessionId:entry.sessionId,model:entry.model,identity:entry,
        usage:{role:'executor',requestId:entry.requestId,inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN'},
    };
    customExecutionIdentity(run,'executor',out,entry.executorRoleId);
}

/** Add only controller-derived completed-turn evidence. Duplicate sessions, requests,
 * dispatch grants or completed tasks fail before the Run can be saved. */
export function appendExecutorRoleIdentity(run:Run,entry:ExecutorRoleIdentity):void {
    if(run.mode!=='live'||run.flowName!=='custom'||entry.roleId!==entry.executorRoleId)throw new DomainError('DISPATCH_RESULT_FENCED',409);
    assertEntry(run,entry);
    const current=run.executorRoleIdentities??=[];
    if(current.length>=4096||current.some(value=>
        value.dispatchId===entry.dispatchId||value.sessionId===entry.sessionId||value.requestId===entry.requestId||
        value.sliceId!==undefined&&value.sliceId===entry.sliceId||entry.taskId!==undefined&&value.taskId===entry.taskId))throw new DomainError('ROLE_SESSIONS_NOT_INDEPENDENT',409);
    const supervisorSessions=[run.roleIdentities?.planner2?.sessionId,run.roleIdentities?.reviewer?.sessionId].filter((value):value is string=>typeof value==='string');
    if(supervisorSessions.includes(entry.sessionId))throw new DomainError('ROLE_SESSIONS_NOT_INDEPENDENT',409);
    current.push(structuredClone(entry));
}

/** Verify every current Custom Executor AgentSession and UsageLedger row against
 * the frozen role configuration. The compatibility singular entry is not proof. */
export function verifiedExecutorRoleIdentities(run:Run,store:Store):ExecutorRoleIdentity[] {
    const entries=run.executorRoleIdentities;
    if(run.mode!=='live'||run.flowName!=='custom'||run.rolePolicy!=='CUSTOM_FROZEN_V1'||!Array.isArray(entries)||!entries.length||entries.length>4096)fail();
    const values=entries as ExecutorRoleIdentity[];
    const sessions=store.db.prepare("SELECT data FROM records WHERE project_id=? AND run_id=? AND kind='AgentSession' ORDER BY rowid").all(run.projectId,run.id)
        .map(row=>object(JSON.parse(String(row.data)))).filter(value=>value.role==='executor');
    const usages=store.db.prepare("SELECT data FROM records WHERE project_id=? AND run_id=? AND kind='UsageLedger' ORDER BY rowid").all(run.projectId,run.id)
        .map(row=>object(JSON.parse(String(row.data)))).filter(value=>value.role==='executor');
    if(sessions.length!==values.length||usages.length!==values.length)fail();
    const sessionIds=new Set<string>(),requestIds=new Set<string>(),dispatchIds=new Set<string>(),sliceIds=new Set<string>(),taskIds=new Set<string>();
    for(const entry of values){
        assertEntry(run,entry);
        if(sessionIds.has(entry.sessionId)||requestIds.has(entry.requestId)||dispatchIds.has(entry.dispatchId)||
            entry.sliceId!==undefined&&sliceIds.has(entry.sliceId)||entry.taskId!==undefined&&taskIds.has(entry.taskId))fail();
        sessionIds.add(entry.sessionId);requestIds.add(entry.requestId);dispatchIds.add(entry.dispatchId);
        if(entry.sliceId!==undefined)sliceIds.add(entry.sliceId);if(entry.taskId!==undefined)taskIds.add(entry.taskId);
        const matchingSessions=sessions.filter(value=>value.sessionId===entry.sessionId);
        const matchingUsages=usages.filter(value=>value.requestId===entry.requestId);
        if(matchingSessions.length!==1||matchingUsages.length!==1)return fail();
        const dispatches=store.db.prepare("SELECT kind,data FROM records WHERE project_id=? AND run_id=? AND kind IN ('DispatchGranted','DispatchFinished') AND json_extract(data,'$.dispatchId')=? ORDER BY rowid").all(run.projectId,run.id,entry.dispatchId)
            .map(row=>({kind:String(row.kind),data:object(JSON.parse(String(row.data)))}));
        const grants=dispatches.filter(value=>value.kind==='DispatchGranted'),finishes=dispatches.filter(value=>value.kind==='DispatchFinished');
        if(grants.length!==1||finishes.length!==1)fail();
        const grant=grants[0].data,finish=finishes[0].data;
        if(grant.kind!=='executor'||grant.mode!=='live'||grant.generation!==entry.generation||grant.executorRoleId!==entry.executorRoleId||
            grant.executorSliceId!==entry.sliceId||finish.generation!==entry.generation||finish.outcome!=='COMPLETED'||finish.cleanupReturned!==true)fail();
        const session=matchingSessions[0];
        if(session.modelEvidence!=='ADAPTER_VERIFIED_RESPONSE'||session.executorRoleId!==entry.executorRoleId||
            session.dispatchId!==entry.dispatchId||session.generation!==entry.generation||
            entry.taskId!==undefined&&session.taskId!==entry.taskId||entry.sliceId!==undefined&&session.sliceId!==entry.sliceId||
            ['runner','provider','authentication','model','roleId','authRef','accountRef','configurationHash','routeHash']
                .some(key=>session[key]!==entry[key as keyof ExecutorRoleIdentity]))fail();
    }
    if(sessions.some(value=>typeof value.sessionId!=='string'||!sessionIds.has(value.sessionId))||
        usages.some(value=>typeof value.requestId!=='string'||!requestIds.has(value.requestId)))fail();
    const supervisorSessions=[run.roleIdentities?.planner2?.sessionId,run.roleIdentities?.reviewer?.sessionId].filter((value):value is string=>typeof value==='string');
    if(supervisorSessions.some(value=>sessionIds.has(value)))fail();
    return values.map(value=>structuredClone(value));
}
