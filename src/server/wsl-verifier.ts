import { readFileSync, mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { WslSandbox, validateSandboxCommand, type SandboxCommand, type SandboxResult } from './wsl-sandbox.js';
import { DomainError, object, text, hash, within, redact,hasSecret,canonical } from './security.js';
import type { AgentInput } from '../shared/types.js';
import { treeHash } from './workspace.js';
import { assertReviewMaterialSafe } from './review-material.js';

export interface VerifierCase extends SandboxCommand {
    id: string;
    requirementIds: string[];
    /** Explicit owner-confirmed acceptance items this case is intended to exercise. */
    acceptanceIds?: string[];
    expectedExitCode: number;
    /** Exact stdout. Mutually exclusive with expectedStdoutPrefix. */
    expectedStdout?: string;
    /**
     * Stdout must START WITH this text. The approved spec often says "prints one line starting with
     * USAGE" — demanding byte equality there made a spec-correct implementation fail
     * (FINDING_20261030_ORACLE_PLAN_UNSATISFIABLE.md). Exactly one of the two must be present.
     */
    expectedStdoutPrefix?: string;
    /**
     * Exact stderr. The spec pins `ERROR <code>` lines for failures, and asserting only the exit code
     * let a case that produced no diagnostic at all pass: C6/C7/C8 in the previous plan asked for exit 3
     * with empty stdout, which an implementation that answered every command with exit 3 satisfied
     * (FINDING_20261030_ORACLE_PLAN_UNSATISFIABLE.md).
     */
    expectedStderr?: string;
    /** Stderr must START WITH this text, for codes the spec leaves open but a line it still demands. */
    expectedStderrPrefix?: string;
    /**
     * Stdout must MATCH this regular expression source. R005 (USER_CONFIRMED) makes every date flag default
     * to the machine's local day, so the output of `tick water --file w.json` is correct yet unknowable when
     * the plan is written — a literal would either be wrong tomorrow or freeze the clock. run_92f9a3910692ee861c1d
     * shipped a tick that answered ERROR BAD_DATE for the omitted flag and only the reviewer caught it,
     * because the oracle had no way to say 'any real date'. The plan anchors the pattern itself.
     */
    expectedStdoutMatch?: string;
    /** Exact JSON value; object key order and whitespace are not a project requirement. */
    expectedJson?: unknown;
    /** Bounded controller expression for diagnostics whose wording the spec leaves open. */
    expectedStderrMatch?: string;
    /**
     * Files written into the case's OWN copy of the workspace before the measured command.
     *
     * The plan used to declare setup COMMANDS (`add` before `tick`), and that can never work here: the
     * sandbox runs every command against a staged copy and DISCARDS its writes, then proves the tree did
     * not change (`sourceUnchanged`). Measured directly — a program that wrote made.txt returned
     * sourceUnchanged:true and left no file behind. So the state a case asserts on has to be data the
     * verifier itself writes, which is also closer to the spec: R006 pins the JSON storage format
     * { "items": { "<name>": ["YYYY-MM-DD", ...] } }.
     */
    fixtures?: Record<string,string>;
}
export interface VerifierPlan {schema:'dream-maker.cli-verifier.v1';specHash:string;cases:VerifierCase[]}
export interface VerifierAcceptanceBinding {id:string;requirementIds:string[]}
export interface VerifierCaseEvidence {
    input:{runtime:'node'|'python';entry:string;args:string[];stdin:string;fixtures?:Record<string,string>};
    expected:Record<string,unknown>;
}
export function verifierCaseEvidence(c:VerifierCase):VerifierCaseEvidence {
    const input:VerifierCaseEvidence['input']={runtime:c.runtime,entry:c.entry,args:[...c.args],stdin:c.stdin,...(c.fixtures?{fixtures:{...c.fixtures}}:{})};
    const expected:Record<string,unknown>={exitCode:c.expectedExitCode};
    if(c.acceptanceIds!==undefined)expected.acceptanceIds=[...c.acceptanceIds];
    if(Object.hasOwn(c,'expectedJson'))expected.json=c.expectedJson;
    else if(c.expectedStdout!==undefined)expected.stdout=c.expectedStdout;
    else if(c.expectedStdoutPrefix!==undefined)expected.stdoutPrefix=c.expectedStdoutPrefix;
    else if(c.expectedStdoutMatch!==undefined)expected.stdoutMatch=c.expectedStdoutMatch;
    if(c.expectedStderr!==undefined)expected.stderr=c.expectedStderr;
    else if(c.expectedStderrPrefix!==undefined)expected.stderrPrefix=c.expectedStderrPrefix;
    else if(c.expectedStderrMatch!==undefined)expected.stderrMatch=c.expectedStderrMatch;
    return {input,expected};
}
export function validateVerifierPlan(raw:unknown,specHash:string,required:string[],acceptance:readonly VerifierAcceptanceBinding[]=[]):VerifierPlan {
    const v=object(raw),used=new Set<string>(),coverage=new Set<string>();
    const acceptanceById=new Map<string,string[]>();
    for(const rawAcceptance of acceptance){
        const item=object(rawAcceptance),id=text(item.id,64);
        if(acceptanceById.has(id)||!Array.isArray(item.requirementIds)||!item.requirementIds.length||
            item.requirementIds.some(r=>typeof r!=='string'||!required.includes(r))||new Set(item.requirementIds).size!==item.requirementIds.length)
            throw new DomainError('TRUSTED_VERIFIER_ACCEPTANCE_INVALID',409);
        acceptanceById.set(id,[...item.requirementIds] as string[]);
    }
    if(v.schema!=='dream-maker.cli-verifier.v1'||v.specHash!==specHash||!Array.isArray(v.cases)||!v.cases.length||v.cases.length>20)
        throw new DomainError('TRUSTED_VERIFIER_PLAN_INVALID',409);
    const cases=v.cases.map(rawCase=>{
        const c=object(rawCase),id=text(c.id,80);
        if(used.has(id)||!Array.isArray(c.requirementIds)||!c.requirementIds.length||c.requirementIds.some(r=>typeof r!=='string'||!required.includes(r))||
            !Number.isInteger(c.expectedExitCode)||Math.abs(c.expectedExitCode as number)>255)throw new DomainError('TRUSTED_VERIFIER_CASE_INVALID',409);
        used.add(id);c.requirementIds.forEach(r=>coverage.add(r as string));
        let acceptanceIds:string[]|undefined;
        if(Object.hasOwn(c,'acceptanceIds')){
            if(!Array.isArray(c.acceptanceIds)||!c.acceptanceIds.length||c.acceptanceIds.length>acceptance.length||
                c.acceptanceIds.some(value=>typeof value!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value))||
                new Set(c.acceptanceIds).size!==c.acceptanceIds.length)
                throw new DomainError('TRUSTED_VERIFIER_ACCEPTANCE_INVALID',409);
            acceptanceIds=[...c.acceptanceIds] as string[];
            for(const acceptanceId of acceptanceIds){
                const requirements=acceptanceById.get(acceptanceId);
                if(!requirements||requirements.some(requirement=>!(c.requirementIds as string[]).includes(requirement)))
                    throw new DomainError('TRUSTED_VERIFIER_ACCEPTANCE_INVALID',409);
            }
        }
        const command=validateSandboxCommand({runtime:c.runtime,entry:c.entry,args:c.args,stdin:c.stdin});
        const exact=typeof c.expectedStdout==='string',prefix=typeof c.expectedStdoutPrefix==='string',match=typeof c.expectedStdoutMatch==='string',json=Object.hasOwn(c,'expectedJson');
        if([exact,prefix,match,json].filter(Boolean).length!==1||(exact&&(c.expectedStdout as string).length>65536)||(prefix&&(c.expectedStdoutPrefix as string).length>65536))
            throw new DomainError('TRUSTED_VERIFIER_OUTPUT_INVALID',409);
        let expectedJson:unknown;if(json)try{expectedJson=JSON.parse(jsonWire(c.expectedJson));}catch{throw new DomainError('TRUSTED_VERIFIER_OUTPUT_INVALID',409);}
        if(match){
            if((c.expectedStdoutMatch as string).length>300)throw new DomainError('TRUSTED_VERIFIER_OUTPUT_INVALID',409);
            try{new RegExp(c.expectedStdoutMatch as string);}catch{throw new DomainError('TRUSTED_VERIFIER_OUTPUT_INVALID',409);}
        }
        const errExact=typeof c.expectedStderr==='string',errPrefix=typeof c.expectedStderrPrefix==='string',errMatch=typeof c.expectedStderrMatch==='string';
        if(Object.hasOwn(c,'expectedStderrMatch')&&!errMatch)throw new DomainError('TRUSTED_VERIFIER_DIAGNOSTIC_INVALID',409);
        if([errExact,errPrefix,errMatch].filter(Boolean).length>1||(errExact&&(c.expectedStderr as string).length>65536)||(errPrefix&&(c.expectedStderrPrefix as string).length>65536))
            throw new DomainError('TRUSTED_VERIFIER_DIAGNOSTIC_INVALID',409);
        if(errMatch){
            if((c.expectedStderrMatch as string).length>300)throw new DomainError('TRUSTED_VERIFIER_DIAGNOSTIC_INVALID',409);
            try{new RegExp(c.expectedStderrMatch as string);}catch{throw new DomainError('TRUSTED_VERIFIER_DIAGNOSTIC_INVALID',409);}
        }
        const fixtures=readFixtures(c.fixtures,command.entry);
        return {...command,id,requirementIds:c.requirementIds as string[],expectedExitCode:c.expectedExitCode as number,
            ...(acceptanceIds?{acceptanceIds}:{}),
            ...(json?{expectedJson}:exact?{expectedStdout:c.expectedStdout as string}:match?{expectedStdoutMatch:c.expectedStdoutMatch as string}:{expectedStdoutPrefix:c.expectedStdoutPrefix as string}),
            ...(errExact?{expectedStderr:c.expectedStderr as string}:errPrefix?{expectedStderrPrefix:c.expectedStderrPrefix as string}:errMatch?{expectedStderrMatch:c.expectedStderrMatch as string}:{}),
            ...(Object.keys(fixtures).length?{fixtures}:{})};
    });
    if(required.some(r=>!coverage.has(r)))throw new DomainError('TRUSTED_VERIFIER_COVERAGE_MISSING',409);
    return {schema:'dream-maker.cli-verifier.v1',specHash,cases};
}
/** A fixture path is held to the same rule as the entry: a plain relative path of safe segments. */
const SAFE_SEGMENT=/^[A-Za-z0-9_.-]+$/;
function safeRelative(value:string){
    return SAFE_SEGMENT.test(value.split('/').pop() ?? '')&&/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value)&&
        !value.split('/').some(s=>s==='.'||s==='..'||s==='node_modules'||s==='.git'||/^\.env(?:\.|$)/i.test(s));
}
function readFixtures(raw:unknown,entry:string):Record<string,string> {
    if(raw===undefined)return {};
    const v=object(raw),keys=Object.keys(v);
    if(!keys.length||keys.length>4||keys.some(k=>!safeRelative(k)||k===entry))throw new DomainError('TRUSTED_VERIFIER_FIXTURE_INVALID',409);
    const out:Record<string,string>={};let total=0;
    for(const key of keys){
        const content=v[key];
        if(typeof content!=='string'||content.length>8192)throw new DomainError('TRUSTED_VERIFIER_FIXTURE_INVALID',409);
        total+=content.length;out[key]=content;
    }
    if(total>16384)throw new DomainError('TRUSTED_VERIFIER_FIXTURE_INVALID',409);
    return out;
}
function jsonWire(value:unknown):string {
    const wire=JSON.stringify(value,(_key,v)=>{
        if(['undefined','function','symbol','bigint'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v))throw new Error('non-json');return v;
    });
    if(typeof wire!=='string'||Buffer.byteLength(wire)>65536)throw new Error('json-limit');return wire;
}
function jsonMatches(stdout:string,expected:unknown):boolean {
    try{if(Buffer.byteLength(stdout)>65536)return false;const actual=JSON.parse(stdout);jsonWire(actual);return canonical(actual)===canonical(expected);}catch{return false;}
}
export function checkVerifierCase(c:VerifierCase,result:Pick<SandboxResult,'exitCode'|'stdout'|'stderr'>) {
    const matched=Object.hasOwn(c,'expectedJson')?jsonMatches(result.stdout,c.expectedJson):c.expectedStdoutPrefix!==undefined?result.stdout.startsWith(c.expectedStdoutPrefix)
        :c.expectedStdoutMatch!==undefined?new RegExp(c.expectedStdoutMatch).test(result.stdout)
        :result.stdout===c.expectedStdout;
    // Undeclared stderr is not asserted: the spec only demands the ERROR line on FAILURES, and a passing
    // command is free to keep stderr empty or use it for warnings.
    const diagnosticMatched=c.expectedStderrMatch!==undefined?new RegExp(c.expectedStderrMatch).test(result.stderr):c.expectedStderrPrefix!==undefined?result.stderr.startsWith(c.expectedStderrPrefix)
        :c.expectedStderr!==undefined?result.stderr===c.expectedStderr:true;
    return {id:c.id,requirementIds:c.requirementIds,...(c.acceptanceIds!==undefined?{acceptanceIds:[...c.acceptanceIds]}:{}),ok:result.exitCode===c.expectedExitCode&&matched&&diagnosticMatched,
        expectedExitCode:c.expectedExitCode,actualExitCode:result.exitCode,outputMatched:matched,diagnosticMatched};
}
export class WslVerifier {
    private sandbox:WslSandbox;
    constructor(root:string,private registryRoot:string,private approved:(specHash:string)=>{relativePath:string;sha256:string}|null) {this.sandbox=new WslSandbox(root);}
    async verify(input:AgentInput,emit:(e:unknown)=>void):Promise<{command:string[];stdout:string;stderr:string;exitCode:number}> {
        if(!/^[a-f0-9]{64}$/.test(input.specHash))throw new DomainError('VERIFIER_SPEC_BINDING_INVALID',409);
        const approval=this.approved(input.specHash);if(!approval)throw new DomainError('TRUSTED_VERIFIER_APPROVAL_REQUIRED',409);
        const bytes=readFileSync(within(this.registryRoot,approval.relativePath));
        if(hash(bytes)!==approval.sha256)throw new DomainError('TRUSTED_VERIFIER_PLAN_CHANGED',409);
        const payload=object(JSON.parse(input.prompt)),spec=object(payload.spec);
        if(spec.hash!==input.specHash||!Array.isArray(spec.requirements))throw new DomainError('VERIFIER_SPEC_BINDING_INVALID',409);
        const planText=bytes.toString('utf8');
        if(!Buffer.from(planText).equals(bytes))throw new DomainError('TRUSTED_VERIFIER_PLAN_CHANGED',409);
        const required=spec.requirements.map(r=>text(object(r).id,80));
        const acceptance=Array.isArray(spec.acceptanceItems)?spec.acceptanceItems.map(rawItem=>{
            const item=object(rawItem);
            return {id:text(item.id,64),requirementIds:Array.isArray(item.requirementIds)?item.requirementIds.map(value=>text(value,64)):[]};
        }):[];
        const plan=validateVerifierPlan(JSON.parse(planText),input.specHash,required,acceptance);
        if(hasSecret(planText)||redact(planText)!==planText)throw new DomainError('REVIEW_SECRET_IN_MATERIAL',403);
        assertReviewMaterialSafe(planText);
        const frozenTree=treeHash(input.workspace),evidence=[];let stderr='';
        const material={schema:'dream-maker.trusted-cli-evidence.v2',specHash:input.specHash,sourceHash:frozenTree,planHash:approval.sha256,planText};
        for(const c of plan.cases){
            if(input.signal.aborted)throw new DomainError('RUN_CANCELLED',409);
            if(treeHash(input.workspace)!==frozenTree)throw new DomainError('VERIFIER_SOURCE_CHANGED',409);
            const caseDir=mkdtempSync(join(tmpdir(),'dm-verify-case-'));
            let result:SandboxResult;
            try{
                cpSync(input.workspace,caseDir,{recursive:true});
                // Fixtures are written by the verifier, not by a setup command: the sandbox discards every
                // write a case makes, so only data this process puts in the copy can be asserted on.
                for(const [relative,content] of Object.entries(c.fixtures??{})){
                    const target=join(caseDir,...relative.split('/'));
                    mkdirSync(dirname(target),{recursive:true});
                    writeFileSync(target,content);
                }
                const caseTree=treeHash(caseDir);
                result=await this.sandbox.run(caseDir,{runtime:c.runtime,entry:c.entry,args:c.args,stdin:c.stdin},{signal:input.signal});
                if(input.signal.aborted||result.status==='CANCELLED')throw new DomainError('RUN_CANCELLED',409);
                if(result.sourceHash!==caseTree)throw new DomainError('VERIFIER_SOURCE_CHANGED',409);
            } finally { rmSync(caseDir,{recursive:true,force:true}); }
            if(!Array.isArray(result.command)||result.command.some(a=>typeof a!=='string'))throw new DomainError('VERIFIER_COMMAND_EVIDENCE_MISSING',502);
            const command=result.command;
            if(hasSecret(result.stdout)||hasSecret(result.stderr)||redact(result.stdout)!==result.stdout||redact(result.stderr)!==result.stderr)
                throw new DomainError('REVIEW_SECRET_IN_MATERIAL',403);
            assertReviewMaterialSafe([result.stdout,result.stderr]);
            const checked=checkVerifierCase(c,result);
            const outcome={...checked,...verifierCaseEvidence(c),ok:checked.ok&&result.status==='EXECUTED',command,stdinHash:hash(c.stdin),jobId:result.jobId,sourceHash:result.sourceHash,workerHash:result.workerHash,status:result.status,stdout:result.stdout,stderr:result.stderr,stderrTail:result.stderr.slice(-2000),fixtureCount:Object.keys(c.fixtures??{}).length};
            // Formal review receives complete bytes or a refusal. Progress rendering may stay short.
            if(Buffer.byteLength(JSON.stringify({...material,ok:false,cases:[...evidence,outcome]}))>512000)
                throw new DomainError('REVIEW_RAW_EVIDENCE_LIMIT',413);
            evidence.push(outcome);
            // A failing case must name itself: the executor only ever sees stderr when it is asked to repair,
            // and 'ERROR BAD_ARGS' alone never said which case or which expectation failed.
            stderr+=result.stderr;
            if(!outcome.ok){
                // Name the data file the case asked for when the delivered tree does not have it. The
                // executor reads this only when it is asked to repair, and 'CASE C2 ... ERROR NO_DATA' did
                // not say that the missing thing was a file the delivery was supposed to ship.
                const at=(c.args??[]).indexOf('--file'),wanted=at>=0?c.args[at+1]:undefined;
                const missing=typeof wanted==='string'&&wanted.length>0&&!existsSync(join(input.workspace,wanted))?` missing=${wanted}`:'';
                stderr+=`CASE ${c.id} expectedExit=${c.expectedExitCode} actualExit=${result.exitCode} stdoutMatched=${outcome.outputMatched} stderrMatched=${outcome.diagnosticMatched}${missing}${c.fixtures?' fixtures='+Object.keys(c.fixtures).length:''}\n`;
            }
            emit({type:'trusted-verifier.case',runId:input.runId,specHash:input.specHash,...outcome,stdout:outcome.stdout.slice(0,4000),stderr:undefined});
        }
        if(treeHash(input.workspace)!==frozenTree)throw new DomainError('VERIFIER_SOURCE_CHANGED',409);
        const ok=evidence.every(e=>e.ok);
        const summary={...material,ok,cases:evidence};
        return {command:['dream-maker-controller-cli-oracle',input.specHash,approval.sha256],stdout:JSON.stringify(summary),stderr,exitCode:ok?0:1};
    }
}
