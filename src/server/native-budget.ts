import {consumeCodexIncludedTurn,type CodexIncludedTurn} from './providers/codex.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname,isAbsolute,relative,resolve,sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError,hash,within } from './security.js';
import { captureDatabaseState } from './database-snapshot.js';
import { probeRoles,type ProbeProfile } from './flow/probe-profile.js';
import type {NativeRequestBinding} from '../shared/native-request.js';
import {nativeRequestBinding} from './native-request-binding.js';
import {isPreparedOfficialProbe} from './magpie-model-transport.js';
import {magpieRouteHash,type MagpieConcreteRoute} from './magpie-route.js';
import {magpieGrantIntent,magpieAcknowledgement,type MagpieGrantIntent,type MagpieGrantIntentInput} from './magpie-admission.js';
import {assertUserBudget,assertUserBudgetChange,configureUserBudget as saveUserBudget,userBudgetStatus as readUserBudget,userBudgetTablePresent,type UserBudgetLimits} from './user-budget-policy.js';
import {customRequestBudget,assertCustomRequestBudget,type CustomRequestBudget,type CustomBudgetResolver} from './flow/custom-budget.js';
import {customProbeBudgetContext,customProbeRequestBinding,customProbeRequestLimits,type CustomProbeBudgetContext} from './flow/custom-probe-budget.js';

type Role = 'planner1' | 'planner2' | 'executor' | 'reviewer';
export interface BudgetAuthority {
    scopeId: string; authorizationHash: string;
    totalMicros: number; probeMicros: number; warningMicros: number;
    maxInFlight: number; maxRepairs: number;
    /**
     * Spend policy for this scope. Absent or `CAPPED` keeps the original hard limits.
     *
     * `UNCAPPED` is an explicit owner authorization: the historical numbers above stay on the record
     * for display and anomaly detection, but they no longer *block* a necessary request. It exists so
     * the owner can approve real Live verification without deleting the ledger or writing Infinity —
     * every request is still attributed, reserved against official prices, and settled.
     */
    mode?: 'CAPPED' | 'UNCAPPED';
    /** Required when `mode` is `UNCAPPED`: who approved it, when, and the statement being relied on. */
    uncappedApproval?: {
        approvedAt: string;
        approvedBy: 'USER';
        statement: string;
        evidenceRef: string;
        /** What this approval supersedes, recorded so the history stays readable. */
        supersedes: string[];
    };
}
export interface NativePrice {
    // The currency of the OFFICIAL price artifact for this provider. DeepSeek bills in CNY and OpenAI
    // bills in USD, so this is a property of the price, not a project-wide constant.
    provider: string; model: string; currency: 'CNY' | 'USD'; source: string; expiresAt: string;
    maxInputTokens: number; inputMissMicrosPerMillion: number;
    inputHitMicrosPerMillion: number; outputMicrosPerMillion: number;
}
type IncludedCharge = Pick<NativePrice,'provider'|'model'|'currency'|'source'|'maxInputTokens'|'expiresAt'> & {
    billing:'CHATGPT_INCLUDED';threadHash:string;accountFingerprint:string
};
export interface NativePriceRoute { provider: string; model: string; currency: 'CNY' | 'USD' }
export interface NativePriceRef { path: string; sha256: string }
/** The operator and audit must agree on which exact, product-local quote references are valid. */
export function assertCustomModelPrices(raw: unknown, root: string): asserts raw is Record<string, NativePriceRef> | undefined {
    const invalid = () => new DomainError('NATIVE_CUSTOM_MODEL_PRICES_INVALID', 409);
    if (raw === undefined) return;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
    const entries = Object.entries(raw);
    if (entries.length > 256) throw invalid();
    for (const [key, ref] of entries) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,127}$/.test(key) ||
            !ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).length !== 2 ||
            typeof ref.path !== 'string' || !isAbsolute(ref.path) ||
            typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw invalid();
        try { within(root, relative(root, ref.path).split(sep).join('/')); }
        catch { throw invalid(); }
    }
}
export interface NativeUsage { inputTokens: number; outputTokens: number; cacheHitTokens: number }
export interface ProbeReceipt { evidenceId: string; model: string; source: 'REAL_MODEL_RESPONSE' }
/** A controller-owned capability check, never a user project or role-qualification receipt. */
export interface EngineeringBudgetContext {
    schema:'dream-maker.dsh-engineering-budget.v1';acceptanceId:string;contractHash:string;
    configurationHash:string;dispatchId:string;generation:string;
}
declare const engineeringPermitBrand:unique symbol;
export type EngineeringBudgetPermit={readonly [engineeringPermitBrand]:true};
declare const customProbePermitBrand:unique symbol;
export type CustomProbeBudgetPermit={readonly [customProbePermitBrand]:true};
export type RequestRecord = {
    id: string; role: Role; price: NativePrice|IncludedCharge; maxOutputTokens: number;
    reservedMicros: number; chargedMicros: number | null;
    usageStatus: 'PENDING' | 'KNOWN' | 'UNKNOWN'; outcome: string | null;
    usage: NativeUsage | null; createdAt: string;
    limitExceeded?: boolean;
    /** Present only for new scoped inner requests; historical JSON rows are not backfilled. */
    binding?:NativeRequestBinding;
    /** New Custom holds only; original frozen Flow/role limits, never backfilled into old rows. */
    customBudget?:CustomRequestBudget;
    /** One explicitly scoped Custom qualification attempt, never backfilled. */
    customProbe?:CustomProbeBudgetContext;
    engineeringAcceptance?:EngineeringBudgetContext&{bodyHash:string};
    /** Controller-pipe delivery only. An acknowledgement is not a model/tool result. */
    routerAdmission?:MagpieGrantIntent;
};
const roles: Role[] = ['planner1', 'planner2', 'executor', 'reviewer'];
declare const permitBrand:unique symbol;
export type ProbeBudgetPermit={readonly [permitBrand]:true};
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const fail = (code: string): never => { throw new DomainError(code, 409); };
export function assertNativePriceForRoute(price: NativePrice, route: NativePriceRoute, now = Date.now()): void {
    if (!price || price.provider !== route.provider || price.model !== route.model || price.currency !== route.currency)
        fail('NATIVE_PRICE_ROUTE_MISMATCH');
    if (!Number.isFinite(Date.parse(price.expiresAt)) || Date.parse(price.expiresAt) <= now)
        fail('NATIVE_PRICE_EXPIRED');
    if (!integer(price.maxInputTokens) || price.maxInputTokens < 1048576 ||
        !integer(price.inputMissMicrosPerMillion) || price.inputMissMicrosPerMillion <= 0 ||
        !integer(price.inputHitMicrosPerMillion) || price.inputHitMicrosPerMillion > price.inputMissMicrosPerMillion ||
        !integer(price.outputMicrosPerMillion) || price.outputMicrosPerMillion <= 0)
        fail('NATIVE_CONSERVATIVE_PRICE_REQUIRED');
}
function cost(input: number, hit: number, output: number, price: NativePrice): number {
    const numerator = BigInt(input - hit) * BigInt(price.inputMissMicrosPerMillion)
        + BigInt(hit) * BigInt(price.inputHitMicrosPerMillion)
        + BigInt(output) * BigInt(price.outputMicrosPerMillion);
    const result = Number((numerator + 999999n) / 1000000n);
    if (!integer(result)) fail('NATIVE_COST_OVERFLOW');
    return result;
}

