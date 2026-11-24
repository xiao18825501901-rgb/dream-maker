import type {Store} from './store.js';

/**
 * Probe-backed account verification.
 *
 * `accountVerified` answers exactly one question: did this account source complete at least one
 * METERED and RECEIPTED real model call? Nothing else is implied.
 *
 * Evidence is a signed receipt in the original Store whose observation names the ledger request
 * that paid for the call, and that ledger request must have settled with `usageStatus='KNOWN'`,
 * `outcome='COMPLETE'` and a measured `chargedMicros` for the same provider and model.
 * `source:'REAL_MODEL_RESPONSE'` is the literal both receipt producers attach to exactly these
 * envelopes, so a signed envelope is the only shape that can qualify. A configured credential, a
 * started-but-unproven probe, an `UNKNOWN` (reserved or abandoned) row, or a subscription leg that
 * never wrote a ledger row is not evidence and leaves the account unverified.
 *
 * It never means:
 * - that the credential is still valid, funded or permanent: a later expiry, revocation or key
 *   rotation does not rewrite that the call happened, and it does not keep the account usable;
 * - that the model is qualified (`modelVerified`) or that Custom execution is granted
 *   (`customExecutionGranted`). Both stay closed and are decided by their own domains.
 */

/** Structural subset of one settled NativeBudget request row. The ledger file stays authoritative. */
export interface MeteredLedgerRow {
    id:string;role:string;usageStatus:string;outcome:string|null;chargedMicros:number|null;
    price?:{provider?:unknown;model?:unknown};
    customProbe?:{probeId?:unknown};
}
/** One account source identity exactly as the account views publish it (nonsecret references). */
export interface AccountIdentity {authRef:string;accountRef:string;provider:string;authentication:string}
/** One qualifying receipt, kept only as nonsecret identity metadata for audit. */
export interface AccountProbeEvidence {
    evidenceId:string;domain:'PROBE'|'CUSTOM_PROBE';probeId:string;
    role:string;roleId:string|null;provider:string;model:string;authentication:string;
    authRef:string|null;accountRef:string|null;
    ledgerRequestId:string;chargedMicros:number;
}
export interface AccountProbeAuthority {
    /** True only for the exact account source that owns at least one qualifying receipt. */
    verified(account:AccountIdentity):boolean;
    /** Every API-key account source in the list is verified; an empty list is never verified. */
    verifiedEveryMetered(accounts:readonly AccountIdentity[]):boolean;
}
/** Mocks, offline fixtures and every caller without ledger access keep the historical refusal. */
export const NO_ACCOUNT_PROBE_AUTHORITY:AccountProbeAuthority=Object.freeze({verified:()=>false,verifiedEveryMetered:()=>false});

const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200;
const object=(v:unknown):Record<string,unknown>|undefined=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
/** Bounded read of the newest receipts: an older one outside the window is a false negative, never a promotion. */
const RECEIPT_LIMIT=1024;
const RECEIPT_KINDS="('NativeProbeReceipt','NativeCustomProbeReceipt')";

