import { TextDecoder } from "node:util";
import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { files, get, treeHash } from "./workspace.js";
import { DomainError, hash, object } from "./security.js";
import type { Store } from "./store.js";
import type { ExecutionIdentity, Run, Spec } from "../shared/types.js";
import { validateVerifierPlan, checkVerifierCase, verifierCaseEvidence, type VerifierCase } from "./wsl-verifier.js";
import { assertReviewMaterialSafe } from './review-material.js';
import {reviewApprovalEvidence} from './review-approval-evidence.js';
import {poolReviewSources} from './review-source-pool.js';
import {reviewWindowEvidence,reviewOnlyWindowEvidence} from './review-window.js';
import {reviewSupplementEvidence} from './review-supplement.js';
import {inheritedDocumentationPlanning} from './documentation-continuation.js';
import {verifiedExecutorRoleIdentities} from './flow/executor-role-evidence.js';
import {buildAcceptanceEvidence} from './acceptance-evidence.js';
import {preworkReviewMaterials,requiredPreworkReviewCoverage} from './prework/runtime.js';
import {checkedExecutorEffectCoverage} from './prework/executor-effects.js';

type Stage = "BASELINE" | "EXECUTOR_BEFORE" | "EXECUTOR_AFTER" | "VERIFIER_INPUT";
interface SourceFile { path:string; bytes:number; sha256:string; encoding:"utf8"|"base64"; content:string }
interface Snapshot {
    schema:"dream-maker.source-snapshot.v1"; runId:string; specHash:string;
    stage:Stage; treeHash:string; files:SourceFile[]; directories?:string[]; sha256:string;
}
const PACKET_BYTES = 2 * 1024 * 1024; // Expanded complete review materials.
const WIRE_PACKET_BYTES = 512000; // Portable one-message transport ceiling.
const metadata = (entries:SourceFile[]) => entries.map(({path,bytes,sha256})=>({path,bytes,sha256}));
function assertSafe(value:unknown) {
    assertReviewMaterialSafe(value);
}
function captureDirectories(workspace:string):string[]{
    const result:string[]=[];
    const visit=(relative:string)=>{
        for(const item of readdirSync(join(workspace,relative),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
            if(['.git','node_modules'].includes(item.name.toLowerCase()))continue;
            const path=relative?relative+'/'+item.name:item.name,stat=lstatSync(join(workspace,path));
            if(stat.isSymbolicLink())throw new DomainError('REVIEW_SOURCE_TREE_MISMATCH',409);
            if(stat.isDirectory()){
                if(result.length>=2000)throw new DomainError('REVIEW_PACKET_LIMIT',413);
                result.push(path);visit(path);
            }
        }
    };visit('');return result;
}
export function captureSource(workspace:string,binding:{runId:string;specHash:string},stage:Stage):Snapshot {
    const manifest=files(workspace),entries:SourceFile[]=[],directories=captureDirectories(workspace);
    if(manifest.reduce((sum,f)=>sum+f.bytes,0)>PACKET_BYTES)throw new DomainError("REVIEW_PACKET_LIMIT",413);
    for(const item of manifest){
        const bytes=get(workspace,item.path);
        if(bytes.length!==item.bytes||hash(bytes)!==item.sha256)throw new DomainError("REVIEW_SOURCE_TREE_MISMATCH",409);
        let encoding:SourceFile["encoding"]="utf8",content:string;
        try{content=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);}
        catch{encoding="base64";content=bytes.toString("base64");}
        entries.push({...item,encoding,content});
    }
    const tree=hash(manifest);
    if(treeHash(workspace)!==tree||hash(captureDirectories(workspace))!==hash(directories))throw new DomainError("REVIEW_SOURCE_TREE_MISMATCH",409);
    const source={schema:"dream-maker.source-snapshot.v1" as const,...binding,stage,treeHash:tree,files:entries,directories};
    assertSafe(source);
    const snapshot={...source,sha256:hash(source)};
    if(Buffer.byteLength(JSON.stringify(snapshot))>PACKET_BYTES)throw new DomainError("REVIEW_PACKET_LIMIT",413);
    return snapshot;
}
function readMaterial(store:Store,run:Run,...kinds:string[]){
    const rows:{recordId:string;kind:string;at:string;data:unknown}[]=[];let bytes=0;
    const query=store.db.prepare(`SELECT id,kind,at,data FROM records WHERE project_id=? AND run_id=? AND kind IN (${kinds.map(()=>'?').join(',')}) ORDER BY rowid`);
    for(const row of query.iterate(run.projectId,run.id,...kinds)){
        if(typeof row.data!=="string"||typeof row.id!=="string")throw new DomainError("REVIEW_RECORD_INVALID",409);
        bytes+=Buffer.byteLength(row.data)+Buffer.byteLength(row.id);
        if(bytes>PACKET_BYTES)throw new DomainError("REVIEW_PACKET_LIMIT",413);
        rows.push({recordId:row.id,kind:String(row.kind),at:String(row.at),data:JSON.parse(row.data)});
    }
    return rows;
}
function fixtureTree(snapshot:Snapshot,c:VerifierCase){
    const key=(path:string)=>process.platform==='win32'?path.toLowerCase():path;
    const entries=new Map(metadata(snapshot.files).map(f=>[key(f.path),f])),directories=new Map<string,string>();
    for(const path of snapshot.directories??[])directories.set(key(path),path);
    for(const f of snapshot.files){const parts=f.path.split('/');for(let n=1;n<parts.length;n++){const path=parts.slice(0,n).join('/');directories.set(key(path),path);}}
    for(const [path,content] of Object.entries(c.fixtures??{})){
        const parts=path.split('/');let parent='';
        for(const part of parts.slice(0,-1)){const candidate=parent?parent+'/'+part:part;parent=directories.get(key(candidate))??candidate;directories.set(key(candidate),parent);}
        const candidate=(parent?parent+'/':'')+parts.at(-1)!,actual=entries.get(key(candidate))?.path??candidate;
        entries.set(key(actual),{path:actual,bytes:Buffer.byteLength(content),sha256:hash(content)});
    }
    // workspace.files traverses sorted directory entries, not a flat lexical path list.
    const compare=(a:string,b:string):number=>{const x=a.split('/'),y=b.split('/');for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i]<y[i]?-1:1;return x.length-y.length;};
    return hash([...entries.values()].sort((a,b)=>compare(a.path,b.path)));
}
function completeRawEvidence(data:Record<string,unknown>,snapshot:Snapshot,spec:Spec){
    const fail=(reason:string):never=>{throw new DomainError('REVIEW_RAW_EVIDENCE_INCOMPLETE',409,reason);};
    let raw:Record<string,unknown>,plan:ReturnType<typeof validateVerifierPlan>;
    try{
        raw=object(JSON.parse(data.stdout as string));
        if(!['dream-maker.trusted-cli-evidence.v1','dream-maker.trusted-cli-evidence.v2'].includes(String(raw.schema))||raw.specHash!==spec.hash||raw.sourceHash!==snapshot.treeHash||
            typeof raw.planText!=='string'||hash(raw.planText)!==raw.planHash||!Array.isArray(raw.cases))return fail('evidence binding');
        plan=validateVerifierPlan(JSON.parse(raw.planText),spec.hash,spec.requirements.map(r=>r.id),spec.acceptanceItems??[]);
        if(raw.cases.length!==plan.cases.length||hash(data.command)!==hash(['dream-maker-controller-cli-oracle',spec.hash,raw.planHash]))return fail('plan or command binding');
        let allOk=true;
        for(let index=0;index<plan.cases.length;index++){
            const c=plan.cases[index],observed=object(raw.cases[index]);
            if(typeof observed.stdout!=='string'||typeof observed.stderr!=='string'||!Number.isSafeInteger(observed.actualExitCode)||
                observed.stdinHash!==hash(c.stdin)||observed.sourceHash!==fixtureTree(snapshot,c)||
                !['EXECUTED','TIMED_OUT','CANCELLED','OUTPUT_LIMIT','MEMORY_LIMIT'].includes(String(observed.status))||typeof observed.jobId!=='string'||!observed.jobId||
                typeof observed.workerHash!=='string'||!/^[a-f0-9]{64}$/.test(observed.workerHash)||
                observed.fixtureCount!==Object.keys(c.fixtures??{}).length||!Array.isArray(observed.command)||!observed.command.length||
                observed.command.some(v=>typeof v!=='string'))return fail('case '+c.id+' evidence fields');
            const expected=checkVerifierCase(c,{stdout:observed.stdout,stderr:observed.stderr,exitCode:observed.actualExitCode as number});
            expected.ok&&=observed.status==='EXECUTED';
            for(const [key,value] of Object.entries(expected))if(hash(observed[key])!==hash(value))return fail('case '+c.id+' observed result');
            if(raw.schema==='dream-maker.trusted-cli-evidence.v2'){
                const witness=verifierCaseEvidence(c);
                if(hash(observed.input)!==hash(witness.input)||hash(observed.expected)!==hash(witness.expected))return fail('case '+c.id+' witness');
            }
            allOk&&=expected.ok;
        }
        if(raw.ok!==allOk||data.code!==(allOk?0:1))return fail('aggregate result');
    }catch(error){if(error instanceof DomainError&&error.code==='REVIEW_RAW_EVIDENCE_INCOMPLETE')throw error;return fail('parse');}
    return {raw,plan};
}
function verifierApprovalFor(store:Store,run:Run,planHash:string){
    const approval=store.db.prepare("SELECT id,data FROM records WHERE project_id=? AND run_id IS NULL AND kind='VerifierApproval' AND json_extract(data,'$.specHash')=? AND json_extract(data,'$.planHash')=? ORDER BY rowid DESC LIMIT 1").get(run.projectId,run.specHash,planHash);
    if(!approval||typeof approval.data!=='string'||Buffer.byteLength(approval.data)>PACKET_BYTES)throw new DomainError('REVIEW_RAW_EVIDENCE_INCOMPLETE',409);
    return {recordId:String(approval.id),planHash,data:JSON.parse(approval.data) as unknown};
}
/** Diagnostics are data from the original failed verifier, never a completion or
 * authority grant. The Engine alone decides whether a bounded repair may run. */
