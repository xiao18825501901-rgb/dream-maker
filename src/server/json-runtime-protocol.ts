import {DomainError,object,hash} from './security.js';
import {validateSandboxCommand} from './wsl-sandbox.js';
import {checkedJsonDocument} from './json-data.js';
import type {JsonDataView,JsonData} from '../shared/json-data.js';
export interface JsonRuntimePlan {schema:'dream-maker.json-runtime-plan.v1';protocol:'JSON_DOCUMENT_V1';runtime:'node'|'python';entry:string;args:string[]}
export interface JsonRuntimeBinding {projectId:string;runId:string;specHash:string;sourceHash:string}
export interface JsonRuntimeExpected {inputHash:string;revision:number}
function fail(code='JSON_DATA_RUNTIME_PROTOCOL_INVALID',status=409):never{throw new DomainError(code,status);}
export function validateJsonRuntimePlan(raw:unknown):JsonRuntimePlan{
 const value=object(raw);if(Object.keys(value).some(key=>!['schema','protocol','runtime','entry','args'].includes(key))||value.schema!=='dream-maker.json-runtime-plan.v1'||value.protocol!=='JSON_DOCUMENT_V1')fail();
 const command=validateSandboxCommand({runtime:value.runtime,entry:value.entry,args:value.args,stdin:''});return {schema:'dream-maker.json-runtime-plan.v1',protocol:'JSON_DOCUMENT_V1',runtime:command.runtime,entry:command.entry,args:command.args};
}
/** The read is captured once. No later read may silently rebase this input before CAS. */
export function prepareJsonRuntimeInput(binding:JsonRuntimeBinding,data:JsonDataView):{stdin:string;expected:JsonRuntimeExpected}{
 if(!binding||typeof binding.projectId!=='string'||typeof binding.runId!=='string'||![binding.specHash,binding.sourceHash].every(value=>/^[a-f0-9]{64}$/.test(value))||data.schema!=='dream-maker.json-data.v1'||data.kind!=='JSON_DOCUMENT_V1'||data.projectId!==binding.projectId||!Number.isSafeInteger(data.revision)||data.revision<0)fail();
 const document=checkedJsonDocument(data.document),dataHash=hash(document);if(data.revision>0&&dataHash!==data.dataHash||data.revision===0&&data.dataHash!==null)fail();
 const content={schema:'dream-maker.json-runtime-input.v1',...binding,revision:data.revision,dataHash,document},inputHash=hash(content),stdin=JSON.stringify({...content,inputHash})+'\n';
 // Preserve the sandbox's existing input boundary; never truncate a user's document.
 if(Buffer.byteLength(stdin)>65536)fail('JSON_DATA_RUNTIME_INPUT_LIMIT',413);return {stdin,expected:{inputHash,revision:data.revision}};
}
export function readJsonRuntimeOutput(stdout:string,expected:JsonRuntimeExpected):Record<string,JsonData>{
 if(typeof stdout!=='string'||Buffer.byteLength(stdout)>101024)fail('JSON_DATA_RUNTIME_OUTPUT_LIMIT',413);let raw:unknown;
 try{raw=JSON.parse(stdout);}catch{fail('JSON_DATA_RUNTIME_OUTPUT_INVALID',502);}
 const value=object(raw);if(Object.keys(value).some(key=>!['schema','inputHash','expectedRevision','document'].includes(key))||value.schema!=='dream-maker.json-runtime-output.v1'||value.inputHash!==expected.inputHash||value.expectedRevision!==expected.revision)fail('JSON_DATA_RUNTIME_OUTPUT_INVALID',502);
 return checkedJsonDocument(value.document);
}
