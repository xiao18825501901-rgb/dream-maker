import { randomUUID } from 'node:crypto';
import { SiwcAccountService } from './account-service.js';
import { DomainError, object, redact, hasSecret } from '../security.js';
import type { Completion } from '../providers/model.js';

/** Reuses the same planner1 JSON contract. `streamResponse` returns only after response.completed. */
export class SiwcPlanner1Provider {
 constructor(private accounts:SiwcAccountService){}
 async complete(payload:unknown,instructions:string,signal?:AbortSignal,onDelta?:(x:string)=>void):Promise<Completion>{
  const content=JSON.stringify(payload);if(content.length>80000||hasSecret(content))throw new DomainError('SIWC_INPUT_UNSAFE',400);
  const timeout=AbortSignal.timeout(90000),abort=signal?AbortSignal.any([signal,timeout]):timeout;
  const res=await this.accounts.infer(content,instructions,abort,onDelta);
  let data:Record<string,unknown>;
  try{data=object(JSON.parse(redact(res.text)));}catch{throw new DomainError('SIWC_OUTPUT_NOT_JSON',502);}
  return {data,usage:{role:'planner1',inputTokens:null,outputTokens:null,costUsd:null,source:'UNKNOWN',requestId:'local-siwc-completed-'+randomUUID()}};
 }
}
