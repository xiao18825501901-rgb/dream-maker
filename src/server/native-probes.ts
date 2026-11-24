import {createHmac,randomUUID} from 'node:crypto';
import {DomainError,hash,canonical,object,safeEqual,hasSecret,isCustomProbeNonce} from './security.js';
import type {Store} from './store.js';
import type {Role,RolePolicy} from '../shared/types.js';
import type {NativeBudget,ProbeReceipt} from './native-budget.js';
import {probeRoles,type ProbeProfile} from './flow/probe-profile.js';
import {cleanupUncertain} from './cleanup-uncertainty.js';
import type {NativeRequestBinding} from '../shared/native-request.js';
import type {CustomRequestBudget} from './flow/custom-budget.js';
import {customProbeBudgetContext,customProbeRequestBinding,customProbeRequestLimits,type CustomProbeBudgetContext} from './flow/custom-probe-budget.js';
import {assertCustomProbeActor,CUSTOM_TEXT_CLI_RUNNERS,isCustomTextCliRuntime} from './flow/custom-role-identity.js';

export interface ProbeBinding {
    profile?:ProbeProfile;
    rolePolicy?:RolePolicy;
    scopeId:string;authorizationHash:string;sourceHash:string;configurationHash:string;expiresAt:string;
    planner1Mode:'api_key'|'siwc_plan'|'local'|'user';models:Record<Role,string>;
    planner1Provider?:string;
    /**
     * Which shape proves a real turn for planner2/reviewer. These two roles used to be provable only by
     * the Codex subscription CLI; an independent API-key provider is a different, self-consistent shape,
     * and the shape is bound into the signed payload so a receipt from one can never be replayed as the
     * other.
     */
    planner2Mode:'api_key'|'chatgpt_subscription';
    /** Honest label for the independent pair: cross-vendor, or the degraded same-vendor fallback. */
    independence?:'CROSS_VENDOR'|'DEGRADED_SAME_VENDOR';
    independentProvider?:string;
    /** Ceilings that grant authority (spend, repairs, tool reach): a change here must invalidate receipts. */
    policyCriticalHash?:string;
    /** Timeouts and wall-clock windows only: a change here must NOT invalidate receipts. */
    policyOperationalHash?:string;
    /** Which verifier plan / spec this receipt was taken against. */
    verificationHash?:string;
}
export interface ProbeObservation {
    role:Role;model:string;runner:'LLM_API'|'LOCAL_HTTP'|'CODEX'|'DSH'|'KIMI_SERVER';provider:string;
    authentication:'API_KEY'|'NONE'|'CHATGPT_SUBSCRIPTION'|'MEMBER_SUBSCRIPTION';responseId:string;responseHash:string;
    sessionId?:string;accountFingerprint?:string;includedUsageAllowed?:boolean;
    /** Subscription legs are counted in account generations, not in CNY ledger entries. */
    credentialGeneration?:number;
    paidFallback:false;ledgerRequestIds:string[];cleanupReturned:true;reply:string;
}
export interface CustomProbeActor {role:'planner2'|'executor'|'reviewer';roleId:string;runtime:string;provider:string;authentication:'API_KEY'|'CHATGPT_SUBSCRIPTION'|'MEMBER_SUBSCRIPTION';transport:'magpie'|'native';model:string;authRef:string;accountRef:string}
/** Separate signed domain. Neither a Classic receipt nor a UI configuration is this proof. */
export interface CustomProbeBinding {
    schema:'dream-maker.custom-probe-binding.v1';flowConfigHash:string;sourceBindingHash:string;credentialHash:string;runtimeHash:string;authorizationHash:string;expiresAt:string;roles:CustomProbeActor[];
}
export interface CustomProbeObservation extends CustomProbeActor {
    runner:'DSH'|'CODEX'|'INDEPENDENT_API'|'KIMI_SERVER'|'CLAUDE_CODE'|'PI_CLI'|'OPENCODE_CLI'|'CLINE_CLI';responseId:string;responseHash:string;sessionId:string;routeHash:string;
    paidFallback:false;ledgerRequestIds:string[];cleanupReturned:true;reply:string;
}
export interface CustomProbeReceipt {evidenceId:string;probeId:string;role:'planner2'|'executor'|'reviewer';roleId:string;model:string;source:'REAL_MODEL_RESPONSE'}
interface PaidEntry {id:string;role:string;price:{provider:string;model:string};usageStatus:string;outcome:string|null;limitExceeded?:boolean;
    reservedMicros?:number|null;chargedMicros?:number|null;customProbe?:CustomProbeBudgetContext;binding?:NativeRequestBinding;customBudget?:CustomRequestBudget;engineeringAcceptance?:unknown}