export function buildRepairDiagnostics(store:Store,run:Run,spec:Spec){
    const boundedRecovery=run.phase==='IMPLEMENTING'&&
        run.boundedCodeVerificationRecovery!==undefined&&run.verification?.ok===false;
    if(run.mode!=='live'||
        !(run.phase==='REPAIRING'&&run.reason?.startsWith('VERIFIER_EXIT_')||boundedRecovery))return null;
    const invalid=():never=>{throw new DomainError('REPAIR_DIAGNOSTICS_UNVERIFIED',409);};
    if(spec.id!==run.specId||spec.hash!==run.specHash||spec.stale||!run.treeHash||run.verification?.ok!==false||
        run.verification.treeHash!==run.treeHash||treeHash(run.workspace)!==run.treeHash)return invalid();
    const record=store.db.prepare("SELECT id,data FROM records WHERE id=? AND project_id=? AND run_id=? AND kind='Evidence'")
        .get(run.verification.evidenceId,run.projectId,run.id);
    const source=store.db.prepare("SELECT data FROM records WHERE project_id=? AND run_id=? AND kind='SourceSnapshot' AND json_extract(data,'$.stage')='VERIFIER_INPUT' ORDER BY rowid DESC LIMIT 1")
        .get(run.projectId,run.id);
    if(!record||typeof record.data!=='string'||Buffer.byteLength(record.data)>PACKET_BYTES||
        !source||typeof source.data!=='string'||Buffer.byteLength(source.data)>PACKET_BYTES)return invalid();
    const data=object(JSON.parse(record.data)),snapshot=checkedSnapshot(JSON.parse(source.data),run);
    if(data.scope!=='LIVE_VERIFIER'||data.specHash!==run.specHash||data.treeHash!==run.treeHash||snapshot.treeHash!==run.treeHash||
        snapshot.directories!==undefined&&hash(snapshot.directories)!==hash(captureDirectories(run.workspace)))return invalid();
    const {raw}=completeRawEvidence(data,snapshot,spec);
    if(raw.ok!==false||data.code!==1)return invalid();
    const plan=validateVerifierPlan(JSON.parse(String(raw.planText)),run.specHash,spec.requirements.map(r=>r.id),spec.acceptanceItems??[]),
        approval=verifierApprovalFor(store,run,String(raw.planHash)),observed=raw.cases as Record<string,unknown>[];
    const cases=observed.flatMap((actual,index)=>{
        if(actual.ok===true)return [];
        const c=plan.cases[index];
        return [{id:c.id,requirementIds:c.requirementIds,
            input:{runtime:c.runtime,entry:c.entry,args:c.args,stdin:c.stdin,...(c.fixtures?{fixtures:c.fixtures}:{})},
            expected:Object.fromEntries(Object.entries(c).filter(([key])=>key.startsWith('expected'))),
            actual:{stdout:actual.stdout,stderr:actual.stderr,exitCode:actual.actualExitCode,status:actual.status,
                outputMatched:actual.outputMatched,diagnosticMatched:actual.diagnosticMatched}}];
    });
    if(!cases.length)return invalid();
    const result={schema:'dream-maker.repair-diagnostics.v1',runId:run.id,specHash:run.specHash,sourceHash:run.treeHash,
        evidenceId:String(record.id),planHash:String(raw.planHash),verifierApproval:{recordId:approval.recordId,planHash:approval.planHash},
        caseCount:observed.length,passedCount:observed.length-cases.length,failedCount:cases.length,cases};
    assertSafe(result);
    if(Buffer.byteLength(JSON.stringify(result))>128000)throw new DomainError('REPAIR_DIAGNOSTICS_LIMIT',413);
    return result;
}
/**
 * A Custom role's provider identifies the account/model owner; Magpie is the
 * transport that carries the request. Keep those facts separate while binding
 * the controller-owned Codex lifecycle event to the exact frozen role route.
 */
