import {DomainError,hasSecret,object} from './security.js';

/** Nonsecret write-ahead metadata in the original budget request, never a new permit. */
export interface MagpieGrantIntentInput {
 schema:'dream-maker.magpie-grant-intent.v1';
 admissionId:string;epoch:string;binaryHash:string;controlHash:string;expiresAtMs:number;
}
export interface MagpieGrantIntent extends MagpieGrantIntentInput {
 status:'INTENT'|'ACKNOWLEDGED'|'DENIED'|'UNKNOWN';createdAt:string;decidedAt:string|null;
}
export interface MagpieAdmissionAcknowledgement {
 type:'admission';schema:'dream-maker.magpie-admission-ack.v2';
 epoch:string;id:string;reservationId:string;controlHash:string;accepted:boolean;
}
const exact=(value:Record<string,unknown>,keys:string[])=>Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const ref=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function magpieGrantIntent(raw:unknown,priceExpiresAt:string):MagpieGrantIntentInput {
 const fail=():never=>{throw new DomainError('NATIVE_ROUTER_INTENT_INVALID',409);};
 let value:Record<string,unknown>;try{value=object(raw);}catch{return fail();}
 const now=Date.now(),expiry=Number(value.expiresAtMs);
 if(!exact(value,['schema','admissionId','epoch','binaryHash','controlHash','expiresAtMs'])||value.schema!=='dream-maker.magpie-grant-intent.v1'||!ref(value.admissionId)||!ref(value.epoch)||!digest(value.binaryHash)||!digest(value.controlHash)||typeof value.expiresAtMs!=='number'||!Number.isSafeInteger(expiry)||expiry<=now||expiry-now>120000||!Number.isFinite(Date.parse(priceExpiresAt))||expiry>Date.parse(priceExpiresAt)||hasSecret(JSON.stringify(value)))return fail();
 return structuredClone(value) as unknown as MagpieGrantIntentInput;
}
export function magpieAcknowledgement(raw:unknown,intent:MagpieGrantIntent,reservationId:string):MagpieAdmissionAcknowledgement {
 const fail=():never=>{throw new DomainError('NATIVE_ROUTER_ACK_MISMATCH',409);};
 let value:Record<string,unknown>;try{value=object(raw);}catch{return fail();}
 if(!exact(value,['type','schema','epoch','id','reservationId','controlHash','accepted'])||value.type!=='admission'||value.schema!=='dream-maker.magpie-admission-ack.v2'||value.epoch!==intent.epoch||value.id!==intent.admissionId||value.reservationId!==reservationId||value.controlHash!==intent.controlHash||typeof value.accepted!=='boolean')return fail();
 return structuredClone(value) as unknown as MagpieAdmissionAcknowledgement;
}