interface Payload {schema:'dream-maker.minimum-role-probe.v1';binding:ProbeBinding;role:Role;nonce:string;at:string;observation:ProbeObservation}
/** Tolerated future-dating on a receipt: this machine's clock has jumped by hours inside one session. */
const PROBE_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
const roles:Role[]=['planner1','planner2','executor','reviewer'];
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const identity=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v);
const actorKeys=['role','roleId','runtime','provider','authentication','model','authRef','accountRef'];
function customBinding(raw:CustomProbeBinding):CustomProbeBinding {
    const value=structuredClone(raw),keys=['schema','flowConfigHash','sourceBindingHash','credentialHash','runtimeHash','authorizationHash','expiresAt','roles'];
    if(!value||Reflect.ownKeys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k))||value.schema!=='dream-maker.custom-probe-binding.v1'||
        ![value.flowConfigHash,value.sourceBindingHash,value.credentialHash,value.runtimeHash,value.authorizationHash].every(digest)||
        typeof value.expiresAt!=='string'||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.now()||
        !Array.isArray(value.roles)||value.roles.length<3||value.roles.length>18||hasSecret(JSON.stringify(value)))throw new DomainError('CUSTOM_PROBE_BINDING_INVALID',409);
    for(const actor of value.roles){
        if(!actor||Reflect.ownKeys(actor).length!==actorKeys.length+Number(Object.hasOwn(actor,'transport'))||Object.hasOwn(actor,'transport')&&!['native','magpie'].includes(actor.transport)||actorKeys.some(k=>!Object.hasOwn(actor,k))||!['planner2','executor','reviewer'].includes(actor.role)||
            ![actor.roleId,actor.authRef,actor.accountRef].every(v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v))||
            actor.role!=='executor'&&actor.roleId!==actor.role)throw new DomainError('CUSTOM_PROBE_BINDING_INVALID',409);
        assertCustomProbeActor(actor);
    }
    if(new Set(value.roles.map(r=>r.roleId)).size!==value.roles.length||value.roles.filter(r=>r.role==='planner2').length!==1||value.roles.filter(r=>r.role==='reviewer').length!==1||!value.roles.some(r=>r.role==='executor'))throw new DomainError('CUSTOM_PROBE_BINDING_INVALID',409);
    return value;
}