function codexEventProvider(run:Run,role:'planner2'|'executor'|'reviewer',identity:ExecutionIdentity):string{
    if(run.flowName!=='custom'||role!=='planner2')return identity.provider;
    const snapshot=run.flowConfig;
    if(snapshot?.mode!=='custom')throw new DomainError('REVIEW_ROLE_EVIDENCE_REQUIRED',409);
    const selected=snapshot.roles.planner2;
    if(selected.transport!=='magpie')return identity.provider;
    const authentication=selected.authentication==='api_key'?'API_KEY':selected.runtime==='codex'?'CHATGPT_SUBSCRIPTION':'API_KEY';
    if(selected.runtime!=='codex'||selected.provider!==identity.provider||selected.model.id!==identity.model||
        selected.authRef!==identity.authRef||selected.accountRef!==identity.accountRef||
        identity.runner!=='CODEX_CLI'||identity.runtime!==selected.runtime||identity.roleId!==selected.id||
        identity.authentication!==authentication||identity.configurationHash!==hash(snapshot)||
        typeof identity.routeHash!=='string'||!/^[a-f0-9]{64}$/.test(identity.routeHash))
        throw new DomainError('REVIEW_ROLE_EVIDENCE_REQUIRED',409);
    return 'magpie';
}
/**
 * Explicit Planner 2 controller admission. It is derived only from the
 * original owned events and the current run identity, so a reviewer can bind
 * planning to this run without trusting a model claim. Absent for Demo runs and
 * for inherited (documentation-continuation) planning, which keeps its own
 * parent-packet evidence.
 */
