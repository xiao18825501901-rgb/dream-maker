import type {DatabaseSync} from 'node:sqlite';
import type {RequestRecord,NativePrice} from './native-budget.js';
import {DomainError,hash,hasSecret} from './security.js';
import type {UserBudgetLimits,UserBudgetSnapshot} from '../shared/onboarding.js';
export type {UserBudgetLimits} from '../shared/onboarding.js';
interface Policy {revision:number;parentHash:string|null;scopeHash:string;actor:string;at:string;limits:UserBudgetLimits;baselineRequests:number;baselineHash:string;operation:string;operationHash:string}
export type UserBudgetStatus=UserBudgetSnapshot;
function fail(code:string):never{throw new DomainError(code,409);}
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
export function userBudgetTablePresent(db:DatabaseSync):boolean{return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_budget_limits'").get();}
function validLimits(value:unknown):value is UserBudgetLimits {
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    const v=value as Record<string,unknown>;
    return Object.keys(v).length===2&&['CNY','USD'].every(c=>v[c]===null||integer(v[c])&&(v[c] as number)<=1000000000000);
}
const baseline=(requests:RequestRecord[],count:number)=>hash(requests.slice(0,count).map(r=>({id:r.id,role:r.role,createdAt:r.createdAt,price:r.price,reservedMicros:r.reservedMicros})));
function read(db:DatabaseSync,scopeHash:string):{value:Policy;hash:string}[] {
    if(!userBudgetTablePresent(db))return [];
    const rows=db.prepare('SELECT revision,data,sha256 FROM user_budget_limits ORDER BY revision').all();
    if(!rows.length)fail('USER_BUDGET_STATE_INVALID');
    const result:{value:Policy;hash:string}[]=[];
    for(const row of rows){
        let value:Policy;try{value=JSON.parse(String(row.data)) as Policy;}catch{fail('USER_BUDGET_STATE_INVALID');}
        const previous=result.at(-1),first=result[0]?.value;
        if(!value||typeof value!=='object'||Array.isArray(value)||hash(value)!==row.sha256||value.revision!==row.revision||value.revision!==result.length+1||value.parentHash!==(previous?.hash??null)||value.scopeHash!==scopeHash||!validLimits(value.limits)||!integer(value.baselineRequests)||
            !/^[a-f0-9]{64}$/.test(value.baselineHash)||!Number.isFinite(Date.parse(value.at))||
            !/^local-session:[a-f0-9]{64}$/.test(value.actor)||!/^[A-Za-z0-9_:.-]{1,160}$/.test(value.operation)||value.operationHash!==hash({limits:value.limits,expectedRevision:value.revision-1,actor:value.actor})||result.some(r=>r.value.operation===value.operation)||
            first&&(value.baselineRequests!==first.baselineRequests||value.baselineHash!==first.baselineHash))fail('USER_BUDGET_STATE_INVALID');
        result.push({value,hash:String(row.sha256)});
    }
    return result;
}
export function userBudgetStatus(db:DatabaseSync,requests:RequestRecord[],scopeId:string):UserBudgetStatus {
    const rows=read(db,hash(scopeId)),policy=rows.at(-1)?.value;
    if(policy&&(requests.length<policy.baselineRequests||baseline(requests,policy.baselineRequests)!==policy.baselineHash))fail('USER_BUDGET_HISTORY_MISMATCH');
    const limits=policy?.limits??{CNY:0,USD:0},byCurrency={} as UserBudgetStatus['byCurrency'];
    for(const currency of ['CNY','USD'] as const){
        const list=policy?requests.slice(policy.baselineRequests).filter(r=>r.price.currency===currency):[];
        const committedMicros=list.filter(r=>r.usageStatus!=='PENDING').reduce((n,r)=>n+(r.chargedMicros??r.reservedMicros),0);
        const reservedMicros=list.filter(r=>r.usageStatus==='PENDING').reduce((n,r)=>n+r.reservedMicros,0);
        if(!integer(committedMicros)||!integer(reservedMicros)||!Number.isSafeInteger(committedMicros+reservedMicros))fail('USER_BUDGET_HISTORY_MISMATCH');
        const limit=limits[currency];
        byCurrency[currency]={committedMicros,reservedMicros,remainingMicros:limit===null?null:Math.max(0,limit-committedMicros-reservedMicros),exceeded:limit!==null&&committedMicros+reservedMicros>limit};
    }
    return {configured:!!policy,unlimited:limits.CNY===null||limits.USD===null,revision:policy?.revision??0,limits:{...limits},baselineRequests:policy?.baselineRequests??0,startedAt:rows[0]?.value.at??null,basis:'FUTURE_REQUESTS_SINCE_EXPLICIT_ACTIVATION',byCurrency};
}
export function assertUserBudget(db:DatabaseSync,requests:RequestRecord[],scopeId:string,price:Pick<NativePrice,'currency'>,reservation:number):void {
    const current=userBudgetStatus(db,requests,scopeId);if(!current.configured)return;
    if(current.limits[price.currency]===0)fail('USER_BUDGET_CURRENCY_DISABLED');
    const remaining=current.byCurrency[price.currency].remainingMicros;
    if(remaining!==null&&remaining<reservation)fail('USER_BUDGET_LIMIT');
}
function checkChange(db:DatabaseSync,requests:RequestRecord[],scopeId:string,limits:UserBudgetLimits,expectedRevision:number,actor:string,operation:string){
    if(!validLimits(limits)||!integer(expectedRevision)||!/^local-session:[a-f0-9]{64}$/.test(actor)||hasSecret(actor)||typeof operation!=='string'||!/^[A-Za-z0-9_:.-]{1,160}$/.test(operation)||hasSecret(operation))fail('USER_BUDGET_INVALID');
    const scopeHash=hash(scopeId),rows=read(db,scopeHash),prior=rows.at(-1),operationHash=hash({limits,expectedRevision,actor});
    const replay=rows.find(row=>row.value.operation===operation);
    if(replay){if(replay.value.operationHash!==operationHash)fail('IDEMPOTENCY_CONFLICT');userBudgetStatus(db,requests,scopeId);return {scopeHash,prior,operationHash,replay};}
    if((prior?.value.revision??0)!==expectedRevision)fail('USER_BUDGET_REVISION_CONFLICT');
    if(requests.some(r=>r.usageStatus==='PENDING'))fail('NATIVE_REQUEST_ALREADY_IN_FLIGHT');
    // Check existing history before changing only the ceiling. A new revision never moves the baseline.
    if(prior)userBudgetStatus(db,requests,scopeId);
    return {scopeHash,prior,operationHash,replay};
}
export function assertUserBudgetChange(db:DatabaseSync,requests:RequestRecord[],scopeId:string,limits:UserBudgetLimits,expectedRevision:number,actor:string,operation:string):void{checkChange(db,requests,scopeId,limits,expectedRevision,actor,operation);}
/** Must run inside the original NativeBudget reservation database transaction. */
export function configureUserBudget(db:DatabaseSync,requests:RequestRecord[],scopeId:string,limits:UserBudgetLimits,expectedRevision:number,actor:string,operation:string):UserBudgetStatus {
    const {scopeHash,prior,operationHash,replay}=checkChange(db,requests,scopeId,limits,expectedRevision,actor,operation);
    if(replay)return {...userBudgetStatus(db,requests,scopeId),operationRevision:replay.value.revision};
    if(!prior)db.exec(`CREATE TABLE user_budget_limits(revision INTEGER PRIMARY KEY,data TEXT NOT NULL,sha256 TEXT NOT NULL);
        CREATE TRIGGER immutable_user_budget_update BEFORE UPDATE ON user_budget_limits BEGIN SELECT RAISE(ABORT,'IMMUTABLE_USER_BUDGET'); END;
        CREATE TRIGGER immutable_user_budget_delete BEFORE DELETE ON user_budget_limits BEGIN SELECT RAISE(ABORT,'IMMUTABLE_USER_BUDGET'); END;`);
    const count=prior?.value.baselineRequests??requests.length;
    const value:Policy={revision:expectedRevision+1,parentHash:prior?.hash??null,scopeHash,actor,at:new Date().toISOString(),limits:{...limits},baselineRequests:count,baselineHash:prior?.value.baselineHash??baseline(requests,count),operation,operationHash};
    db.prepare('INSERT INTO user_budget_limits VALUES(?,?,?)').run(value.revision,JSON.stringify(value),hash(value));
    return {...userBudgetStatus(db,requests,scopeId),operationRevision:value.revision};
}