// Invocations are supplied only by the trusted production owner, never HTTP payloads.
// Signatures bind controller observations; they are not a native safety or project audit.
export class NativeProbes {
    #key:Buffer;#closed=false;#busy=false;#controller?:AbortController;
    #pending?:Promise<ProbeObservation>;
    #closing?:Promise<void>;#cleanupUncertain=false;
    constructor(private options:{store:Store;key:Uint8Array;current:()=>ProbeBinding;ledger:()=>PaidEntry[];
        invoke:(role:Role,challenge:string,signal:AbortSignal)=>Promise<ProbeObservation>}){
        if(options.key.length!==32)throw new DomainError('NATIVE_PROBE_KEY_INVALID',409);
        this.#key=Buffer.from(options.key);
    }
    private binding(){
        if(this.#closed)throw new DomainError('NATIVE_PROBES_CLOSED',409);
        const value=structuredClone(this.options.current());
        probeRoles(value.profile);
        if(value.planner1Provider!==undefined&&!(
            value.planner1Mode==='api_key'&&['openai-official','deepseek-official'].includes(value.planner1Provider)||
            value.planner1Mode==='local'&&value.planner1Provider==='local-ollama'
        ))throw new DomainError('NATIVE_PROBE_BINDING_INVALID',409);
        if(!value.scopeId||![value.authorizationHash,value.sourceHash,value.configurationHash].every(digest)||
            !Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.now()||
            !['api_key','siwc_plan','local','user'].includes(value.planner1Mode)||
            (value.profile!=='ENGINEERING_ONLY'&&value.planner1Mode==='user')||
            !['api_key','chatgpt_subscription'].includes(value.planner2Mode))throw new DomainError('NATIVE_PROBE_BINDING_INVALID',409);
        return value;
    }
    private sign(payload:Payload){return createHmac('sha256',this.#key).update(canonical(payload)).digest('hex');}
    private observation(value:ProbeObservation,role:Role,binding:ProbeBinding,nonce:string){
        if(!value||value.role!==role||!binding.models[role]||value.model!==binding.models[role]||!identity(value.responseId)||
            !digest(value.responseHash)||value.cleanupReturned!==true||value.paidFallback!==false||value.reply!==nonce||
            hasSecret(JSON.stringify(value)))throw new DomainError('NATIVE_PROBE_COMPLETION_UNVERIFIED',409);
        const codex=role==='planner2'||role==='reviewer';
        // planner2/reviewer are proven by the Codex subscription shape only while the binding says so;
        // under an independent API-key provider they fall through to the paid shape below, which is the
        // one that demands exactly one settled ledger entry for the same model the binding froze.
        if(codex&&binding.planner2Mode!=='api_key'){
            if(value.runner!=='CODEX'||value.provider!=='openai'||value.authentication!=='CHATGPT_SUBSCRIPTION'||
                value.includedUsageAllowed!==true||!identity(value.sessionId)||!digest(value.accountFingerprint)||
                !Array.isArray(value.ledgerRequestIds)||value.ledgerRequestIds.length)throw new DomainError('NATIVE_PROBE_CODEX_UNVERIFIED',409);
        }else if(role==='planner1'&&binding.planner1Mode==='siwc_plan'){
            // The active planner1 is a member subscription behind the Kimi server, so its proof is a
            // real model answer plus the credential generation it spent — never a CNY ledger entry.
            // A paid-shaped observation under this binding is refused instead of being read as proof.
            if(value.runner!=='KIMI_SERVER'||value.provider!=='kimi-official'||value.authentication!=='MEMBER_SUBSCRIPTION'||
                value.includedUsageAllowed!==true||!digest(value.accountFingerprint)||!identity(value.sessionId)||
                !Number.isSafeInteger(value.credentialGeneration)||(value.credentialGeneration as number)<1||
                !Array.isArray(value.ledgerRequestIds)||value.ledgerRequestIds.length)
                throw new DomainError('NATIVE_PROBE_SUBSCRIPTION_UNVERIFIED',409);
        }else if(role==='planner1'&&binding.planner1Mode==='local'){
            if(value.runner!=='LOCAL_HTTP'||value.provider!=='local-ollama'||value.authentication!=='NONE'||
                !Array.isArray(value.ledgerRequestIds)||value.ledgerRequestIds.length)
                throw new DomainError('NATIVE_PROBE_LOCAL_UNVERIFIED',409);
        }else{
            const provider=role==='executor'?'deepseek-official':role==='planner1'&&binding.planner1Provider?binding.planner1Provider:(binding.independentProvider??'openai-official');
            if(value.runner!==(role==='executor'?'DSH':'LLM_API')||value.provider!==provider||value.authentication!=='API_KEY'||
                !Array.isArray(value.ledgerRequestIds)||value.ledgerRequestIds.length!==1||
                role==='executor'&&!identity(value.sessionId))throw new DomainError('NATIVE_PROBE_PAID_COMPLETION_UNVERIFIED',409);
            const request=this.options.ledger().find(r=>r.id===value.ledgerRequestIds[0]);
            if(!request||request.limitExceeded||request.role!==role||!['KNOWN','UNKNOWN'].includes(request.usageStatus)||
                request.outcome!==(role==='executor'?'COMPLETE':'RESPONSE_RECEIVED')||
                request.price.provider!==provider||request.price.model!==value.model)throw new DomainError('NATIVE_PROBE_LEDGER_UNVERIFIED',409);
            if(request.customProbe!==undefined||request.engineeringAcceptance!==undefined||request.binding!==undefined&&request.binding.engineeringMode!=='classic')throw new DomainError('NATIVE_PROBE_ROUTE_SCOPE_MISMATCH',409);
        }
    }
    private read(reference:ProbeReceipt):Payload{
        const row=this.options.store.db.prepare("SELECT data FROM records WHERE id=? AND kind='NativeProbeReceipt' AND project_id IS NULL AND run_id IS NULL").get(reference.evidenceId);
        if(!row||typeof row.data!=='string'||Buffer.byteLength(row.data)>12000)throw new DomainError('NATIVE_PROBE_RECEIPT_REQUIRED',409);
        const envelope=object(JSON.parse(row.data)),payload=object(envelope.payload) as unknown as Payload;
        if(payload.schema!=='dream-maker.minimum-role-probe.v1'||!digest(envelope.signature)||
            !safeEqual(envelope.signature as string,this.sign(payload)))throw new DomainError('NATIVE_PROBE_SIGNATURE_INVALID',409);
        return payload;
    }
    /** Identity that a receipt must match. Operational timeouts are excluded on purpose: tuning them is
     *  routine and must not invalidate a receipt, while every authority-granting ceiling stays inside
     *  configurationHash (which is computed over policyCriticalHash and verificationHash). */
    private static identity(binding:ProbeBinding){const{policyOperationalHash:_ignored,...rest}=binding;return rest;}
    verify(role:Role,reference:ProbeReceipt):boolean{
        try{return this.verifyAgainstBinding(role,reference,this.binding());}catch{return false;}
    }
    private verifyAgainstBinding(role:Role,reference:ProbeReceipt,current:ProbeBinding):boolean{
        try{
            if(!probeRoles(current.profile).includes(role))return false;
            const payload=this.read(reference);
            const same=hash(NativeProbes.identity(payload.binding))===hash(NativeProbes.identity(current));
            if(!same&&process.env.DM_PROBE_TRACE==='1'){
                // A refusal that cannot name its cause costs a whole Live run each time (run_dce85aff99d8c4eaab81
                // blocked at BUILD with PROBE_EVIDENCE_UNVERIFIED after a fresh probe). Name the fields whose
                // binding differs — key names and short hashes only, never a prompt, key or content.
                const left=NativeProbes.identity(payload.binding) as unknown as Record<string,unknown>;
                const right=NativeProbes.identity(current) as unknown as Record<string,unknown>;
                const diff=Object.keys({...left,...right}).filter(k=>JSON.stringify(left[k])!==JSON.stringify(right[k]));
                console.error('PROBE_BINDING_DIFF ' + JSON.stringify({role,fields:diff}));
            }
            if(reference.source!=='REAL_MODEL_RESPONSE'||reference.model!==current.models[role]||
                payload.role!==role||!same||!Number.isFinite(Date.parse(payload.at))||
                Date.parse(payload.at)-Date.now()>PROBE_CLOCK_SKEW_MS)return false;
            // A receipt stamped "in the future" is almost always this machine's clock jumping (observed:
            // the same session logged 06:1x and 14:2x), not a forged receipt. Skew up to a day is accepted
            // and named in the log; anything larger is still refused, and expiry is enforced separately.
            const skew=Date.parse(payload.at)-Date.now();
            if(skew>0)console.error('PROBE_CLOCK_SKEW ' + JSON.stringify({role,skewMs:skew}));
            // The comment above said 'expiry is enforced separately', but nothing read `expiresAt`: the operator
            // binding signs probeExpiresAt into every receipt and an expired one verified exactly like a fresh
            // receipt, so the field was a claim the product never kept. Stale evidence must be re-taken (three
            // cheap probes), never silently extended — the same rule the audit expiry already follows.
            if(typeof current.expiresAt==='string'&&current.expiresAt!==''){
                const expiry=Date.parse(current.expiresAt);
                if(!Number.isFinite(expiry)||expiry<=Date.now()){
                    if(process.env.DM_PROBE_TRACE==='1')console.error('PROBE_EXPIRED ' + JSON.stringify({role,expiresAt:current.expiresAt}));
                    return false;
                }
            }
            this.observation(payload.observation,role,current,payload.nonce);return true;
        }catch{return false;}
    }
    private cached(role:Role):ProbeReceipt|null{
        // One synchronous historical lookup needs one current source inventory. Do not
        // repeat filesystem hashing for every stale receipt or retain it across calls.
        let current:ProbeBinding;
        try{current=structuredClone(this.binding());}catch{return null;}
        const query=this.options.store.db.prepare("SELECT id,data FROM records WHERE kind='NativeProbeReceipt' AND project_id IS NULL AND run_id IS NULL ORDER BY rowid DESC LIMIT 64");
        for(const row of query.iterate()){
            if(typeof row.data!=='string'||Buffer.byteLength(row.data)>12000)continue;
            try{
                const payload=object(object(JSON.parse(row.data)).payload);
                if(payload.role!==role)continue;
                const ref:ProbeReceipt={evidenceId:String(row.id),model:String(object(payload.observation).model),source:'REAL_MODEL_RESPONSE'};
                if(this.verifyAgainstBinding(role,ref,current))return ref;
            }catch{}
        }
        return null;
    }
    private latestSigned(role:Role):ProbeReceipt|null{
        const query=this.options.store.db.prepare("SELECT id,data FROM records WHERE kind='NativeProbeReceipt' AND project_id IS NULL AND run_id IS NULL ORDER BY rowid DESC LIMIT 64");
        for(const row of query.iterate()){
            if(typeof row.data!=='string'||Buffer.byteLength(row.data)>12000)continue;
            try{
                const payload=object(object(JSON.parse(row.data)).payload);
                if(payload.role!==role)continue;
                const ref:ProbeReceipt={evidenceId:String(row.id),model:String(object(payload.observation).model),source:'REAL_MODEL_RESPONSE'};
                this.read(ref);
                return ref;
            }catch{}
        }
        return null;
    }
    private required(role:Role):ProbeReceipt{
        const current=this.cached(role);
        if(current)return current;
        // Presence and validity are different facts. A signed receipt whose source,
        // configuration, expiry or account binding changed must not be presented as
        // if no probe had ever run.
        if(this.latestSigned(role))throw new DomainError('NATIVE_PROBE_BINDING_CHANGED',409);
        throw new DomainError('NATIVE_PROBE_MISSING',409);
    }
    /** What the owner needs to see before a Live run: which roles already hold a VERIFYING receipt. */
    status():Record<Role,{present:boolean;valid:boolean}>{
        const rows=this.options.store.db.prepare("SELECT data FROM records WHERE kind='NativeProbeReceipt' AND project_id IS NULL AND run_id IS NULL").all();
        const rolesSeen=new Set<string>();
        for(const row of rows)try{const role=object(object(JSON.parse(String(row.data)).payload).observation).role;if(typeof role==='string')rolesSeen.add(role);}catch{}
        const out={} as Record<Role,{present:boolean;valid:boolean}>;
        for(const role of roles)out[role]={present:rolesSeen.has(role),valid:!!this.cached(role)};
        return out;
    }
    evidence():Partial<Record<Role,Pick<ProbeObservation,'model'|'runner'|'provider'|'authentication'>&{evidenceId:string;at:string}>>{
        const out:ReturnType<NativeProbes['evidence']>={};
        let required:Role[];try{required=probeRoles(this.binding().profile);}catch{return out;}
        for(const role of required){try{
            const reference=this.cached(role);if(!reference)continue;
            const {observation,at}=this.read(reference);
            out[role]={evidenceId:reference.evidenceId,at,model:observation.model,runner:observation.runner,provider:observation.provider,authentication:observation.authentication};
        }catch{/* Unavailable evidence is unknown, never a configured-model substitute. */}}
        return out;
    }
    /** Only a current signed real Codex receipt supplies the account expectation. */
    codexAccountFingerprint(role:'planner2'|'reviewer'):string{
        const reference=this.required(role);
        const observation=this.read(reference).observation;
        if(observation.runner!=='CODEX'||observation.authentication!=='CHATGPT_SUBSCRIPTION'||!digest(observation.accountFingerprint))throw new DomainError('NATIVE_PROBE_CODEX_ACCOUNT_OR_MODEL_CHANGED',409);
        return observation.accountFingerprint!;
    }
    /** The original journal and ledger remain authoritative at both issuance and read. */
    private customSession(raw:unknown,binding:CustomProbeBinding,actor:CustomProbeActor,ledger:PaidEntry[]):string|undefined {
        try{
            const p=object(raw),o=object(p.observation),bindingHash=hash(binding);
            const keys=['schema','binding','at','attemptId','probeId','dispatchId','generation','nonce','observation'];
            if(Reflect.ownKeys(p).length!==keys.length||keys.some(k=>!Object.hasOwn(p,k))||p.schema!=='dream-maker.custom-minimum-role-probe.v1'||
                hash(p.binding)!==bindingHash||typeof p.at!=='string'||!Number.isFinite(Date.parse(p.at))||Date.parse(p.at)>Date.now()+PROBE_CLOCK_SKEW_MS||
                ![p.attemptId,p.probeId,p.dispatchId,p.generation].every(identity)||!isCustomProbeNonce(p.nonce)||hasSecret(JSON.stringify(p)))return;
            const boundKeys=Object.hasOwn(actor,'transport')?[...actorKeys,'transport']:actorKeys;
            const observedKeys=[...boundKeys,'runner','responseId','responseHash','sessionId','routeHash','paidFallback','ledgerRequestIds','cleanupReturned','reply'];
            if(Reflect.ownKeys(o).length!==observedKeys.length||observedKeys.some(k=>!Object.hasOwn(o,k))||
                boundKeys.some(k=>o[k]!==actor[k as keyof CustomProbeActor])||!['DSH','CODEX','INDEPENDENT_API','KIMI_SERVER','CLAUDE_CODE','PI_CLI',...Object.values(CUSTOM_TEXT_CLI_RUNNERS)].includes(String(o.runner))||!identity(o.sessionId)||!identity(o.responseId)||!digest(o.responseHash)||!digest(o.routeHash)||
                o.paidFallback!==false||o.cleanupReturned!==true||o.reply!==p.nonce||!Array.isArray(o.ledgerRequestIds))return;
            if(actor.runtime==='kimi'){
                // Kimi is a membership subscription: the reviewed turn itself is the
                // proof, and its separate usage ledger must never appear as a Native row.
                if(actor.authentication!=='MEMBER_SUBSCRIPTION'||o.runner!=='KIMI_SERVER'||o.ledgerRequestIds.length!==0)return;
            }else if((actor.runtime==='codex'||actor.runtime==='independent')&&actor.authentication!=='API_KEY'){
                // A native subscription turn carries no paid ledger row. A Codex turn routed
                // through DM-owned Magpie has exactly one zero-cost included-quota row so the
                // request remains attributable without turning the subscription into a paid fallback.
                if(o.runner!==(actor.runtime==='codex'?'CODEX':'INDEPENDENT_API'))return;
                if(actor.runtime==='codex'&&actor.authentication!=='CHATGPT_SUBSCRIPTION')return;
                if(o.ledgerRequestIds.length!==0){
                    if(actor.runtime!=='codex'||o.ledgerRequestIds.length!==1)return;
                    const ids=o.ledgerRequestIds,request=ledger.find(r=>r.id===ids[0]),requests=ledger.filter(r=>r.customProbe?.probeId===p.probeId),price=request?.price as (PaidEntry['price']&{billing?:unknown;source?:unknown})|undefined;
                    if(!request||requests.length!==1||request.id!==ids[0]||request.role!==actor.role||request.limitExceeded||request.usageStatus!=='KNOWN'||request.outcome!=='COMPLETE'||
                        request.reservedMicros!==0||request.chargedMicros!==0||price?.provider!==actor.provider||price.model!==actor.model||
                        price.billing!=='CHATGPT_INCLUDED'||price.source!=='CODEX_INCLUDED_QUOTA'||!request.customProbe||!request.binding)return;
                    const scope=customProbeBudgetContext(request.customProbe);
                    if(scope.bindingHash!==bindingHash||scope.configurationHash!==binding.flowConfigHash||scope.role!==actor.role||scope.roleId!==actor.roleId||scope.routeHash!==o.routeHash||scope.dispatchId!==p.dispatchId||scope.generation!==p.generation||scope.probeId!==p.probeId||
                        hash(customProbeRequestBinding(scope,request.binding))!==hash(request.binding)||hash(customProbeRequestLimits(scope))!==hash(request.customBudget))return;
                }
            }else{
                const expectedRunner=isCustomTextCliRuntime(actor.runtime)?CUSTOM_TEXT_CLI_RUNNERS[actor.runtime]:actor.runtime==='claude'?'CLAUDE_CODE':actor.runtime==='pi'?'PI_CLI':actor.runtime==='dsh'?'DSH':actor.runtime==='codex'?'CODEX':actor.runtime==='independent'?'INDEPENDENT_API':null;
                const maxRequests=actor.runtime==='dsh'||actor.runtime==='claude'?1:4;
                if(actor.authentication!=='API_KEY'||!expectedRunner||o.runner!==expectedRunner||o.ledgerRequestIds.length<1||o.ledgerRequestIds.length>maxRequests||new Set(o.ledgerRequestIds).size!==o.ledgerRequestIds.length)return;
                const ids=o.ledgerRequestIds;
                const requests=ledger.filter(r=>r.customProbe?.probeId===p.probeId);
                if(requests.length!==ids.length||requests.some(r=>!ids.includes(r.id)))return;
                for(const ledgerId of ids){
                const request=requests.find(r=>r.id===ledgerId);
                if(!request||request.role!==actor.role||request.limitExceeded||!['KNOWN','UNKNOWN'].includes(request.usageStatus)||request.outcome!=='COMPLETE'||
                    request.price.provider!==actor.provider||request.price.model!==actor.model||!request.customProbe||!request.binding)return;
                const scope=customProbeBudgetContext(request.customProbe);
                if(scope.bindingHash!==bindingHash||scope.configurationHash!==binding.flowConfigHash||scope.role!==actor.role||scope.roleId!==actor.roleId||scope.routeHash!==o.routeHash||scope.dispatchId!==p.dispatchId||scope.generation!==p.generation||scope.probeId!==p.probeId||
                    hash(customProbeRequestBinding(scope,request.binding))!==hash(request.binding)||hash(customProbeRequestLimits(scope))!==hash(request.customBudget))return;
                }
            }
            const attempt=this.options.store.db.prepare("SELECT data FROM records WHERE id=? AND kind='NativeCustomProbeAttempt' AND project_id IS NULL AND run_id IS NULL").get(String(p.attemptId));
            if(!attempt||hash(JSON.parse(String(attempt.data)))!==hash({probeId:p.probeId,bindingHash,role:actor.role,roleId:actor.roleId,dispatchId:p.dispatchId,generation:p.generation,nonce:p.nonce}))return;
            const attempts=this.options.store.db.prepare("SELECT id FROM records WHERE kind='NativeCustomProbeAttempt' AND project_id IS NULL AND run_id IS NULL AND (json_extract(data,'$.probeId')=? OR json_extract(data,'$.dispatchId')=?) LIMIT 2").all(String(p.probeId),String(p.dispatchId));
            if(attempts.length!==1||attempts[0].id!==p.attemptId)return;
            const journal=this.options.store.db.prepare("SELECT kind,data FROM records WHERE project_id IS NULL AND run_id IS NULL AND kind IN ('DispatchGranted','DispatchFinished','DispatchReconciled') AND json_extract(data,'$.dispatchId')=?").all(String(p.dispatchId));
            if(journal.length!==2)return;
            const grant=journal.find(r=>r.kind==='DispatchGranted'),finished=journal.find(r=>r.kind==='DispatchFinished');if(!grant||!finished)return;
            const g=JSON.parse(String(grant.data)),f=JSON.parse(String(finished.data));
            if(g.generation!==p.generation||g.kind!==actor.role||g.mode!=='live'||g.purpose!=='CUSTOM_ROLE_PROBE'||g.acceptanceId!==p.probeId||actor.role==='executor'&&g.executorRoleId!==actor.roleId||
                // The original Finish schema carries dispatch/generation/purpose, not
                // duplicated role fields. Its unique Grant binds the role and mode.
                f.generation!==p.generation||f.purpose!=='CUSTOM_ROLE_PROBE'||f.acceptanceId!==p.probeId||f.outcome!=='COMPLETED'||f.cleanupReturned!==true)return;
            return String(o.sessionId);
        }catch{return;}
    }
    /** Controller-only observations, never an HTTP signing endpoint. The caller must
     * first join the original Dispatch and its owned processes, then rebind the runtime. */
    issueCustom(raw:CustomProbeBinding,attemptId:string,observed:CustomProbeObservation):CustomProbeReceipt {
        if(this.#closed)throw new DomainError('NATIVE_PROBES_CLOSED',409);
        if(this.#busy||this.#cleanupUncertain)throw new DomainError('NATIVE_PROBE_BUSY',409);
        const binding=customBinding(raw),observation=structuredClone(observed),actor=binding.roles.find(r=>r.roleId===observation.roleId);
        const fail=():never=>{throw new DomainError('CUSTOM_PROBE_ISSUANCE_UNVERIFIED',409);};
        if(!actor||!identity(attemptId))return fail();
        return this.options.store.tx(()=>{
            const attempt=this.options.store.db.prepare("SELECT data FROM records WHERE id=? AND kind='NativeCustomProbeAttempt' AND project_id IS NULL AND run_id IS NULL").get(attemptId);
            if(!attempt)return fail();
            const a=object(JSON.parse(String(attempt.data))),payload={schema:'dream-maker.custom-minimum-role-probe.v1',binding,at:new Date().toISOString(),attemptId,probeId:a.probeId,dispatchId:a.dispatchId,generation:a.generation,nonce:a.nonce,observation};
            const ledger=this.options.ledger();if(!this.customSession(payload,binding,actor,ledger))return fail();
            // Exact physical identity is global, never a rolling recent-history cache.
            const issued=this.options.store.db.prepare("SELECT id,data FROM records WHERE kind='NativeCustomProbeReceipt' AND project_id IS NULL AND run_id IS NULL AND (json_extract(data,'$.payload.attemptId')=? OR json_extract(data,'$.payload.probeId')=? OR json_extract(data,'$.payload.dispatchId')=?) LIMIT 2").all(attemptId,String(a.probeId),String(a.dispatchId));
            if(issued.length){
                if(issued.length!==1)return fail();const row=issued[0],envelope=object(JSON.parse(String(row.data))),p=object(envelope.payload);
                if(p.attemptId!==attemptId||!digest(envelope.signature)||!safeEqual(String(envelope.signature),createHmac('sha256',this.#key).update(canonical(p)).digest('hex'))||hash(p.observation)!==hash(observation)||!this.customSession(p,binding,actor,ledger))return fail();
                return{evidenceId:String(row.id),probeId:String(p.probeId),role:actor.role,roleId:actor.roleId,model:actor.model,source:'REAL_MODEL_RESPONSE'};
            }
            const rows=this.options.store.db.prepare("SELECT data FROM records WHERE kind='NativeCustomProbeReceipt' AND project_id IS NULL AND run_id IS NULL AND json_extract(data,'$.payload.observation.sessionId')=? AND json_extract(data,'$.payload.observation.roleId')<>? LIMIT 257").all(observation.sessionId,actor.roleId);
            if(rows.length>256)return fail();
            for(const row of rows){
                let envelope:Record<string,unknown>,p:Record<string,unknown>;
                try{envelope=object(JSON.parse(String(row.data)));p=object(envelope.payload);object(p.observation);}catch{continue;}
                const other=binding.roles.find(r=>r.roleId===object(p.observation).roleId);
                if(other&&other.roleId!==actor.roleId&&digest(envelope.signature)&&safeEqual(String(envelope.signature),createHmac('sha256',this.#key).update(canonical(p)).digest('hex'))&&this.customSession(p,binding,other,ledger)===observation.sessionId)throw new DomainError('CUSTOM_ROLE_SESSIONS_REUSED',409);
            }
            const envelope={payload,signature:createHmac('sha256',this.#key).update(canonical(payload)).digest('hex')};
            const evidenceId=this.options.store.record('NativeCustomProbeReceipt',null,null,envelope);
            return{evidenceId,probeId:String(payload.probeId),role:actor.role,roleId:actor.roleId,model:actor.model,source:'REAL_MODEL_RESPONSE'};
        });
    }
    /** Exact readback for an idempotent HTTP replay; never starts or signs anything. */
    customEvidence(raw:CustomProbeBinding,roleId:string,evidenceId:string):CustomProbeReceipt {
        if(this.#closed)throw new DomainError('NATIVE_PROBES_CLOSED',409);
        const binding=customBinding(raw),actor=binding.roles.find(r=>r.roleId===roleId);
        const row=this.options.store.db.prepare("SELECT data FROM records WHERE id=? AND kind='NativeCustomProbeReceipt' AND project_id IS NULL AND run_id IS NULL").get(evidenceId);
        try{
            if(!actor||!row||typeof row.data!=='string'||Buffer.byteLength(row.data)>64000)throw Error();
            const envelope=object(JSON.parse(row.data)),p=object(envelope.payload);
            if(!digest(envelope.signature)||!safeEqual(String(envelope.signature),createHmac('sha256',this.#key).update(canonical(p)).digest('hex'))||!this.customSession(p,binding,actor,this.options.ledger()))throw Error();
            return{evidenceId,probeId:String(p.probeId),role:actor.role,roleId:actor.roleId,model:actor.model,source:'REAL_MODEL_RESPONSE'};
        }catch{throw new DomainError('CUSTOM_PROBE_ISSUANCE_UNVERIFIED',409);}
    }
    /** Read-only Custom admission. Neither public flags nor Classic evidence qualify it. */
    assertCustomReady(raw:CustomProbeBinding,expectedRoute?:{roleId:string;routeHash:string}):void {
        if(this.#closed)throw new DomainError('NATIVE_PROBES_CLOSED',409);
        const binding=customBinding(raw),ledger=this.options.ledger(),sessions=new Map<string,string>();
        // customBinding already enforces unique roleIds across all roles and executors.
        if(expectedRoute!==undefined&&(!expectedRoute||!digest(expectedRoute.routeHash)||!binding.roles.some(r=>r.roleId===expectedRoute.roleId)))
            throw new DomainError('CUSTOM_ROLE_QUALIFICATION_REQUIRED',409);
        const rows=this.options.store.db.prepare("SELECT data FROM records WHERE kind='NativeCustomProbeReceipt' AND project_id IS NULL AND run_id IS NULL ORDER BY rowid DESC LIMIT 256").all();
        for(const actor of binding.roles){
            let session:string|undefined;
            for(const row of rows)try{
                if(typeof row.data!=='string'||Buffer.byteLength(row.data)>64000)continue;
                const envelope=object(JSON.parse(row.data)),p=object(envelope.payload);
                if(!digest(envelope.signature)||!safeEqual(String(envelope.signature),createHmac('sha256',this.#key).update(canonical(p)).digest('hex')))continue;
                if(expectedRoute?.roleId===actor.roleId&&object(p.observation).routeHash!==expectedRoute.routeHash)continue;
                session=this.customSession(p,binding,actor,ledger);if(session)break;
            }catch{/* Unknown, malformed, foreign and old signatures remain unqualified. */}
            if(!session)throw new DomainError('CUSTOM_ROLE_QUALIFICATION_REQUIRED',409);
            if([...sessions.values()].includes(session))throw new DomainError('CUSTOM_ROLE_SESSIONS_REUSED',409);
            sessions.set(actor.roleId,session);
        }
    }
    async run(role:Role,signal:AbortSignal):Promise<ProbeReceipt>{
        if(!roles.includes(role))throw new DomainError('NATIVE_PROBE_ROLE_INVALID',400);
        if(signal.aborted)throw new DomainError('RUN_CANCELLED',409);
        if(this.#busy)throw new DomainError('NATIVE_PROBE_BUSY',409);
        const binding=this.binding();
        if(!probeRoles(binding.profile).includes(role))throw new DomainError('NATIVE_ROLE_NOT_IN_PRODUCT',409);
        const existing=this.cached(role);if(existing)return existing;
        this.#busy=true;const controller=new AbortController();this.#controller=controller;
        const combined=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(120000)]),nonce='DM_PROBE_'+randomUUID().replaceAll('-','');
        const attempt=this.options.store.record('NativeProbeAttempt',null,null,{role,nonce,bindingHash:hash(binding),status:'STARTED'});
        try{
            this.#pending=Promise.resolve().then(()=>this.options.invoke(role,nonce,combined));
            const observation=await this.#pending;
            if(combined.aborted||this.#closed)throw new DomainError('RUN_CANCELLED',409);
            if(hash(this.binding())!==hash(binding))throw new DomainError('NATIVE_PROBE_BINDING_CHANGED',409);
            this.observation(observation,role,binding,nonce);
            const payload:Payload={schema:'dream-maker.minimum-role-probe.v1',binding,role,nonce,at:new Date().toISOString(),observation};
            const envelope={payload,signature:this.sign(payload)};
            if(hasSecret(JSON.stringify(envelope)))throw new DomainError('NATIVE_PROBE_SECRET_DENIED',409);
            const evidenceId=this.options.store.record('NativeProbeReceipt',null,null,envelope);
            this.options.store.record('NativeProbeAttemptResult',null,null,{attempt,status:'VERIFIED_RESPONSE',evidenceId});
            return{evidenceId,model:observation.model,source:'REAL_MODEL_RESPONSE'};
        }catch(error){
            if(cleanupUncertain(error))this.#cleanupUncertain=true;
            this.options.store.record('NativeProbeAttemptResult',null,null,{attempt,status:'FAILED',code:error instanceof DomainError?error.code:'NATIVE_PROBE_FAILED'});
            throw error;
        }finally{this.#busy=false;this.#pending=undefined;if(this.#controller===controller)this.#controller=undefined;}
    }
    async advance(budget:Pick<NativeBudget,'advance'>){
        if(this.#busy)throw new DomainError('NATIVE_PROBE_BUSY',409);
        const refs:Partial<Record<Role,ProbeReceipt>>={};
        for(const role of probeRoles(this.binding().profile))refs[role]=this.required(role);
        const planner=this.read(refs.planner2!).observation,reviewer=this.read(refs.reviewer!).observation;
        if(planner.model!==reviewer.model||planner.accountFingerprint!==reviewer.accountFingerprint)throw new DomainError('NATIVE_PROBE_CODEX_ACCOUNT_OR_MODEL_CHANGED',409);
        if(planner.sessionId===reviewer.sessionId)throw new DomainError('NATIVE_PROBE_CODEX_SESSIONS_REUSED',409);
        budget.advance(refs);
    }
    close():Promise<void>{
        if(this.#closing)return this.#closing;this.#closed=true;this.#controller?.abort();
        this.#closing=(async()=>{
            try{
                try{await this.#pending;}catch(error){if(cleanupUncertain(error))this.#cleanupUncertain=true;}
                if(this.#cleanupUncertain)throw new DomainError('NATIVE_PROBE_CLEANUP_UNCERTAIN',409,'原生探针的清理未获证；没有宣告安全停止或恢复。');
            }finally{this.#key.fill(0);}
        })();return this.#closing;
    }
}