// Owned by a single trusted controller. Each inner HTTP request must reserve here,
// not merely each outer agent turn. This is accounting, not provider isolation.
export class NativeBudget {
    private db: DatabaseSync;
    private repairPermits=new WeakMap<ProbeBudgetPermit,Role>();
    private engineeringPermits=new Map<EngineeringBudgetPermit,{context:EngineeringBudgetContext;expiresAt:number}>();
    private customProbePermits=new Map<CustomProbeBudgetPermit,{context:CustomProbeBudgetContext;expiresAt:number}>();
    private customProbeClock=()=>performance.now();
    private closed = false;
    private ownerToken = randomUUID();
    constructor(private path: string, private authority: BudgetAuthority,
        private verifyReceipt: (role: Role, receipt: ProbeReceipt) => boolean = () => false,
        private onReserved?:(summary:ReturnType<NativeBudget['summary']>)=>void,private profile:ProbeProfile='FULL_DM',private customBudgetResolver?:CustomBudgetResolver,
        private verifyCustomQualification?:(binding:NativeRequestBinding)=>void,
        private verifyCustomSupplement?:(binding:NativeRequestBinding,limits:CustomRequestBudget,rows:RequestRecord[])=>void) {
        probeRoles(profile);
        const uncapped = authority.mode === 'UNCAPPED';
        if (!authority.scopeId || !authority.authorizationHash ||
            ![authority.totalMicros, authority.probeMicros, authority.warningMicros, authority.maxInFlight, authority.maxRepairs].every(integer) ||
            // Serial dispatch and the repair ceiling are safety properties, not money limits: they hold
            // in both modes. Only the CNY ceilings are what an UNCAPPED approval lifts.
            authority.maxInFlight !== 1 || authority.maxRepairs > 2) fail('BUDGET_AUTHORITY_EXCEEDED');
        if (!uncapped) {
            if (authority.totalMicros > 50000000 || authority.totalMicros < 1 ||
                authority.probeMicros > 5000000 || authority.probeMicros > authority.totalMicros ||
                authority.warningMicros > 40000000 || authority.warningMicros > authority.totalMicros) fail('BUDGET_AUTHORITY_EXCEEDED');
        }
        else {
            // An uncapped scope must carry a real, dated owner statement — a bare boolean is not
            // authorization. Without it the caps stay in force.
            const approval = authority.uncappedApproval;
            if (!approval || approval.approvedBy !== 'USER' || !Number.isFinite(Date.parse(approval.approvedAt))
                || typeof approval.statement !== 'string' || approval.statement.trim().length === 0
                || typeof approval.evidenceRef !== 'string' || approval.evidenceRef.trim().length === 0
                || !Array.isArray(approval.supersedes))
                fail('BUDGET_UNCAPPED_REQUIRES_OWNER_APPROVAL');
        }
        this.authority = Object.freeze(structuredClone(authority));
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path);
        try {
            this.db.exec('CREATE TABLE IF NOT EXISTS scope(id INTEGER PRIMARY KEY CHECK(id=1), authority TEXT NOT NULL, phase TEXT NOT NULL, repairs INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS controller(id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL); CREATE TABLE IF NOT EXISTS probe_proofs(role TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS authority_history(at TEXT NOT NULL, fromMode TEXT NOT NULL, toMode TEXT NOT NULL, previous TEXT NOT NULL, next TEXT NOT NULL, approval TEXT NOT NULL);');
            this.tx(() => {
                const existing = this.db.prepare('SELECT authority FROM scope WHERE id=1').get();
                if (existing && existing.authority !== JSON.stringify(authority)) {
                    // The ONLY sanctioned change is a one-way spend-policy migration for the SAME scope:
                    // identical scopeId and authorizationHash, capped -> uncapped, with the owner's dated
                    // statement attached. Spend rows are untouched; the transition is appended to history.
                    const before = (() => { try { return JSON.parse(String(existing.authority)) as BudgetAuthority; } catch { return null; } })();
                    const sameScopeId = before !== null && before.scopeId === authority.scopeId;
                    const sameScope = sameScopeId && before!.authorizationHash === authority.authorizationHash;
                    const cappedToUncapped = sameScope && before!.mode !== 'UNCAPPED' && authority.mode === 'UNCAPPED' && authority.uncappedApproval !== undefined;
                    // A scope that has spent nothing and carries no proof or earlier transition may be
                    // RE-AUTHORIZED with a corrected authorization document for the same scope. Once any
                    // request, probe proof or transition exists the identity is frozen: re-basing it would
                    // rewrite what that spend was authorized by, so it stays a refusal.
                    const untouched = (this.db.prepare('SELECT (SELECT count(*) FROM requests)+(SELECT count(*) FROM probe_proofs)+(SELECT count(*) FROM authority_history) AS n').get() as { n: number }).n === 0;
                    const reauthorized = sameScopeId && !cappedToUncapped && untouched;
                    if (!cappedToUncapped && !reauthorized) fail('BUDGET_AUTHORITY_EXCEEDED');
                    this.db.prepare('INSERT INTO authority_history VALUES(?,?,?,?,?,?)').run(
                        new Date().toISOString(), String(before!.mode ?? 'CAPPED'), String(authority.mode ?? 'CAPPED'),
                        String(existing.authority), JSON.stringify(authority),
                        JSON.stringify(authority.uncappedApproval ?? before!.uncappedApproval ?? null));
                    this.db.prepare('UPDATE scope SET authority=? WHERE id=1').run(JSON.stringify(authority));
                }
                if (!existing) this.db.prepare('INSERT INTO scope VALUES(1,?,\'PROBE\',0)').run(JSON.stringify(authority));
                const owner = this.db.prepare('SELECT pid FROM controller WHERE id=1').get();
                if (owner) {
                    let dead = false;
                    try { process.kill(Number(owner.pid), 0); }
                    catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
                    // PID reuse or access denial refuses recovery, rather than freeing a live lease.
                    if (!dead) fail('BUDGET_CONTROLLER_ACTIVE');
                }
                this.db.prepare('INSERT INTO controller VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,token=excluded.token').run(process.pid, this.ownerToken);
                for (const r of this.requests()) {
                    let changed=false;
                    if(r.usageStatus==='PENDING'){
                        r.usageStatus = 'UNKNOWN'; r.outcome = 'RESTART_UNKNOWN'; r.chargedMicros = r.reservedMicros;changed=true;
                    }
                    // Owner shutdown may already have settled unknown usage before its pipe died.
                    // Delivery recovery is independent of usage settlement and never changes its cost.
                    if(r.routerAdmission?.status==='INTENT'){
                        r.routerAdmission={...r.routerAdmission,status:'UNKNOWN',decidedAt:new Date().toISOString()};changed=true;
                    }
                    if(changed)this.save(r);
                }
            });
            try { chmodSync(path, 0o600); } catch { /* Windows ACLs are audited separately. */ }
        } catch (e) { this.db.close(); throw e; }
    }
    private tx<T>(fn: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try { const r = fn(); this.db.exec('COMMIT'); return r; }
        catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    private save(r: RequestRecord) { this.db.prepare('INSERT INTO requests VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(r.id, JSON.stringify(r)); }
    requests(): RequestRecord[] { return this.db.prepare('SELECT data FROM requests ORDER BY rowid').all().map(r => JSON.parse(r.data as string)); }
    private assertUsageBounds(): void {
        if (this.requests().some(r => r.limitExceeded)) fail('NATIVE_USAGE_BOUND_EXCEEDED');
    }
    userBudgetStatus(){return readUserBudget(this.db,this.requests(),this.authority.scopeId);}
    /** Trusted controller-only snapshot. Never opens a new authority or resets/settles a request. */
    captureState(path:string){
        if(this.closed)fail('NATIVE_OWNER_CLOSED');
        if(this.summary().inFlight)fail('MAINTENANCE_BUDGET_IN_FLIGHT');
        this.userBudgetStatus();
        captureDatabaseState(this.db,path);
    }
    configureUserBudget(limits:UserBudgetLimits,expectedRevision:number,actor:string,operation:string){
        const validate=()=>{
            const requests=this.requests();assertUserBudgetChange(this.db,requests,this.authority.scopeId,limits,expectedRevision,actor,operation);
            if(this.authority.mode!=='UNCAPPED'){
                if(limits.USD===null||limits.USD>0)fail('NATIVE_PRICE_CURRENCY_NOT_AUTHORIZED');
                const status=this.userBudgetStatus(),count=status.configured?status.baselineRequests:requests.length;
                const before=requests.slice(0,count).filter(r=>r.price.currency==='CNY').reduce((n,r)=>n+(r.chargedMicros??r.reservedMicros),0);
                if(limits.CNY===null||limits.CNY>Math.max(0,this.authority.totalMicros-before))fail('USER_BUDGET_ABOVE_AUTHORITY');
            }
        };
        validate();
        // A real ledger backup precedes the first additive policy schema; reads never create it.
        if(!userBudgetTablePresent(this.db)&&this.path!==':memory:'){
            const dir=resolve(dirname(this.path),'migration-backups');mkdirSync(dir,{recursive:true,mode:0o700});
            const backup=resolve(dir,'before-user-budget-'+randomUUID()+'.sqlite');this.db.prepare('VACUUM INTO ?').run(backup);try{chmodSync(backup,0o600);}catch{}
        }
        return this.tx(()=>{validate();return saveUserBudget(this.db,this.requests(),this.authority.scopeId,limits,expectedRevision,actor,operation);});
    }
    summary() {
        const requests = this.requests();
        // Two providers now bill in two currencies, and adding them would produce a number that means
        // nothing. The top-level totals stay the CNY figures they have always been (so every existing
        // ceiling, warning and delivery fact keeps its meaning), and each currency is reported apart.
        const totals = (list: RequestRecord[]) => ({
            committedMicros: list.reduce((n, r) => n + (r.chargedMicros ?? 0), 0),
            reservedMicros: list.filter(r => r.usageStatus === 'PENDING').reduce((n, r) => n + r.reservedMicros, 0),
            inFlight: list.filter(r => r.usageStatus === 'PENDING').length,
        });
        const all = totals(requests), cny = totals(requests.filter(r => r.price.currency === 'CNY'));
        const currencies: string[] = [...new Set(requests.map(r => String(r.price.currency)))];
        const byCurrency = Object.fromEntries(currencies.map(currency => [currency, totals(requests.filter(r => String(r.price.currency) === currency))]));
        const committedMicros = cny.committedMicros, reservedMicros = cny.reservedMicros;
        return { phase: this.db.prepare('SELECT phase FROM scope WHERE id=1').get()!.phase as string,
            inFlight: all.inFlight, committedMicros, reservedMicros, byCurrency,
            // Advisory in uncapped mode: it reports, it does not refuse.
            warning: committedMicros + reservedMicros >= this.authority.warningMicros,
            mode: (this.authority.mode ?? 'CAPPED') as 'CAPPED' | 'UNCAPPED' };
    }
    preflight(price:NativePrice,maxOutputTokens:number,permit?:ProbeBudgetPermit):number {
        const evidenceRepair=this.repairAllowed(permit);
        return this.preflightFor(price,maxOutputTokens,evidenceRepair,false);
    }
    estimateCustomSelection(price:NativePrice,maxOutputTokens:number):number {
        return this.preflightFor(price,maxOutputTokens,false,false,true);
    }
    private preflightFor(price:NativePrice,maxOutputTokens:number,evidenceRepair:boolean,engineering:boolean,customProduct=false):number {
        this.assertUsageBounds();
        if (!price || !['CNY', 'USD'].includes(price.currency) || !price.provider || !price.model || !price.source ||
            ![price.maxInputTokens, price.inputMissMicrosPerMillion, price.inputHitMicrosPerMillion, price.outputMicrosPerMillion, maxOutputTokens].every(integer) ||
            price.maxInputTokens < 1 || maxOutputTokens < 1 || price.inputHitMicrosPerMillion > price.inputMissMicrosPerMillion) fail('NATIVE_PRICE_UNKNOWN');
        if (!Number.isFinite(Date.parse(price.expiresAt)) || Date.parse(price.expiresAt) <= Date.now()) fail('NATIVE_PRICE_EXPIRED');
        const reservedMicros = cost(price.maxInputTokens, 0, maxOutputTokens, price);
        return this.checkReservationLimits(price,reservedMicros,evidenceRepair,engineering,customProduct);
    }
    private checkReservationLimits(price:Pick<NativePrice,'currency'>,reservedMicros:number,evidenceRepair:boolean,engineering:boolean,customProduct:boolean):number {
        const s = this.summary(), projected = s.committedMicros + s.reservedMicros + reservedMicros;
        // A live run must never dispatch on unverified probe evidence. The ONE exception is repairing that
        // evidence itself: a minimum probe has to be able to reserve against the provider in order to
        // produce a fresh receipt. The window is opened explicitly by the owner path for the duration of a
        // probe, is an opaque role-bound capability, and is never persisted. A concurrent run cannot borrow it.
        if(s.phase==='REPRESENTATIVE'&&!evidenceRepair&&!engineering&&!customProduct){
            const refs=this.db.prepare('SELECT role,data FROM probe_proofs').all();
            if(probeRoles(this.profile).some(role=>{const ref=refs.find(r=>r.role===role);return !ref||!this.verifyReceipt(role,JSON.parse(ref.data as string));}))fail('PROBE_EVIDENCE_UNVERIFIED');
        }
        if (s.inFlight >= this.authority.maxInFlight) fail('NATIVE_REQUEST_ALREADY_IN_FLIGHT');
        // An uncapped scope keeps reserving and settling against official prices, but a historical CNY
        // ceiling no longer refuses the request. Serial dispatch, price validity, usage bounds and the
        // repair ceiling above are unchanged.
        if (this.authority.mode !== 'UNCAPPED') {
            if(price.currency!=='CNY')fail('NATIVE_PRICE_CURRENCY_NOT_AUTHORIZED');
            if (projected > this.authority.totalMicros) fail('TOTAL_MODEL_BUDGET_EXCEEDED');
            if (s.phase === 'PROBE' && !engineering && !customProduct && projected > this.authority.probeMicros) fail('PROBE_BUDGET_EXCEEDED');
        }
        assertUserBudget(this.db,this.requests(),this.authority.scopeId,price,reservedMicros);
        return reservedMicros;
    }
    /** One physical Custom qualification request. This capability is never serialized
     * or accepted as a Classic evidence-repair/engineering/product-run permit. */
    beginCustomProbe(raw:CustomProbeBudgetContext):CustomProbeBudgetPermit {
        if(this.closed)fail('NATIVE_OWNER_CLOSED');
        const context=customProbeBudgetContext(raw),rows=this.requests();
        if(rows.some(r=>r.customProbe?.probeId===context.probeId)||[...this.customProbePermits.values()].some(s=>s.context.probeId===context.probeId))fail('CUSTOM_PROBE_ID_REUSED');
        if(new Set(rows.filter(r=>r.customProbe?.bindingHash===context.bindingHash&&r.customProbe.roleId===context.roleId).map(r=>r.customProbe?.probeId)).size>=3)fail('CUSTOM_PROBE_ATTEMPT_LIMIT');
        if(this.customProbePermits.size>=32)fail('CUSTOM_PROBE_PERMIT_LIMIT');
        Object.freeze(context.flowBudget);Object.freeze(context.roleBudget);Object.freeze(context);
        const permit=Object.freeze({}) as CustomProbeBudgetPermit;this.customProbePermits.set(permit,{context,expiresAt:this.customProbeClock()+120000});return permit;
    }
    endCustomProbe(permit:CustomProbeBudgetPermit):void {this.customProbePermits.delete(permit);}
    private customProbeScope(permit:CustomProbeBudgetPermit){
        const scope=this.customProbePermits.get(permit);if(this.closed||!scope)fail('CUSTOM_PROBE_PERMIT_INVALID');
        if(scope!.expiresAt<=this.customProbeClock())fail('CUSTOM_PROBE_PERMIT_EXPIRED');return scope!;
    }
    private checkProbeHistory(context:CustomProbeBudgetContext,rows:RequestRecord[]):void {
        const innerRows=rows.filter(r=>r.customProbe?.probeId===context.probeId);
        if(innerRows.some(r=>r.usageStatus==='PENDING'||r.outcome!=='COMPLETE'))fail('CUSTOM_PROBE_ID_REUSED');
        if(innerRows.length>=4)fail('NATIVE_INNER_REQUEST_LIMIT');
        if(new Set(rows.filter(r=>r.customProbe?.probeId!==context.probeId&&r.customProbe?.bindingHash===context.bindingHash&&r.customProbe.roleId===context.roleId).map(r=>r.customProbe?.probeId)).size>=3)fail('CUSTOM_PROBE_ATTEMPT_LIMIT');
    }
    customProbePreflight(permit:CustomProbeBudgetPermit,price:NativePrice,maxOutputTokens:number,raw:NativeRequestBinding,expectedModel:string='deepseek-flash',route?:MagpieConcreteRoute):number {
        const {context}=this.customProbeScope(permit),binding=customProbeRequestBinding(context,raw),rows=this.requests();
        // Each Custom role may pin its own approved model; the caller passes the
        // exact model this probe bills. The legacy executor model stays the
        // default only so historical callers keep their original fail-closed
        // behaviour instead of silently accepting an arbitrary price.
        if(route&&(magpieRouteHash(route)!==context.routeHash||route.model!==expectedModel))fail('CUSTOM_PROBE_PRICE_ROUTE_INVALID');
        const provider=route?.provider??'deepseek-official';
        const official=route?.runtime==='claude'&&route.protocol!=='anthropic-messages'||route?.protocol==='openai-responses'&&(route.runtime==='opencode'||route.runtime==='cline')||route?.runtime==='pi'&&route.protocol!=='chat-completions';
        if(official){
            if(!isPreparedOfficialProbe(raw,this,context.routeHash,maxOutputTokens))fail('CUSTOM_PROBE_PRICE_ROUTE_INVALID');
            if(rows.some(row=>row.customProbe?.probeId===context.probeId))fail('NATIVE_INNER_REQUEST_LIMIT');
        }
        if(!official&&provider!=='deepseek-official'&&!(provider==='string'&&context.role==='reviewer'&&route?.runtime==='claude'&&route.protocol==='anthropic-messages'&&route.authentication==='api_key'&&expectedModel==='claude-sonnet-5'))fail('CUSTOM_PROBE_PRICE_ROUTE_INVALID');
        if(typeof expectedModel!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(expectedModel)||
            price?.provider!==provider||price.model!==expectedModel||!official&&price.currency!=='CNY'||context.flowBudget.currency!==price.currency)fail('CUSTOM_PROBE_PRICE_ROUTE_INVALID');
        this.checkProbeHistory(context,rows);
        // Only this opaque qualification capability skips Classic proof lookup.
        // All prices, usage, in-flight and scope/user ceilings still run unchanged.
        const reserved=this.preflightFor(price,maxOutputTokens,true,false);
        const limits=customProbeRequestLimits(context);this.checkCustomSupplement(binding,limits,rows);
        assertCustomRequestBudget(rows,binding,limits,reserved);return reserved;
    }
    reserveCustomProbe(permit:CustomProbeBudgetPermit,price:NativePrice,maxOutputTokens:number,raw:NativeRequestBinding,expectedModel:string='deepseek-flash',route?:MagpieConcreteRoute):RequestRecord {
        const reservation=this.tx(()=>{
            const reservedMicros=this.customProbePreflight(permit,price,maxOutputTokens,raw,expectedModel,route),{context}=this.customProbeScope(permit),binding=customProbeRequestBinding(context,raw);
            const row:RequestRecord={id:randomUUID(),role:context.role,price:structuredClone(price),maxOutputTokens,reservedMicros,chargedMicros:null,usageStatus:'PENDING',outcome:null,usage:null,createdAt:new Date().toISOString(),binding,customBudget:customProbeRequestLimits(context),customProbe:structuredClone(context)};
            this.save(row);return row;
        });
        try{this.onReserved?.(this.summary());}catch{this.settle(reservation.id,null,'RESERVATION_OBSERVER_FAILED');fail('NATIVE_RESERVATION_OBSERVER_FAILED');}return reservation;
    }
    /** Separate from minimum probes: fixed executor-only ceiling, no promotion of role proofs. */
    beginEngineeringAcceptance(raw:EngineeringBudgetContext):EngineeringBudgetPermit {
        const keys=['schema','acceptanceId','contractHash','configurationHash','dispatchId','generation'];
        if(!raw||typeof raw!=='object')fail('ENGINEERING_BUDGET_SCOPE_INVALID');
        const descriptors=Object.getOwnPropertyDescriptors(raw);
        if(Reflect.ownKeys(raw).length!==keys.length||keys.some(k=>!descriptors[k]||!descriptors[k].enumerable||!Object.hasOwn(descriptors[k],'value')))fail('ENGINEERING_BUDGET_SCOPE_INVALID');
        const value=Object.fromEntries(keys.map(k=>[k,descriptors[k].value])) as unknown as EngineeringBudgetContext;
        if(value.schema!=='dream-maker.dsh-engineering-budget.v1'||typeof value.acceptanceId!=='string'||!/^dsh_acceptance_[a-zA-Z0-9_-]{1,100}$/.test(value.acceptanceId)||
            !['contractHash','configurationHash'].every(k=>typeof value[k as keyof EngineeringBudgetContext]==='string'&&/^[a-f0-9]{64}$/.test(value[k as keyof EngineeringBudgetContext]))||
            !['dispatchId','generation'].every(k=>typeof value[k as keyof EngineeringBudgetContext]==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(value[k as keyof EngineeringBudgetContext])))fail('ENGINEERING_BUDGET_SCOPE_INVALID');
        if(this.requests().some(r=>r.engineeringAcceptance?.acceptanceId===value.acceptanceId)||[...this.engineeringPermits.values()].some(p=>p.context.acceptanceId===value.acceptanceId))fail('ENGINEERING_BUDGET_ID_REUSED');
        const permit=Object.freeze({}) as EngineeringBudgetPermit;
        this.engineeringPermits.set(permit,{context:Object.freeze(value),expiresAt:Date.now()+900000});return permit;
    }
    endEngineeringAcceptance(permit:EngineeringBudgetPermit):void {this.engineeringPermits.delete(permit);}
    engineeringPreflight(permit:EngineeringBudgetPermit,price:NativePrice,maxOutputTokens:number):number {
        const scope=this.engineeringPermits.get(permit);if(!scope)fail('ENGINEERING_BUDGET_PERMIT_INVALID');
        if(scope!.expiresAt<=Date.now())fail('ENGINEERING_BUDGET_PERMIT_EXPIRED');
        if(price?.provider!=='deepseek-official'||price.model!=='deepseek-flash'||price.currency!=='CNY')fail('ENGINEERING_BUDGET_ROUTE_INVALID');
        const rows=this.requests().filter(r=>r.engineeringAcceptance?.acceptanceId===scope!.context.acceptanceId);
        if(rows.length>=8)fail('ENGINEERING_BUDGET_REQUEST_LIMIT');
        const reserved=this.preflightFor(price,maxOutputTokens,false,true);
        if(rows.reduce((sum,r)=>sum+Math.max(r.reservedMicros,r.chargedMicros??0),0)+reserved>20000000)fail('ENGINEERING_BUDGET_COST_LIMIT');
        return reserved;
    }
    reserveEngineering(permit:EngineeringBudgetPermit,price:NativePrice,maxOutputTokens:number,bodyHash:string):RequestRecord {
        if(typeof bodyHash!=='string'||!/^[a-f0-9]{64}$/.test(bodyHash))fail('ENGINEERING_BUDGET_SCOPE_INVALID');
        const reservation=this.tx(()=>{
            const reservedMicros=this.engineeringPreflight(permit,price,maxOutputTokens),scope=this.engineeringPermits.get(permit)!;
            const r:RequestRecord={id:randomUUID(),role:'executor',price:structuredClone(price),maxOutputTokens,reservedMicros,chargedMicros:null,
                usageStatus:'PENDING',outcome:null,usage:null,createdAt:new Date().toISOString(),engineeringAcceptance:{...scope.context,bodyHash}};
            this.save(r);return r;
        });
        try{this.onReserved?.(this.summary());}catch{this.settle(reservation.id,null,'RESERVATION_OBSERVER_FAILED');fail('NATIVE_RESERVATION_OBSERVER_FAILED');}
        return reservation;
    }
    private includedHolds=new Map<string,{turn:CodexIncludedTurn;check:()=>void}>();
    reserveIncludedPlanner(turn:CodexIncludedTurn,raw:NativeRequestBinding,route:MagpieConcreteRoute,maxOutputTokens:number,permit?:CustomProbeBudgetPermit):RequestRecord {
        const binding=nativeRequestBinding(raw,'planner2');
        if(binding.engineeringMode!=='custom'||binding.roleId!=='planner2'||route.runtime!=='codex'||route.provider!=='openai'||route.model!=='gpt-6-luna'||route.protocol!=='openai-responses'||route.authentication!=='oauth'||
            route.upstreamAccountRef!=='openai/'+turn.accountFingerprint||magpieRouteHash(route)!==binding.routeHash||
            !integer(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>16000||!probeRoles(this.profile).includes('planner2'))fail('CODEX_INCLUDED_ROUTE_INVALID');
        const check=consumeCodexIncludedTurn(turn,{runId:binding.runId,specHash:binding.specHash,model:route.model,accountFingerprint:turn.accountFingerprint});
        const row=this.tx(()=>{
            this.assertUsageBounds();
            let limits:CustomRequestBudget,context:CustomProbeBudgetContext|undefined;
            const rows=this.requests();
            if(permit){
                context=this.customProbeScope(permit).context;
                customProbeRequestBinding(context,binding);
                this.checkProbeHistory(context,rows);
                limits=customProbeRequestLimits(context);
            }else{
                if(binding.work.kind==='QUALIFICATION')fail('CUSTOM_PROBE_PERMIT_REQUIRED');
                this.assertCustomQualified(binding);
                limits=this.customLimits(binding);
            }
            this.checkCustomSupplement(binding,limits,rows);
            assertCustomRequestBudget(rows,binding,limits,0);
            const price:IncludedCharge={billing:'CHATGPT_INCLUDED',source:'CODEX_INCLUDED_QUOTA',provider:route.provider,model:route.model,currency:limits.flow.currency,
                maxInputTokens:1048576,expiresAt:new Date(Date.now()+120000).toISOString(),threadHash:hash(turn.threadId),accountFingerprint:turn.accountFingerprint};
            this.checkReservationLimits(price,0,!!permit,false,!permit);
            const record:RequestRecord={id:randomUUID(),role:'planner2',price,binding,customBudget:limits,...(context?{customProbe:structuredClone(context)}:{}),
                maxOutputTokens,reservedMicros:0,chargedMicros:null,usageStatus:'PENDING',outcome:null,usage:null,createdAt:new Date().toISOString()};
            check();
            this.save(record);
            return record;
        });
        this.includedHolds.set(row.id,{turn,check});
        try{this.onReserved?.(this.summary());}catch{this.settle(row.id,null,'RESERVATION_OBSERVER_FAILED');fail('NATIVE_RESERVATION_OBSERVER_FAILED');}
        return row;
    }
    includedPlannerCheck(id:string,turn:CodexIncludedTurn):()=>void {
        const validate=()=>{
            const hold=this.includedHolds.get(id);
            if(!hold||hold.turn!==turn)throw new DomainError('CODEX_INCLUDED_TURN_INVALID',409);
            hold.check();
        };
        validate();return validate;
    }
    reserve(role: Role, price: NativePrice, maxOutputTokens: number,permit?:ProbeBudgetPermit,binding?:NativeRequestBinding): RequestRecord {
        this.repairAllowed(permit,role);
        if(!probeRoles(this.profile).includes(role))fail('NATIVE_ROLE_NOT_IN_PRODUCT');
        if (!roles.includes(role)) fail('NATIVE_ROLE_INVALID');
        const reservation=this.tx(() => {
            const scoped=binding===undefined?undefined:nativeRequestBinding(binding,role);
            if(scoped?.work.kind==='QUALIFICATION')fail('CUSTOM_PROBE_PERMIT_REQUIRED');
            if(scoped?.work.kind==='REPAIR'&&this.repairRevision(scoped.runId)!==scoped.work.round)fail('NATIVE_REPAIR_BINDING_MISMATCH');
            let customBudget:CustomRequestBudget|undefined;
            if(scoped?.engineeringMode==='custom'){
                if(permit!==undefined)fail('CUSTOM_QUALIFICATION_SCOPE_INVALID');
                customBudget=this.customLimits(scoped);
                if(price?.currency!==customBudget.flow.currency)fail('CUSTOM_BUDGET_CURRENCY_MISMATCH');
                this.assertCustomQualified(scoped);
            }
            // A Custom product has its own real role qualification. It neither borrows
            // Classic proofs/probe allowance nor rewrites the common historical phase.
            const reservedMicros=customBudget?this.preflightFor(price,maxOutputTokens,false,false,true):this.preflight(price,maxOutputTokens,permit);
            if(customBudget){const rows=this.requests();this.checkCustomSupplement(scoped!,customBudget,rows);assertCustomRequestBudget(rows,scoped!,customBudget,reservedMicros);}
            const r: RequestRecord = { id: randomUUID(), role, price: structuredClone(price), maxOutputTokens,
                reservedMicros, chargedMicros: null, usageStatus: 'PENDING', outcome: null, usage: null, createdAt: new Date().toISOString(),...(scoped?{binding:scoped}:{}),...(customBudget?{customBudget}:{}) };
            this.save(r); return r;
        });
        try{this.onReserved?.(this.summary());}
        catch{this.settle(reservation.id,null,'RESERVATION_OBSERVER_FAILED');fail('NATIVE_RESERVATION_OBSERVER_FAILED');}
        return reservation;
    }
    private customLimits(binding:NativeRequestBinding):CustomRequestBudget {
        if(!this.customBudgetResolver)fail('CUSTOM_BUDGET_CONTEXT_REQUIRED');
        return customRequestBudget(this.customBudgetResolver!(structuredClone(binding)),binding);
    }
    private checkCustomSupplement(binding:NativeRequestBinding,limits:CustomRequestBudget,rows:RequestRecord[]):void{
        if(!this.verifyCustomSupplement){
            if(limits.supplement||rows.some(r=>r.binding?.runId===binding.runId&&r.customBudget?.supplement))fail('CUSTOM_BUDGET_SUPPLEMENT_AUTHORITY_REQUIRED');return;
        }
        const relevant=rows.filter(r=>r.binding?.runId===binding.runId);
        const result:unknown=this.verifyCustomSupplement(structuredClone(binding),structuredClone(limits),structuredClone(relevant));
        if(result!==undefined){if(result instanceof Promise)void result.catch(()=>{});fail('CUSTOM_BUDGET_SUPPLEMENT_AUTHORITY_INVALID');}
    }
    /** Original ledger hold, checked before handing a request to a model router. No new authority. */
    pendingBoundRequest(id:string,binding:NativeRequestBinding):RequestRecord {
        const expected=nativeRequestBinding(binding,binding?.role),row=this.db.prepare('SELECT data FROM requests WHERE id=?').get(id);
        if(!row)fail('NATIVE_REQUEST_NOT_FOUND');const value=JSON.parse(String(row!.data)) as RequestRecord;
        if(value.usageStatus!=='PENDING')fail('NATIVE_REQUEST_NOT_PENDING');
        this.assertUsageBounds();
        if(!Number.isFinite(Date.parse(value.price.expiresAt))||Date.parse(value.price.expiresAt)<=Date.now())fail('NATIVE_PRICE_EXPIRED');
        if(!value.binding||value.role!==expected.role||hash(nativeRequestBinding(value.binding,value.role))!==hash(expected))fail('NATIVE_REQUEST_BINDING_MISMATCH');
        if(expected.work.kind==='REPAIR'&&this.repairRevision(expected.runId)!==expected.work.round)fail('NATIVE_REPAIR_BINDING_MISMATCH');
        if(expected.work.kind==='QUALIFICATION'){
            const work=expected.work,scope=[...this.customProbePermits.values()].find(s=>s.context.probeId===work.probeId);
            if(!scope||scope.expiresAt<=this.customProbeClock()||!value.customProbe||hash(customProbeBudgetContext(value.customProbe))!==hash(scope.context)||hash(customProbeRequestBinding(scope.context,expected))!==hash(expected))fail('CUSTOM_PROBE_PERMIT_INVALID');
            const limits=customProbeRequestLimits(scope!.context);if(hash(value.customBudget)!==hash(limits))fail('CUSTOM_BUDGET_CONTEXT_STALE');const rows=this.requests();this.checkCustomSupplement(expected,limits,rows);assertCustomRequestBudget(rows,expected,limits,0);
        }else if(expected.engineeringMode==='custom'){
            const limits=this.customLimits(expected);
            if(hash(value.customBudget)!==hash(limits))fail('CUSTOM_BUDGET_HISTORY_MISMATCH');
            this.assertCustomQualified(expected);
            if(value.price.currency!==limits.flow.currency)fail('CUSTOM_BUDGET_CURRENCY_MISMATCH');
            // Includes this exact pending hold. A grant cannot outlive its frozen Store source.
            const rows=this.requests();this.checkCustomSupplement(expected,limits,rows);assertCustomRequestBudget(rows,expected,limits,0);
        }
        return structuredClone(value);
    }
    private assertCustomQualified(binding:NativeRequestBinding):void {
        if(!this.verifyCustomQualification)fail('CUSTOM_ROLE_QUALIFICATION_REQUIRED');
        const result:unknown=this.verifyCustomQualification!(structuredClone(binding));
        if(result!==undefined){if(result instanceof Promise)void result.catch(()=>{});fail('CUSTOM_QUALIFICATION_RESULT_INVALID');}
    }
    /** Must commit before any grant bytes enter the dedicated router's control pipe. */
    beginRouterAdmission(id:string,binding:NativeRequestBinding,input:MagpieGrantIntentInput):MagpieGrantIntent {
        return this.tx(()=>{
            const row=this.pendingBoundRequest(id,binding);
            if(row.binding!.engineeringMode!=='custom')fail('CLASSIC_MAGPIE_FORBIDDEN');
            if(row.routerAdmission)fail('NATIVE_ROUTER_INTENT_EXISTS');
            const value=magpieGrantIntent(input,row.price.expiresAt);
            if(this.requests().some(request=>request.routerAdmission?.admissionId===value.admissionId&&request.routerAdmission.epoch===value.epoch))fail('NATIVE_ROUTER_INTENT_EXISTS');
            row.routerAdmission={...value,status:'INTENT',createdAt:new Date().toISOString(),decidedAt:null};
            this.save(row);return structuredClone(row.routerAdmission);
        });
    }
    /** Matches the exact original control frame. Never dispatches, settles or qualifies an account. */
    acknowledgeRouterAdmission(id:string,binding:NativeRequestBinding,raw:unknown):MagpieGrantIntent {
        return this.tx(()=>{
            const row=this.pendingBoundRequest(id,binding),intent=row.routerAdmission;
            if(!intent)fail('NATIVE_ROUTER_ACK_MISMATCH');
            if(intent!.status!=='INTENT')fail('NATIVE_ROUTER_INTENT_ALREADY_DECIDED');
            const ack=magpieAcknowledgement(raw,intent!,id);
            if(intent!.expiresAtMs<=Date.now())fail('NATIVE_ROUTER_ACK_EXPIRED');
            row.routerAdmission={...intent!,status:ack.accepted?'ACKNOWLEDGED':'DENIED',decidedAt:new Date().toISOString()};
            this.save(row);return structuredClone(row.routerAdmission);
        });
    }
    /** Lost delivery is durable; neither timeout nor restart can mint a replacement grant. */
    markRouterAdmissionUnknown(id:string,controlHash:string):void {
        this.tx(()=>{
            const data=this.db.prepare('SELECT data FROM requests WHERE id=?').get(id);
            if(!data)fail('NATIVE_REQUEST_NOT_FOUND');const row=JSON.parse(String(data!.data)) as RequestRecord,intent=row.routerAdmission;
            if(!intent||intent.controlHash!==controlHash)fail('NATIVE_ROUTER_ACK_MISMATCH');
            if(intent!.status==='UNKNOWN')return;
            if(intent!.status!=='INTENT')fail('NATIVE_ROUTER_INTENT_ALREADY_DECIDED');
            row.routerAdmission={...intent!,status:'UNKNOWN',decidedAt:new Date().toISOString()};this.save(row);
        });
    }
    settle(id: string, usage: NativeUsage | null, outcome: string): void {
        this.tx(() => {
            const row = this.db.prepare('SELECT data FROM requests WHERE id=?').get(id);
            if (!row) fail('NATIVE_REQUEST_NOT_FOUND');
            const r = JSON.parse(row!.data as string) as RequestRecord;
            if(r.binding!==undefined)nativeRequestBinding(r.binding,r.role);
            let normalized: NativeUsage | null = null;
            if (usage && integer(usage.inputTokens) && integer(usage.outputTokens) && integer(usage.cacheHitTokens) &&
                usage.cacheHitTokens <= usage.inputTokens)
                normalized = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheHitTokens: usage.cacheHitTokens };
            if (r.usageStatus !== 'PENDING') {
                if (JSON.stringify(r.usage) !== JSON.stringify(normalized) || r.outcome !== outcome) fail('BUDGET_SETTLEMENT_CONFLICT');
                return;
            }
            r.usage = normalized; r.outcome = outcome;
            const exceeded = !!normalized && (normalized.inputTokens > r.price.maxInputTokens || normalized.outputTokens > r.maxOutputTokens);
            if (exceeded) r.limitExceeded = true;
            r.usageStatus = normalized ? 'KNOWN' : 'UNKNOWN';
            try {
                if('inputMissMicrosPerMillion' in r.price){
                    r.chargedMicros=normalized?cost(normalized.inputTokens,normalized.cacheHitTokens,normalized.outputTokens,r.price):r.reservedMicros;
                }else if(r.price.billing==='CHATGPT_INCLUDED' && r.reservedMicros===0){
                    r.chargedMicros=0; // incremental metered spend only; subscription fees are outside this ledger.
                }else{fail('NATIVE_PRICE_UNKNOWN');}
                if (exceeded) r.chargedMicros = Math.max(r.reservedMicros, r.chargedMicros??r.reservedMicros);
            } catch (error) {
                if (!exceeded || !(error instanceof DomainError) || error.code !== 'NATIVE_COST_OVERFLOW') throw error;
                // Preserve the report and halt: an unrepresentable charge must not roll back the breach.
                r.usageStatus = 'UNKNOWN'; r.chargedMicros = r.reservedMicros;
            }
            this.save(r);
        });
        this.includedHolds.delete(id);
    }
    /** Opening this window is how stale evidence gets replaced; see the preflight comment above. */
    /** Opaque, controller-only capability for this role's probe reservation. Never a global window. */
    beginEvidenceRepair(role:Role):ProbeBudgetPermit {
        if(!probeRoles(this.profile).includes(role))fail('NATIVE_ROLE_NOT_IN_PRODUCT');
        const permit=Object.freeze({}) as ProbeBudgetPermit;this.repairPermits.set(permit,role);return permit;
    }
    endEvidenceRepair(permit:ProbeBudgetPermit):void { this.repairPermits.delete(permit); }
    private repairAllowed(permit?:ProbeBudgetPermit,role?:Role):boolean {
        if(permit===undefined)return false;
        if(!permit||typeof permit!=='object'||!this.repairPermits.has(permit))fail('NATIVE_PROBE_PERMIT_INVALID');
        if(role!==undefined&&this.repairPermits.get(permit)!==role)fail('NATIVE_PROBE_PERMIT_ROLE_MISMATCH');
        return true;
    }
    advance(proofs: Partial<Record<Role, ProbeReceipt>>): void {
        this.tx(() => {
            const required=probeRoles(this.profile);
            if(Object.keys(proofs).some(role=>!required.includes(role as Role)))fail('NATIVE_ROLE_NOT_IN_PRODUCT');
            this.assertUsageBounds();
            if (required.some(role => !proofs[role]?.evidenceId || !proofs[role]?.model || proofs[role]?.source !== 'REAL_MODEL_RESPONSE')) fail('PROBE_EVIDENCE_INCOMPLETE');
            if (required.some(role => !this.verifyReceipt(role, proofs[role]!))) fail('PROBE_EVIDENCE_UNVERIFIED');
            if (this.summary().inFlight) fail('NATIVE_REQUEST_ALREADY_IN_FLIGHT');
            for(const role of required)this.db.prepare('INSERT INTO probe_proofs VALUES(?,?) ON CONFLICT(role) DO UPDATE SET data=excluded.data').run(role,JSON.stringify(proofs[role]));
            this.db.prepare("UPDATE scope SET phase='REPRESENTATIVE' WHERE id=1").run();
        });
    }
    /**
     * Substantive-repair accounting is PER RUN, not per scope.
     *
     * It used to gate on the scope-wide `repairs` counter, so every earlier run that used a repair made
     * the next run start closer to the limit — run_a498465cb1dba7c0b532 reached 7/8 implemented tasks with
     * `repairCount=0/2` of its own and was still blocked with NATIVE_REPAIR_LIMIT_EXCEEDED. The scope
     * counter keeps counting for the audit trail; the gate now uses a per-run ledger, so a new run gets
     * exactly the ceiling this authority declares and history cannot pre-consume it. Ceilings are unchanged.
     */
    /** Read-only; absence of the historical repair table is a count of zero, not permission. */
    repairRevision(runId:string):number {
        if(typeof runId!=='string'||!runId.trim()||runId.length>200)fail('NATIVE_REPAIR_RUN_UNBOUND');
        if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='repair_ledger'").get())return 0;
        return Number(this.db.prepare('SELECT count(*) AS n FROM repair_ledger WHERE run_id=?').get(runId)!.n);
    }
    repair(runId: string): void {
        // A missing run id used to reach SQLite as `undefined` and surface as ERR_INVALID_ARG_TYPE, which
        // reads like a driver fault instead of a caller fault. Refuse it before touching the ledger.
        if (typeof runId !== 'string' || !runId.trim() || runId.length > 200)
            throw new DomainError('NATIVE_REPAIR_RUN_UNBOUND', 409);
        this.tx(() => {
            this.db.exec('CREATE TABLE IF NOT EXISTS repair_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL)');
            const n = Number(this.db.prepare('SELECT COUNT(*) AS c FROM repair_ledger WHERE run_id=?').get(runId)!.c);
            if (n >= this.authority.maxRepairs) fail('NATIVE_REPAIR_LIMIT_EXCEEDED');
            this.db.prepare('INSERT INTO repair_ledger(run_id, at) VALUES(?,?)').run(runId, new Date().toISOString());
            this.db.prepare('UPDATE scope SET repairs=repairs+1 WHERE id=1').run();
        });
    }
    close(): void {
        this.repairPermits=new WeakMap();
        this.engineeringPermits.clear();
        this.includedHolds.clear();
        this.customProbePermits.clear();
        if (!this.closed) {
            this.db.prepare('DELETE FROM controller WHERE id=1 AND token=?').run(this.ownerToken);
            this.db.close(); this.closed = true;
        }
    }
}
