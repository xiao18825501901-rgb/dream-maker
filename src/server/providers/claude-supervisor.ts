import {mkdirSync,mkdtempSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {observeComponentFile} from '../release/local-component.js';
import {capture} from '../process.js';
import {childEnv,DomainError,object} from '../security.js';

export interface ClaudeCommandRef {path:string;sha256:string}
export function verifiedClaudeCommand(ref:ClaudeCommandRef|undefined):string {
 if(!ref||typeof ref.path!=='string'||!isAbsolute(ref.path)||!ref.path.toLowerCase().endsWith('.exe')||!/^[a-f0-9]{64}$/.test(ref.sha256))
  throw new DomainError('CUSTOM_CLAUDE_COMMAND_UNVERIFIED',409);
 const observed=observeComponentFile(ref.path,512*1024*1024);
 if(observed.status!=='HASHED'||observed.sha256!==ref.sha256)throw new DomainError('CUSTOM_CLAUDE_COMMAND_UNVERIFIED',409);
 return observed.path;
}

/** CLI observations only. NativeOwner must still match gateway receipts and issue
 * the role identity; neither a CLI model label nor its cost estimate qualifies it. */
export interface ClaudeSupervisorResult {
 text:string;sessionId:string;requestId:string;model:string;
 inputTokens:number|null;outputTokens:number|null;costUsd:null;
}
const fail=():never=>{throw new DomainError('CLAUDE_RESULT_UNVERIFIED',502);};
export function readClaudeSupervisorResult(raw:string,model:string):ClaudeSupervisorResult{
 try{
  if(typeof raw!=='string'||Buffer.byteLength(raw)>4194304)return fail();
  const v=object(JSON.parse(raw)),models=object(v.modelUsage),ids=Object.keys(models);
  const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
  if(v.type!=='result'||v.subtype!=='success'||v.is_error!==false||!uuid(v.session_id)||!uuid(v.uuid)||typeof v.result!=='string'||!v.result.trim()||ids.length!==1||ids[0]!==model||!Array.isArray(v.permission_denials)||v.permission_denials.length)return fail();
  const usage=object(models[model]),tokens=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
  return{text:v.result,sessionId:String(v.session_id),requestId:String(v.uuid),model:ids[0],inputTokens:tokens(usage.inputTokens),outputTokens:tokens(usage.outputTokens),costUsd:null};
 }catch{return fail();}
}
/** Planner/reviewer-only CLI process. Original capture owns cancellation, output
 * bounds and Windows Job cleanup. No tools, config discovery, retries or fallback. */
interface ClaudeSupervisorInput {
 command:string;controllerRoot:string;gatewayUrl:string;gatewayToken:string;
 model:string;role:'planner2'|'reviewer';prompt:string;signal:AbortSignal;timeoutMs:number;maxOutputTokens?:number;
}
export function validOfficialCliModelId(value: unknown): value is string {
 return typeof value==='string' && value.length>0 && value.length<=160 && /^[A-Za-z0-9]/.test(value) &&
  !/[^A-Za-z0-9_.:/-]/.test(value) && !value.split('/').some(part=>!part || part==='.' || part==='..');
}
export async function runClaudeSupervisor(input:ClaudeSupervisorInput):Promise<ClaudeSupervisorResult>{
 if(!/^claude-[A-Za-z0-9_.-]+$/.test(input.model))throw new DomainError('CLAUDE_SUPERVISOR_INPUT_INVALID',409);
 return launchClaudeSupervisor(input);
}
/** The Custom adapter supplies the controller-selected model verbatim. */
export async function launchClaudeSupervisor(input:ClaudeSupervisorInput):Promise<ClaudeSupervisorResult>{
 const deny=():never=>{throw new DomainError('CLAUDE_SUPERVISOR_INPUT_INVALID',409);};
 let endpoint:URL;try{endpoint=new URL(input.gatewayUrl);}catch{return deny();}
 if(!isAbsolute(input.command)||!isAbsolute(input.controllerRoot)||!['planner2','reviewer'].includes(input.role)||!validOfficialCliModelId(input.model)||
  endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/'||
  typeof input.gatewayToken!=='string'||!/^[\x21-\x7e]{8,512}$/.test(input.gatewayToken)||typeof input.prompt!=='string'||!input.prompt||Buffer.byteLength(input.prompt)>4194304||
  !Number.isSafeInteger(input.timeoutMs)||input.timeoutMs<1||input.timeoutMs>900000)return deny();
 const maxOutputTokens=input.maxOutputTokens??8192;
 if(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<128||maxOutputTokens>16000)return deny();
 if(input.signal.aborted)throw new DomainError('RUN_CANCELLED',409);
 const base=join(input.controllerRoot,'.runtime','claude-supervisor');mkdirSync(base,{recursive:true});
 const home=mkdtempSync(join(base,input.role+'-'));
 for(const part of ['config','tmp','appdata','localappdata'])mkdirSync(join(home,part));
 const env=childEnv({HOME:home,USERPROFILE:home,APPDATA:join(home,'appdata'),LOCALAPPDATA:join(home,'localappdata'),CLAUDE_CONFIG_DIR:join(home,'config'),TEMP:join(home,'tmp'),TMP:join(home,'tmp'),
  CLAUDE_CODE_MAX_OUTPUT_TOKENS:String(maxOutputTokens),MAX_THINKING_TOKENS:'0',CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING:'1',
  ANTHROPIC_API_KEY:input.gatewayToken,ANTHROPIC_BASE_URL:endpoint.origin,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'});
 let cleaned=false;
 try{
  const output=await capture(input.command,['--bare','--print','--tools','','--permission-mode','dontAsk','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--settings','{}','--no-session-persistence','--disable-slash-commands','--output-format','json','--model',input.model],{
   cwd:home,env,windowsJobRoot:input.controllerRoot,signal:input.signal,timeoutMs:input.timeoutMs,maxBytes:4194304,input:input.prompt,maxInputBytes:4194304,onCleanup:()=>{cleaned=true;}});
  if(input.signal.aborted)throw new DomainError('RUN_CANCELLED',409);
  if(!cleaned)throw new DomainError('PROCESS_CLEANUP_UNPROVEN',500);
  if(output.code!==0)throw new DomainError('CLAUDE_EXIT_NONZERO',502);
  return readClaudeSupervisorResult(output.stdout,input.model);
 }finally{env.ANTHROPIC_API_KEY='';}
}