export function planningAdmission(store:Store,run:Run,events?:{eventId:number;at:string;data:Record<string,unknown>}[]){
    // Demo template runs never emit owned Codex admission events; only a Live
    // Classic-style run has a real controller-owned Planner 2 session to bind.
    if(run.mode!=='live')return undefined;
    const identity=run.roleIdentities?.planner2;
    if(!identity)return undefined;
    // Only a Codex-owned Planner 2 emits dm/codexAdmission/dm/codexCompletion. A
    // Custom run may bind Planner 2 to a different runner (for example DSH), whose
    // session and budget receipts are proven through the shared AgentSession and
    // receipt path, so there is no Codex admission to look for. Demanding one here
    // would reject a valid Custom packet for evidence it was never supposed to have.
    if(identity.runner!=='CODEX_CLI')return undefined;
    const codexEvents=events??(()=>{
        const rows:{eventId:number;at:string;data:Record<string,unknown>}[]=[];
        for(const row of store.db.prepare("SELECT id,at,payload FROM events WHERE project_id=? AND run_id=? AND type='agent.event' AND json_extract(payload,'$.method') IN ('dm/codexAdmission','dm/codexCompletion') ORDER BY id").iterate(run.projectId,run.id))
            rows.push({eventId:Number(row.id),at:String(row.at),data:object(JSON.parse(String(row.payload)))});
        return rows;
    })();
    const fail=():never=>{throw new DomainError('REVIEW_ROLE_EVIDENCE_REQUIRED',409);};
    const eventProvider=codexEventProvider(run,'planner2',identity);
    const admission=codexEvents.filter(row=>{
        const p=object(row.data.params??{});
        return row.data.method==='dm/codexAdmission'&&p.role==='planner2'&&p.threadId===identity.sessionId&&
            p.model===identity.model&&p.provider===eventProvider&&p.authentication===identity.authentication&&
            p.includedUsageAllowed===true&&p.paidFallback===false&&
            typeof p.permissionProfile==='string'&&!!p.permissionProfile&&typeof p.policyHash==='string'&&/^[a-f0-9]{64}$/.test(p.policyHash);
    });
    if(admission.length!==1)fail();
    const completion=codexEvents.filter(row=>{
        const p=object(row.data.params??{});
        return row.data.method==='dm/codexCompletion'&&p.role==='planner2'&&p.threadId===identity.sessionId&&
            p.turnId===identity.requestId&&p.status==='completed'&&p.model===identity.model&&
            p.provider===eventProvider&&p.specHash===run.specHash&&p.runId===run.id;
    });
    if(completion.length!==1)fail();
    if(!(completion[0].eventId>admission[0].eventId))fail();
    const a=object(admission[0].data.params??{}),c=object(completion[0].data.params??{});
    return {
        schema:'dream-maker.planning-admission.v1',role:'planner2',status:'COMPLETED',
        runId:run.id,specHash:run.specHash,
        runner:identity.runner,provider:identity.provider,authentication:identity.authentication,model:identity.model,
        sessionId:identity.sessionId,requestId:identity.requestId,
        permissionProfile:String(a.permissionProfile),policyHash:String(a.policyHash),
        includedUsageAllowed:true,paidFallback:false,
        admissionEventId:admission[0].eventId,completionEventId:completion[0].eventId,
    };
}

