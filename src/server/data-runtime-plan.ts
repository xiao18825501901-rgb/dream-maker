import {DomainError,object} from './security.js';
import {validateJsonRuntimePlan,type JsonRuntimePlan} from './json-runtime-protocol.js';
import {validateSandboxCommand,type SandboxCommand} from './wsl-sandbox.js';
import type {SqliteChannelBinding} from './sqlite-channel.js';

export interface SqliteRuntimePlan {
 schema:'dream-maker.sqlite-runtime-plan.v1';protocol:'SQLITE_IMAGE_V1';
 runtime:'node'|'python';entry:string;args:string[];
}
export type DataRuntimePlan=JsonRuntimePlan|SqliteRuntimePlan;

/** A plan is untrusted model output, never authority to execute or select a host path. */
export function validateSqliteRuntimePlan(raw:unknown):SqliteRuntimePlan{
 try{
  const v=object(raw);
  if(Object.keys(v).some(k=>!['schema','protocol','runtime','entry','args'].includes(k))||v.schema!=='dream-maker.sqlite-runtime-plan.v1'||v.protocol!=='SQLITE_IMAGE_V1')throw new Error('shape');
  const command=validateSandboxCommand({runtime:v.runtime,entry:v.entry,args:v.args,stdin:''});
  if(command.entry!==v.entry)throw new Error('noncanonical-entry');
  return {schema:'dream-maker.sqlite-runtime-plan.v1',protocol:'SQLITE_IMAGE_V1',runtime:command.runtime,entry:command.entry,args:[...command.args]};
 }catch{throw new DomainError('PLAN_SQLITE_RUNTIME_INVALID',502);}
}
export function validateDataRuntimePlan(raw:unknown):DataRuntimePlan{
 const v=object(raw);
 return v.protocol==='SQLITE_IMAGE_V1'||v.schema==='dream-maker.sqlite-runtime-plan.v1'
  ?validateSqliteRuntimePlan(v):validateJsonRuntimePlan(v);
}
/** Metadata only; the image belongs to the existing worker's separate binary channel. */
export function prepareSqliteRuntimeCommand(raw:unknown,binding:SqliteChannelBinding):SandboxCommand{
 const plan=validateSqliteRuntimePlan(raw),v=object(binding);
 if(Object.keys(v).some(k=>!['inputHash','expectedRevision'].includes(k))||typeof v.inputHash!=='string'||!/^[a-f0-9]{64}$/.test(v.inputHash)||!Number.isSafeInteger(v.expectedRevision)||Number(v.expectedRevision)<0)throw new DomainError('SQLITE_RUNTIME_BINDING_INVALID',409);
 const stdin=JSON.stringify({schema:'dream-maker.sqlite-program-input.v1',protocol:'SQLITE_IMAGE_V1',inputHash:v.inputHash,expectedRevision:v.expectedRevision,database:'/data/project.sqlite'})+'\n';
 return validateSandboxCommand({runtime:plan.runtime,entry:plan.entry,args:plan.args,stdin});
}
