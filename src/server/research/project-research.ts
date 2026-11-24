import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Store } from '../store.js';
import { DomainError, id, now, hash, hasSecret, within } from '../security.js';
import { digest } from './common.mjs';
import { ResearchNetwork, PublicRepositoryClient, safeSearchKeywords } from './repository-clients.mjs';
import { RepositoryResearchService, verifySnapshot } from './reuse-policy.mjs';
import { createAnonymousResearchTransport, type ResearchTransport } from './transport.js';
import type { Project } from '../../shared/types.js';
import type { ResearchOperation, SourceSnapshot } from '../../shared/research.js';
import { canReviseAfterFlow } from '../flow/conclusion.js';

// Model selects generic public concepts from this controller-owned vocabulary.
// A project description, private codename or arbitrary URL cannot become a query.
export const PUBLIC_RESEARCH_TERMS = Object.freeze(['notes','markdown','offline','task management','kanban','calendar','todo','local first','desktop','web app','cli','python','javascript','typescript','sqlite','education','flashcards','chat','search','files','organizer','image editor','audio','video','game','puzzle','simulation','data visualization','dashboard','budget tracker','inventory','recipe','journal','drawing','backup','accessibility','translation','document','workflow','forms','timer','habit tracker']);
export function publicResearchKeywords(raw: unknown): string[] {
    const terms = safeSearchKeywords(raw).map(s=>s.trim().toLowerCase());
    if (new Set(terms).size !== terms.length || terms.some(term=>!PUBLIC_RESEARCH_TERMS.includes(term) || hasSecret(term)))
        throw new DomainError('SEARCH_TERM_NOT_APPROVED_GENERIC',403);
    return terms;
}
export function researchInputHash(p: Project): string {
    return hash({id:p.id,version:p.version,name:p.name,idea:p.idea,questions:p.questions,answers:p.answers,permission:p.publicResearch??null});
}
export class ProjectResearch {
    private jobs = new Map<string,{controller: AbortController;promise: Promise<void>}>();
    private archive: string;
    constructor(private store: Store,data: string,private transport: ResearchTransport = createAnonymousResearchTransport()) {
        this.archive=within(data,'controller/research');mkdirSync(this.archive,{recursive:true,mode:0o700});
    }
    history(pid: string): ResearchOperation[] {
        this.store.project(pid);
        const latest=new Map<string,ResearchOperation>();
        for(const row of this.store.records(pid,'ResearchOperation')) {const op=row.data as ResearchOperation;latest.set(op.id,op);}
        return [...latest.values()].map(op=>['RUNNING','CANCEL_REQUESTED'].includes(op.status)&&!this.jobs.has(op.id)?{...op,status:'RESULT_UNCERTAIN' as const}:op);
    }
    private save(op: ResearchOperation) { this.store.record('ResearchOperation',op.projectId,null,op); this.store.event(op.projectId,null,'research.status',{id:op.id,status:op.status,requestCount:op.requestCount,code:op.code??null}); }
    start(pid: string,raw: unknown,expectedVersion: number): ResearchOperation {
        const keywords=publicResearchKeywords(raw),p=this.store.project(pid);
        if(p.mode!=='live')throw new DomainError('RESEARCH_LIVE_PROJECT_REQUIRED',409);
        if(p.version!==expectedVersion)throw new DomainError('STALE_PROJECT_VERSION',409);
        if(p.publicResearch?.scope!=='PUBLIC_GENERIC_TERMS_ONLY')throw new DomainError('PUBLIC_RESEARCH_CONSENT_REQUIRED',403);
        const inputHash=researchInputHash(p),existing=this.history(pid);
        const same=existing.filter(op=>op.inputHash===inputHash&&digest(op.keywords)===digest(keywords));
        const done=same.find(op=>op.status==='COMPLETED');if(done)return done;
        if(existing.some(op=>['RUNNING','CANCEL_REQUESTED','RESULT_UNCERTAIN'].includes(op.status)))throw new DomainError('RESEARCH_RECONCILIATION_REQUIRED',409);
        if(same.length>=3)throw new DomainError('RESEARCH_RETRY_LIMIT',409);
        if(p.activeRunId && !canReviseAfterFlow(this.store,this.store.run(p.activeRunId)))throw new DomainError('RUN_MUST_STOP_BEFORE_EDIT',409);
        const op:ResearchOperation={id:id('research'),projectId:pid,projectVersion:p.version,inputHash,keywords,status:'RUNNING',requestCount:0,at:now()};
        this.store.tx(()=>{if(this.store.project(pid).version!==p.version)throw new DomainError('STALE_PROJECT_VERSION',409);this.save(op);});
        const controller=new AbortController();
        const deadline=setTimeout(()=>controller.abort(),60000);
        const promise=Promise.resolve().then(()=>this.run(op,controller.signal)).finally(()=>{clearTimeout(deadline);this.jobs.delete(op.id);});
        this.jobs.set(op.id,{controller,promise});return op;
    }
    private async run(op: ResearchOperation,signal: AbortSignal) {
        const network=new ResearchNetwork({transport:this.transport,maxRequests:40,timeoutMs:12000});
        const research=new RepositoryResearchService({clients:[new PublicRepositoryClient('github',network),new PublicRepositoryClient('gitlab',network)]});
        try {
            const result=await research.discover({keywords:op.keywords,intentHash:op.inputHash,disclosure:{kind:'PUBLIC_GENERIC_TERMS_ONLY',intentHash:op.inputHash,queryHash:digest(op.keywords)},maxCandidates:3,signal});
            if(signal.aborted)throw new DomainError('RESEARCH_CANCELLED',409);
            if(researchInputHash(this.store.project(op.projectId))!==op.inputHash)throw new DomainError('RESEARCH_INPUT_STALE',409);
            for(const raw of result.snapshots) {
                const snapshot=verifySnapshot(raw),serialized=JSON.stringify(snapshot);
                if(hasSecret(serialized))throw new DomainError('SOURCE_SENSITIVE_TEXT',409);
                const path=within(this.archive,snapshot.snapshotHash+'.json');
                if(existsSync(path)) {if(verifySnapshot(JSON.parse(readFileSync(path,'utf8'))).snapshotHash!==snapshot.snapshotHash)throw new DomainError('SOURCE_INTEGRITY_FAILED',409);}
                else writeFileSync(path,serialized,{flag:'wx',mode:0o600});
            }
            const receipt={...result,snapshots:result.snapshots.map(({files: _files,...metadata})=>metadata)};
            this.store.tx(()=>{
                if(researchInputHash(this.store.project(op.projectId))!==op.inputHash)throw new DomainError('RESEARCH_INPUT_STALE',409);
                this.save({...op,status:'COMPLETED',requestCount:network.usedRequests,result:receipt});
            });
        } catch (error) {
            const candidate=error as {code?:unknown};
            const code=typeof candidate.code==='string'&&/^[A-Z_]{1,100}$/.test(candidate.code)?candidate.code:'RESEARCH_FAILED';
            this.save({...op,status:signal.aborted?'CANCELLED':'FAILED',requestCount:network.usedRequests,code});
        }
    }
    source(pid: string,operationId: string,snapshotHash: string): SourceSnapshot {
        const op=this.history(pid).find(op=>op.id===operationId);
        if(!/^[a-f0-9]{64}$/.test(snapshotHash)||!op?.result?.snapshots.some(s=>s.snapshotHash===snapshotHash))throw new DomainError('SOURCE_NOT_FOUND',404);
        const source=verifySnapshot(JSON.parse(readFileSync(within(this.archive,snapshotHash+'.json'),'utf8')));
        if(source.snapshotHash!==snapshotHash)throw new DomainError('SOURCE_INTEGRITY_FAILED',409);
        return source;
    }
    async settled(operationId: string) {await this.jobs.get(operationId)?.promise;}
    async cancel(pid: string,operationId: string) {
        const op=this.history(pid).find(op=>op.id===operationId);if(!op)throw new DomainError('RESEARCH_NOT_FOUND',404);
        const job=this.jobs.get(op.id);
        if(job){this.save({...op,status:'CANCEL_REQUESTED'});job.controller.abort();await job.promise;}
        else if(op.status==='RESULT_UNCERTAIN')this.save({...op,status:'CANCELLED',code:'READ_ONLY_WORK_STOPPED_AFTER_RESTART'});
        return this.history(pid).find(op=>op.id===operationId)!;
    }
    async close(){for(const job of this.jobs.values())job.controller.abort();await Promise.allSettled([...this.jobs.values()].map(job=>job.promise));}
}