function executionEvidence(store:Store,run:Run){
    const sessions=readMaterial(store,run,'AgentSession'),toolJournal=readMaterial(store,run,'ToolIntent','ToolResult'),
        modelReceipts=readMaterial(store,run,'NativeBudgetReceipt'),usage=readMaterial(store,run,'UsageLedger'),
        merges=readMaterial(store,run,'ExecutorWavePrepared','ExecutorSliceSealed','ExecutorMergeIntent','ExecutorMergeApplied');
    const codexEvents:{eventId:number;at:string;data:Record<string,unknown>}[]=[];let bytes=0;
    const events=store.db.prepare("SELECT id,at,payload FROM events WHERE project_id=? AND run_id=? AND type='agent.event' AND json_extract(payload,'$.method') IN ('dm/codexAdmission','dm/codexCompletion') ORDER BY id");
    for(const row of events.iterate(run.projectId,run.id)){
        if(typeof row.payload!=='string')throw new DomainError('REVIEW_RECORD_INVALID',409);
        bytes+=Buffer.byteLength(row.payload);if(bytes>PACKET_BYTES)throw new DomainError('REVIEW_PACKET_LIMIT',413);
        codexEvents.push({eventId:Number(row.id),at:String(row.at),data:object(JSON.parse(row.payload))});
    }
    const custody=partialRepairCustody(store,run),inheritedPlanning=run.documentationContinuation?inheritedDocumentationPlanning(store,run):undefined;
    const executorRoleIdentities=run.flowName==='custom'?verifiedExecutorRoleIdentities(run,store):[];
    const planning=inheritedPlanning?undefined:planningAdmission(store,run,codexEvents);
    const evidence={roleIdentities:run.roleIdentities,...(executorRoleIdentities.length?{executorRoleIdentities}:{}),sessions,toolJournal,modelReceipts,usage,merges,codexEvents,
        ...(planning?{planningAdmission:planning}:{}),...(custody?{incompleteTurnCustody:custody}:{}),...(inheritedPlanning?{inheritedPlanning}:{})};assertSafe(evidence);
    const executorEvidence=run.flowName==='custom'?executorRoleIdentities:[run.roleIdentities?.executor].filter((identity):identity is NonNullable<typeof identity>=>!!identity);
    for(const role of ['planner2','executor'] as const){
        // The helper rechecks the exact original session/usage/admission/completion
        // and frozen reviewed packet. It is explicit inherited evidence, never a
        // manufactured current AgentSession, and never satisfies current Executor.
        if(role==='planner2'&&inheritedPlanning)continue;
        const identity=role==='executor'&&run.flowName==='custom'?undefined:run.roleIdentities?.[role];
        if(role==='executor'&&run.flowName==='custom')continue;
        if(!identity||!identity.sessionId||!identity.requestId||run.sessions[role]!==identity.sessionId||!sessions.some(row=>{
            const d=object(row.data);return d.role===role&&d.sessionId===identity.sessionId&&d.modelEvidence==='ADAPTER_VERIFIED_RESPONSE'&&
                ['runner','provider','authentication','model'].every(key=>d[key]===identity[key as keyof typeof identity]);
        }))throw new DomainError('REVIEW_ROLE_EVIDENCE_REQUIRED',409);
        const eventProvider=identity.runner==='CODEX_CLI'?codexEventProvider(run,role,identity):identity.provider;
        if(identity.runner==='CODEX_CLI'&&(!codexEvents.some(row=>{
            const d=row.data,p=object(d.params??{});return d.method==='dm/codexAdmission'&&p.role===role&&p.threadId===identity.sessionId&&
                p.model===identity.model&&p.provider===eventProvider&&p.authentication===identity.authentication&&p.includedUsageAllowed===true&&p.paidFallback===false&&
                typeof p.permissionProfile==='string'&&!!p.permissionProfile&&typeof p.policyHash==='string'&&/^[a-f0-9]{64}$/.test(p.policyHash);
        })||!codexEvents.some(row=>{
            const d=row.data,p=object(d.params??{});return d.method==='dm/codexCompletion'&&p.role===role&&p.threadId===identity.sessionId&&
                p.turnId===identity.requestId&&p.status==='completed'&&p.model===identity.model&&p.provider===eventProvider&&p.specHash===run.specHash&&p.runId===run.id;
        })))throw new DomainError('REVIEW_ROLE_EVIDENCE_REQUIRED',409);
    }
    const completedRequests=modelReceipts.flatMap(row=>{
        const d=object(row.data),event=object(d.event??d),params=object(event.params??{});
        return event.method==='dm/budget'&&Array.isArray(params.requests)?params.requests.map(raw=>object(raw)).filter(request=>
            request.outcome==='COMPLETE'&&request.completionObserved===true&&request.responseModelMatched===true):[];
    });
    const receiptComplete=executorEvidence.length>0&&completedRequests.length>=executorEvidence.length&&
        executorEvidence.every(identity=>completedRequests.some(request=>request.observedModel===identity.model));
    const writeTools=new Set(['desk_write','desk_edit']);
    const completeWrites=toolJournal.filter(row=>{
        const result=object(row.data);
        if(row.kind!=='ToolResult'||result.status!=='COMPLETE'||!writeTools.has(String(result.tool)))return false;
        return toolJournal.some(intent=>{
            const request=object(intent.data);
            return intent.kind==='ToolIntent'&&intent.recordId===result.intentId&&request.tool===result.tool&&request.specHash===run.specHash;
        });
    });
    const effectCoverage=run.flowName==='custom'?checkedExecutorEffectCoverage(executorRoleIdentities,
        store.db.prepare("SELECT rowid ordinal,id,kind,data FROM records WHERE project_id=? AND run_id=? AND kind IN ('DispatchGranted','DispatchFinished','ToolIntent','ToolResult','ExecutorWavePrepared','ExecutorSliceSealed','ExecutorMergeIntent','ExecutorMergeApplied') ORDER BY rowid").all(run.projectId,run.id)
            .map(row=>({id:String(row.id),kind:String(row.kind),ordinal:Number(row.ordinal),data:object(JSON.parse(String(row.data)))})),run.specHash):undefined;
    const writesComplete=run.flowName==='custom'?effectCoverage?.length===executorRoleIdentities.length:completeWrites.length>0;
    if(!receiptComplete||!writesComplete)
        throw new DomainError('REVIEW_ROLE_EVIDENCE_REQUIRED',409);
    return {...evidence,...(effectCoverage?{executorEffectCoverage:effectCoverage}:{})};
}
function checkedSnapshot(raw:unknown,run:Run):Snapshot {
    const s=object(raw),{sha256,...body}=s;
    if(s.schema!=="dream-maker.source-snapshot.v1"||s.runId!==run.id||s.specHash!==run.specHash||
        !["BASELINE","EXECUTOR_BEFORE","EXECUTOR_AFTER","VERIFIER_INPUT"].includes(String(s.stage))||
        !Array.isArray(s.files)||sha256!==hash(body))throw new DomainError("REVIEW_SOURCE_SNAPSHOT_CORRUPT",409);
    const seen=new Set<string>();
    if(s.directories!==undefined){
        if(!Array.isArray(s.directories)||s.directories.length>2000)throw new DomainError('REVIEW_SOURCE_SNAPSHOT_CORRUPT',409);
        const dirs=new Set<string>();
        for(const path of s.directories){
            if(typeof path!=='string'||!path||path.startsWith('/')||/[\\:\0]/.test(path)||path.split('/').some(p=>!p||p==='..'||p==='.')||dirs.has(path))throw new DomainError('REVIEW_SOURCE_SNAPSHOT_CORRUPT',409);
            dirs.add(path);
        }
    }
    for(const rawFile of s.files){
        const f=object(rawFile);
        if(typeof f.path!=="string"||!f.path||f.path.startsWith("/")||/[\\:\0]/.test(f.path)||f.path.split("/").some(p=>!p||p===".."||p===".")||seen.has(f.path)||
            !["utf8","base64"].includes(String(f.encoding))||typeof f.content!=="string"||typeof f.bytes!=="number"||!Number.isSafeInteger(f.bytes)||f.bytes<0)
            throw new DomainError("REVIEW_SOURCE_SNAPSHOT_CORRUPT",409);
        seen.add(f.path);
        const bytes=Buffer.from(f.content,f.encoding as "utf8"|"base64");
        if(bytes.length!==f.bytes||hash(bytes)!==f.sha256||bytes.toString(f.encoding as "utf8"|"base64")!==f.content)
            throw new DomainError("REVIEW_SOURCE_SNAPSHOT_CORRUPT",409);
    }
    const snapshot=s as unknown as Snapshot;
    if(hash(metadata(snapshot.files))!==snapshot.treeHash)throw new DomainError("REVIEW_SOURCE_SNAPSHOT_CORRUPT",409);
    assertSafe(snapshot);return snapshot;
}
/** Raw reconciliation is not an AgentSession. Keep the failed turn incomplete,
 * and expose its byte-bound retention and a separate later completed adoption. */