function receipt(row:{id:unknown;data:unknown},ledger:Map<string,MeteredLedgerRow>):AccountProbeEvidence|undefined {
    try{
        if(typeof row.data!=='string'||Buffer.byteLength(row.data)>64000)return;
        const envelope=object(JSON.parse(row.data));
        // A receipt belongs to the REAL_MODEL_RESPONSE domain only as a signed envelope; an unsigned
        // or hand-written row is not evidence of any model call.
        if(!envelope||!digest(envelope.signature))return;
        const payload=object(envelope.payload),observation=object(payload?.observation);
        if(!payload||!observation)return;
        const custom=payload.schema==='dream-maker.custom-minimum-role-probe.v1';
        if(!custom&&payload.schema!=='dream-maker.minimum-role-probe.v1')return;
        const role=observation.role,provider=observation.provider,model=observation.model,authentication=observation.authentication;
        if(!text(role)||!text(provider)||!text(model)||!text(authentication))return;
        const ids=observation.ledgerRequestIds;
        // Subscription and membership legs are counted in account generations, not ledger rows, so
        // they can never prove a metered call.
        if(!Array.isArray(ids)||ids.length<1||ids.length>4)return;
        const probeId=custom?payload.probeId:payload.nonce;
        for(const id of ids){
            if(!text(id))continue;
            const request=ledger.get(id);
            if(!request||request.usageStatus!=='KNOWN'||request.outcome!=='COMPLETE')continue;
            const charged=request.chargedMicros;
            if(!Number.isSafeInteger(charged)||Number(charged)<0)continue;
            const price=request.price??{};
            if(text(price.provider)&&price.provider!==provider)continue;
            if(text(price.model)&&price.model!==model)continue;
            // A Custom receipt names one scoped probe; another probe's settled row is not this proof.
            if(custom&&request.customProbe?.probeId!==payload.probeId)continue;
            return{evidenceId:String(row.id),domain:custom?'CUSTOM_PROBE':'PROBE',probeId:text(probeId)?probeId:'',
                role,roleId:custom&&text(observation.roleId)?observation.roleId:null,provider,model,authentication,
                authRef:custom&&text(observation.authRef)?observation.authRef:null,
                accountRef:custom&&text(observation.accountRef)?observation.accountRef:null,
                ledgerRequestId:id,chargedMicros:Number(charged)};
        }
        return;
    }catch{return;}
}

/** Read-only scan of the two receipt domains joined to settled ledger rows. Never writes. */
export function accountProbeEvidence(store:Store,ledger:readonly MeteredLedgerRow[]):AccountProbeEvidence[] {
    let rows:{id:unknown;data:unknown}[];
    try{
        rows=store.db.prepare(`SELECT id,data FROM records WHERE kind IN ${RECEIPT_KINDS} AND project_id IS NULL AND run_id IS NULL ORDER BY rowid DESC LIMIT ${RECEIPT_LIMIT}`).all() as unknown as {id:unknown;data:unknown}[];
    }catch{return [];}
    const settled=new Map<string,MeteredLedgerRow>();
    for(const row of ledger)if(text(row?.id))settled.set(row.id,row);
    const out:AccountProbeEvidence[]=[];
    for(const row of rows){const found=receipt(row,settled);if(found)out.push(found);}
    return out;
}

/** Lazily cached evidence for one controller operation. */
export function createAccountProbeAuthority(store:Store,ledger:()=>readonly MeteredLedgerRow[]):AccountProbeAuthority {
    let cache:AccountProbeEvidence[]|undefined;
    const evidence=()=>{
        if(cache)return cache;
        let rows:readonly MeteredLedgerRow[]=[];
        try{rows=ledger()??[];}catch{/* An unreadable ledger is unknown evidence, never a promotion. */}
        return cache=Array.isArray(rows)?accountProbeEvidence(store,rows):[];
    };
    const verified=(account:AccountIdentity):boolean=>{
        if(!account||!text(account.authRef)||!text(account.accountRef)||!text(account.provider))return false;
        const rows=evidence();
        // A receipt that names the account marks only that account.
        if(rows.some(row=>row.authRef===account.authRef&&row.accountRef===account.accountRef))return true;
        // A reference-less paid probe receipt proves the controller-managed API-key credential of
        // its provider; it cannot be attributed to any other account's references.
        return account.authentication==='api_key'&&rows.some(row=>row.domain==='PROBE'&&row.authRef===null&&row.accountRef===null&&
            row.provider===account.provider&&row.authentication==='API_KEY');
    };
    return Object.freeze({verified,verifiedEveryMetered:(accounts:readonly AccountIdentity[])=>Array.isArray(accounts)&&
        accounts.filter(account=>account?.authentication==='api_key').length>0&&
        accounts.every(account=>account?.authentication!=='api_key'||verified(account))});
}
