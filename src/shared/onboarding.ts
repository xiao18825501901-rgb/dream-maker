import type {Role} from './types.js';
import type {Product} from './product.js';
export type SetupState='NOT_REQUIRED'|'UNKNOWN'|'MISSING'|'CONFIGURED_UNVERIFIED'|'EVIDENCE_AVAILABLE'|'BLOCKED';
export interface SetupGate {state:SetupState;message:string}
export interface SetupRole {
    role:Role;displayName:string;title:string;required:boolean;provider:string;runner:string;targetModel:string|null;actualModel:string|null;
    installation:SetupGate;authentication:SetupGate;quota:SetupGate;inference:SetupGate;
    evidence:{id:string;at:string}|null;
}
export interface SpendingHistory {
    status:'HISTORY_ONLY'|'UNAVAILABLE';mode:'CAPPED'|'UNCAPPED'|null;requests:number|null;maxRequests:number|null;
    byCurrency:Partial<Record<'CNY'|'USD',{committedMicros:number|null;reservedMicros:number|null}>>;
}
/** null means explicitly uncapped for this currency; zero still disables it. */
export interface UserBudgetLimits {CNY:number|null;USD:number|null}
export interface UserCurrencyUse {committedMicros:number;reservedMicros:number;remainingMicros:number|null;exceeded:boolean}
export interface UserBudgetSnapshot {configured:boolean;unlimited:boolean;revision:number;operationRevision?:number;limits:UserBudgetLimits;baselineRequests:number;startedAt:string|null;basis:'FUTURE_REQUESTS_SINCE_EXPLICIT_ACTIVATION';byCurrency:Record<'CNY'|'USD',UserCurrencyUse>}
export interface SetupSnapshot {
    schema:'dream-maker.setup.v1';product:Product;requiredRoles:Role[];roles:SetupRole[];
    optionalLaya:{required:false;availableToChoose:true;configuredMode:string;actualService:'NOT_CHECKED'};
    safety:SetupGate;
    fees:{ordinaryUserDefault:{configured:boolean;unlimited:false;automaticRecharge:false;extraUsage:false};existingScope:SpendingHistory;userBudget?:UserBudgetSnapshot;userBudgetAvailable:boolean;note:string};
    automaticActions:false;modelCalls:0;fullFlowAcceptance:'NOT_RUN';
}