function partialRepairCustody(store:Store,run:Run){
    const records=readMaterial(store,run,'PartialRepairContinuation','PartialRepairAdmissionRecovery');if(!records.length)return null;
    const fail=():never=>{throw new DomainError('REVIEW_CUSTODY_EVIDENCE_INCOMPLETE',409);};
    const sha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
    const expected=run.roleIdentities?.executor;
    const admissionOnly=records.length===1&&records[0].kind==='PartialRepairAdmissionRecovery';
    if(run.mode!=='live'||run.flowName!=='classic'||!expected||records.length>2||!admissionOnly&&(records[0].kind!=='PartialRepairContinuation'||records.length===2&&records[1].kind!=='PartialRepairAdmissionRecovery'))return fail();
    const rows=readMaterial(store,run,'PartialRepairContinuation','PartialRepairAdmissionRecovery','DispatchGranted','DispatchFinished','OwnedProcessIntent','OwnedProcessCleanup','ToolIntent','ToolResult','NativeBudgetReceipt','AgentSession','Review','SourceSnapshot')
        .map((row,index)=>({row,index,value:object(row.data)}));
    const chain=(dispatchId:unknown,outcome:string)=>{
        const grants=rows.filter(r=>r.row.kind==='DispatchGranted'&&r.value.dispatchId===dispatchId),ends=rows.filter(r=>r.row.kind==='DispatchFinished'&&r.value.dispatchId===dispatchId);
        if(typeof dispatchId!=='string'||!dispatchId||grants.length!==1||ends.length!==1)return fail();
        const grant=grants[0],end=ends[0],g=grant.value;
        if(g.kind!=='executor'||g.mode!=='live'||typeof g.generation!=='string'||!g.generation||end.index<=grant.index||end.value.generation!==g.generation||end.value.outcome!==outcome||end.value.cleanupReturned!==true)return fail();
        const during=rows.slice(grant.index+1,end.index),processes=during.filter(r=>r.row.kind==='OwnedProcessIntent');
        if(!processes.length||new Set(processes.map(p=>p.value.processId)).size!==processes.length||processes.some(p=>{
            const cleanups=rows.filter(r=>r.row.kind==='OwnedProcessCleanup'&&r.value.processId===p.value.processId);
            return typeof p.value.processId!=='string'||!p.value.processId||rows.filter(r=>r.row.kind==='OwnedProcessIntent'&&r.value.processId===p.value.processId).length!==1||p.value.dispatchId!==dispatchId||p.value.generation!==g.generation||cleanups.length!==1||
                cleanups[0].index<=p.index||cleanups[0].index>=end.index||cleanups[0].value.dispatchId!==dispatchId||cleanups[0].value.generation!==g.generation||cleanups[0].value.cleanupReturned!==true;
        }))return fail();
        return {grant,end,during};
    };
    const links:Record<string,unknown>[]=[],related=new Set<string>();
    const toolSource=(during:typeof rows,from:unknown)=>{
        const intents=during.filter(r=>r.row.kind==='ToolIntent'),results=during.filter(r=>r.row.kind==='ToolResult');let source=from;
        if(results.length!==intents.length)return fail();
        for(const intent of intents){const matches=results.filter(r=>r.value.intentId===intent.row.recordId);if(matches.length!==1)return fail();const result=matches[0],v=result.value;
            if(!['desk_read','desk_list','desk_search','desk_write','desk_edit','desk_run'].includes(String(intent.value.tool))||intent.value.specHash!==run.specHash||intent.value.sourceHash!==source||v.tool!==intent.value.tool||result.index<=intent.index)return fail();
            if(v.status==='COMPLETE'){if(v.specHash!==run.specHash||!sha(v.sourceHash))return fail();source=v.sourceHash;}
            else if(v.status!=='FAILED_NO_EFFECT'||typeof v.code!=='string'||!/^[A-Z][A-Z0-9_]{1,100}$/.test(v.code)||v.sourceHash!==undefined&&v.sourceHash!==source)return fail();
        }return source;
    };
    const checkedModelReceipts=(during:typeof rows)=>{
        const receipts=during.filter(r=>r.row.kind==='NativeBudgetReceipt');
        const requests=receipts.flatMap(r=>{const p=object(r.value.params??{});if(r.value.method!=='dm/budget'||!Array.isArray(p.requests))return fail();return p.requests.map(raw=>object(raw));});
        if(requests.some(q=>q.responseModelMatched===false||q.observedModel!==undefined&&q.observedModel!==null&&q.observedModel!==''&&q.observedModel!==expected.model)||
            !requests.some(q=>q.observedModel===expected.model&&q.outcome==='COMPLETE'&&q.completionObserved===true&&q.responseModelMatched===true))return fail();
        return receipts;
    };
    for(const [number,record]of records.entries()){
        const entry=rows.find(r=>r.row.recordId===record.recordId)!;if(!entry)return fail();const d=entry.value,proof=object(d.proof??{}),snapshot=checkedSnapshot(d.source,run);
        if(d.schema!=='dream-maker.partial-repair-continuation.v1'||!sha(d.sourceHash)||!sha(d.previousSourceHash)||!sha(d.basisHash)||!sha(d.actorHash)||
            d.automaticRetry!==false||d.taskCompletionAssumed!==false||d.modelDispatched!==false||snapshot.stage!=='EXECUTOR_BEFORE'||snapshot.treeHash!==d.sourceHash||
            !Number.isSafeInteger(d.calls)||Number(d.calls)<0||Number(d.calls)>run.calls||!Number.isSafeInteger(d.repairCount)||Number(d.repairCount)>run.repairCount||d.repairCount!==d.maxRepairs||
            proof.schema!=='dream-maker.dispatch-recovery.v1'||proof.dispatchId!==d.dispatchId||proof.proven!==true||!sha(proof.basisSha256)||!Array.isArray(d.toolResults))return fail();
        const failed=chain(d.dispatchId,'RUNNER_RPC_ERROR');if(failed.end.index>=entry.index||rows.some(r=>r.row.kind==='AgentSession'&&r.value.dispatchId===d.dispatchId))return fail();
        related.add(String(d.dispatchId));
        const intents=failed.during.filter(r=>r.row.kind==='ToolIntent'),results=failed.during.filter(r=>r.row.kind==='ToolResult');
        const receipts=failed.during.filter(r=>r.row.kind==='NativeBudgetReceipt');
        if(hash(results.map(r=>r.row.recordId))!==hash(d.toolResults))return fail();
        if(number===0&&d.admissionRecovery!==true){
            if(d.admissionRecovery!==undefined&&d.admissionRecovery!==false||!intents.length||results.length!==intents.length||
                !rows.some(r=>r.index<failed.grant.index&&r.row.kind==='Review'&&r.value.source==='CODEX'&&r.value.verdict==='CHANGES_REQUESTED'&&r.value.treeHash===d.previousSourceHash))return fail();
            const source=toolSource(failed.during,d.previousSourceHash);
            if(source!==d.sourceHash)return fail();checkedModelReceipts(failed.during);
        }else{
            const first=object(records[0].data);
            const emptyReceipts=receipts.length>=1&&receipts.length<=3&&receipts.every(receipt=>{
                const requests=object(receipt.value.params??{}).requests;
                return receipt.value.method==='dm/budget'&&Array.isArray(requests)&&requests.length===0;
            });
            if(d.admissionRecovery!==true||d.previousSourceHash!==first.sourceHash||d.sourceHash!==first.sourceHash||intents.length||results.length||!emptyReceipts)return fail();
        }
        const adoption=rows.filter(r=>r.index>entry.index&&r.row.kind==='AgentSession'&&r.value.role==='executor'&&r.value.modelEvidence==='ADAPTER_VERIFIED_RESPONSE'&&
            ['runner','provider','authentication','model'].every(key=>r.value[key]===expected[key as keyof typeof expected])).flatMap(session=>{
            const completed=chain(session.value.dispatchId,'COMPLETED');
            if(completed.grant.index<=entry.index||session.index<=completed.end.index||session.value.generation!==completed.grant.value.generation||typeof session.value.sessionId!=='string'||!session.value.sessionId)return [];
            const before=rows.filter(r=>r.index<completed.grant.index&&r.row.kind==='SourceSnapshot').at(-1),after=rows.find(r=>r.index>session.index&&r.row.kind==='SourceSnapshot'),nextGrant=rows.find(r=>r.index>session.index&&r.row.kind==='DispatchGranted');
            if(!before||!after||before.index<=entry.index||nextGrant&&nextGrant.index<after.index)return [];
            const a=checkedSnapshot(before.value,run),b=checkedSnapshot(after.value,run);
            return a.stage==='EXECUTOR_BEFORE'&&a.treeHash===snapshot.treeHash&&a.sha256===snapshot.sha256&&b.stage==='EXECUTOR_AFTER'&&toolSource(completed.during,a.treeHash)===b.treeHash?[{session,before,after,completed}]:[];
        })[0];
        if(!adoption)return fail();const adoptingReceipts=checkedModelReceipts(adoption.completed.during);related.add(String(adoption.session.value.dispatchId));
        links.push({custodyRecordId:record.recordId,failedDispatchId:d.dispatchId,retainedSourceHash:d.sourceHash,retainedSnapshotHash:snapshot.sha256,toolResultRecordIds:d.toolResults,modelReceiptRecordIds:receipts.map(r=>r.row.recordId),
            adoptingSessionRecordId:adoption.session.row.recordId,adoptingDispatchId:adoption.session.value.dispatchId,adoptingModelReceiptRecordIds:adoptingReceipts.map(r=>r.row.recordId),beforeSnapshotRecordId:adoption.before.row.recordId,afterSnapshotRecordId:adoption.after.row.recordId});
    }
    return {schema:'dream-maker.partial-source-custody.v1',failedAgentSessionCompletion:'NOT_RECORDED',modelDispatchedFlagScope:'RECONCILIATION_ACTION_ONLY',historicalProofScope:'ORIGINAL_RECORD_NOT_REEXECUTED',
        records,links,relatedJournal:rows.filter(r=>['DispatchGranted','DispatchFinished','OwnedProcessIntent','OwnedProcessCleanup'].includes(r.row.kind)&&related.has(String(r.value.dispatchId))).map(r=>r.row),
        reviewHistory:rows.filter(r=>r.row.kind==='Review').map(r=>r.row)};
}
export function buildReviewPacket(store:Store,run:Run,spec:Spec){
    if(spec.id!==run.specId||spec.hash!==run.specHash||spec.stale)throw new DomainError("REVIEW_SPEC_BINDING_CHANGED",409);
    const sourceRecords=readMaterial(store,run,"SourceSnapshot");
    const sourceHistory=sourceRecords.map(row=>({recordId:row.recordId,...checkedSnapshot(row.data,run)}));
    if(!sourceHistory.length||sourceHistory[0].stage!=="BASELINE"||sourceHistory.filter(s=>s.stage==="BASELINE").length!==1)
        throw new DomainError("REVIEW_SOURCE_BASELINE_REQUIRED",409);
    // No partial/context-window trimming: incomplete review must not pass.
    if(Buffer.byteLength(JSON.stringify(sourceHistory))>PACKET_BYTES)throw new DomainError("REVIEW_PACKET_LIMIT",413);
    const current=sourceHistory.at(-1)!;
    if(current.stage!=="VERIFIER_INPUT"||current.treeHash!==run.treeHash||current.treeHash!==treeHash(run.workspace)||
        current.directories!==undefined&&hash(current.directories)!==hash(captureDirectories(run.workspace)))
        throw new DomainError("REVIEW_SOURCE_TREE_MISMATCH",409);
    const rawTests=readMaterial(store,run,"Evidence").map(row=>({recordId:row.recordId,data:object(row.data)}));
    const latest=rawTests.at(-1);
    if(!latest||latest.recordId!==run.verification?.evidenceId||!run.verification.ok||latest.data.treeHash!==current.treeHash||latest.data.code!==0)
        throw new DomainError("REVIEW_RAW_EVIDENCE_REQUIRED",409);
    for(const {data} of rawTests){
        if(data.specHash!==run.specHash||!sourceHistory.some(s=>s.stage==="VERIFIER_INPUT"&&s.treeHash===data.treeHash)||
            data.scope!==(run.mode==="live"?"LIVE_VERIFIER":"DEMO_TEMPLATE_ONLY")||
            !Array.isArray(data.command)||!data.command.length||data.command.some(c=>typeof c!=="string"||!c)||
            typeof data.stdout!=="string"||typeof data.stderr!=="string"||!Number.isSafeInteger(data.code))
            throw new DomainError("REVIEW_RAW_EVIDENCE_REQUIRED",409);
    }
    let verifierApproval:{recordId:string;planHash:string;data:unknown}|undefined,execution:ReturnType<typeof executionEvidence>|undefined,
        approvalEvidence:ReturnType<typeof reviewApprovalEvidence>|undefined,acceptanceEvidence:ReturnType<typeof buildAcceptanceEvidence>|undefined,
        observedCases:readonly unknown[]=[];
    if(run.mode==='live'){
        approvalEvidence=reviewApprovalEvidence(store,run,spec,sourceRecords[0].at);
        for(const {data} of rawTests){
            const complete=completeRawEvidence(data,sourceHistory.find(s=>s.stage==='VERIFIER_INPUT'&&s.treeHash===data.treeHash)!,spec),raw=complete.raw;
            verifierApproval=verifierApprovalFor(store,run,String(raw.planHash));
            if(run.verification?.evidenceId===latest.recordId)
            {
                acceptanceEvidence=buildAcceptanceEvidence({spec,plan:complete.plan,observed:raw.cases as unknown[],evidenceId:latest.recordId,
                    planHash:String(raw.planHash),sourceHash:String(raw.sourceHash)});
                observedCases=Array.isArray(raw.cases)?raw.cases as unknown[]:[];
            }
        }
        execution=executionEvidence(store,run);
    }
    const changes=sourceHistory.slice(1).map((after,index)=>{
        const before=sourceHistory[index],old=new Map(before.files.map(f=>[f.path,f])),next=new Map(after.files.map(f=>[f.path,f]));
        const entries=[...new Set([...old.keys(),...next.keys()])].sort().flatMap(path=>{
            const a=old.get(path),b=next.get(path);
            return a?.sha256===b?.sha256?[]:[{path,kind:!a?"added":!b?"deleted":"modified",beforeSha256:a?.sha256??null,afterSha256:b?.sha256??null}];
        });
        return {beforeRecordId:before.recordId,afterRecordId:after.recordId,entries};
    });
    const materials=preworkReviewMaterials(store,run);
    const prework=materials&&acceptanceEvidence?{...materials,requiredCoverage:requiredPreworkReviewCoverage(materials.contract,acceptanceEvidence,spec.acceptanceItems??[],observedCases)}:materials;
    // rawTests already holds every verification this run performed, but each record's
    // `attempt` is the run-wide step index, not a verifier retry counter. A reviewer
    // that cannot tell "the first verification step passed" from "earlier attempts
    // were withheld" will block on history that never existed, so state the
    // completeness and the field meaning explicitly. This adds no new evidence.
    const verificationHistory={scope:"COMPLETE" as const,attemptField:"RUN_STEP_INDEX" as const,
        note:"Every trusted-verifier execution recorded for this run is present, in order. Each rawTests entry's attempt value is the run-wide step index at verification time, not a 1-based verifier attempt count, so gaps between it and rawTests.length are expected.",
        count:rawTests.length,evidenceRecordIds:rawTests.map(row=>row.recordId),latestRecordId:latest.recordId};
    const packet={schema:"dream-maker.review-packet.v1",runId:run.id,specHash:run.specHash,spec,plan:run.plan,...(prework?{prework}:{}),
        scope:{excludedDirectories:[".git","node_modules"],completeWithinWorkspacePolicy:true,toolsAllowed:false},
        sourceHistory,changes,rawTests,verificationHistory,findings:run.findings,...(execution?{executionEvidence:execution,verifierApproval,approvalEvidence}:{}),
        ...(acceptanceEvidence?{acceptanceEvidence}:{}),
        ...(run.reviewWindow?{reviewWindowApproval:reviewWindowEvidence(store,run)}:{}),
        ...(run.reviewOnlyWindow?{reviewOnlyWindowApproval:reviewOnlyWindowEvidence(store,run)}:{}),
        ...(run.reviewSupplement?{reviewSupplementApproval:reviewSupplementEvidence(store,run)!.approval}:{})};
    const wire=Buffer.byteLength(JSON.stringify(packet))>WIRE_PACKET_BYTES?poolReviewSources(packet):packet;
    if(Buffer.byteLength(JSON.stringify(wire))>WIRE_PACKET_BYTES)throw new DomainError("REVIEW_PACKET_LIMIT",413);
    assertSafe(wire);
    return wire;
}
