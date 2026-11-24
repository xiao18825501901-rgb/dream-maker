import {readFileSync,readdirSync} from 'node:fs';import {join} from 'node:path';
import type {Config} from '../../shared/types.js';import type {InterruptedReviewInput,InterruptedReviewObservation} from '../review-interruption.js';
import {DomainError,hash,within,childEnv,object} from '../security.js';
import {RpcPeer} from './rpc.js';import {codexLaunch,codexEnv,createWindowsCodexContext,windowsCodexContextArguments,windowsCodexResumeRequest,windowsCodexSupervisorConfig} from './codex-transport.js';
const fail=():never=>{throw new DomainError('REVIEW_INTERRUPTION_HISTORY_UNVERIFIED',409);};
/** Select by the original controller's launch hash, never a caller-supplied path. */
export function originalReviewContext(root:string,config:Config,input:InterruptedReviewInput){
 if(config.codex.transport!=='stdio'||config.codex.model!==input.model||hash(config.codex.command)!==input.commandHash||
  config.codex.permissionProfile!=='dream-maker-supervisor-data'||hash(readFileSync(config.codex.policyFile!))!==input.policyHash)return fail();
 const parent=within(root,'.runtime/windows-codex'),entries=readdirSync(parent,{withFileTypes:true});if(entries.length>2048)return fail();
 const matches=entries.filter(e=>e.isDirectory()&&/^reviewer-[A-Za-z0-9_-]+$/.test(e.name)).flatMap(e=>{
  const directory=within(parent,e.name),path=within(directory,'context.json');let meta;try{meta=object(JSON.parse(readFileSync(path,'utf8')));}catch{return [];}
  if(meta.schema!=='dream-maker.windows-codex-context.v1'||meta.role!=='reviewer'||meta.homeHash!==hash(config.codex.home)||meta.cwd!==join(directory,'packet'))return [];
  const launch=codexLaunch(config,String(meta.cwd));return hash([...launch.args,...windowsCodexContextArguments(directory)])===input.argvHash?[directory]:[];
 });
 if(matches.length!==1)return fail();return matches[0];
}
function transcript(home:string,input:InterruptedReviewInput,cwd:string){
 if(!/^[A-Za-z0-9_-]{1,200}$/.test(input.threadId))return fail();
 const base=within(home,'sessions'),matches:string[]=[];let nodes=0;
 const dirs=(path:string,pattern:RegExp)=>readdirSync(path,{withFileTypes:true}).filter(e=>{if(++nodes>10000)return fail();return e.isDirectory()&&pattern.test(e.name);});
 for(const y of dirs(base,/^\d{4}$/))for(const m of dirs(within(base,y.name),/^\d{2}$/))for(const d of dirs(within(base,y.name+'/'+m.name),/^\d{2}$/)){
  const day=within(base,y.name+'/'+m.name+'/'+d.name);for(const f of readdirSync(day,{withFileTypes:true})){if(++nodes>10000)return fail();if(f.isFile()&&f.name.startsWith('rollout-')&&f.name.endsWith('-'+input.threadId+'.jsonl'))matches.push(within(day,f.name));}
 }
 if(matches.length!==1)return fail();const path=matches[0],bytes=readFileSync(path);if(bytes.length>16000000)return fail();
 return {path,sha256:hash(bytes),...validateInterruptedTranscript(bytes,input,cwd)};
}
export function validateInterruptedTranscript(bytes:Buffer,input:Pick<InterruptedReviewInput,'threadId'|'model'|'inputHash'>,cwd:string){
 let rows;try{rows=bytes.toString('utf8').trim().split('\n').map(line=>object(JSON.parse(line)));}catch{return fail();}
 let turnId='',matched=0,contexts=0,metadata=0,envelopes=0,completedItems=0;
 for(const row of rows){const p=object(row.payload??{});
  if(row.type==='session_meta'){metadata++;if(metadata!==1||turnId||p.id!==input.threadId)return fail();}
  else if(row.type==='turn_context'){contexts++;if(contexts!==1||!turnId||p.turn_id!==turnId||p.cwd!==cwd||p.model!==input.model||p.approval_policy!=='never')return fail();}
  else if(row.type==='world_state')continue;
  else if(row.type==='response_item'){
   if(p.type!=='message'||!['user','developer'].includes(String(p.role))||!Array.isArray(p.content))return fail();
   if(p.role==='user'){
    if(p.content.length!==1)return fail();const c=object(p.content[0]);
    if(c.type!=='input_text'||typeof c.text!=='string')return fail();
    if(contexts===1){if(hash(c.text)!==input.inputHash||++matched!==1)return fail();}
    else if(!turnId||++envelopes!==1||!/^<environment_context>\n  <current_date>\d{4}-\d{2}-\d{2}<\/current_date>\n  <timezone>Asia\/Shanghai<\/timezone>\n<\/environment_context>$/.test(c.text))return fail();
   }else if(contexts||matched)return fail();
  }else if(row.type==='event_msg'){
   if(p.type==='task_started'){if(metadata!==1||turnId||typeof p.turn_id!=='string')return fail();turnId=p.turn_id;}
   else if(p.type==='item_completed'){
    const item=object(p.item??{});if(++completedItems!==1||matched!==1||p.thread_id!==input.threadId||p.turn_id!==turnId||item.type!=='UserMessage'||!Array.isArray(item.content)||item.content.length!==1)return fail();
    const content=object(item.content[0]);if(content.type!=='text'||typeof content.text!=='string'||hash(content.text)!==input.inputHash)return fail();
   }
   else if(!['task_aborted','turn_aborted'].includes(String(p.type)))return fail();
  }else return fail();
 }
 if(metadata!==1||!turnId||matched!==1||contexts!==1)return fail();return {turnId};
}
/** Original owned RPC process, exact old SQLite catalog, generated official read API.
 * This never resumes/creates a thread, turns on a tool, or dispatches a model. */
export async function inspectInterruptedCodexReview(root:string,config:Config,input:InterruptedReviewInput,signal:AbortSignal,
 environment:(extra:NodeJS.ProcessEnv)=>NodeJS.ProcessEnv=childEnv):Promise<InterruptedReviewObservation>{
 if(signal.aborted)throw new DomainError('RUN_CANCELLED',409);
 const original=originalReviewContext(root,config,input),log=transcript(config.codex.home,input,join(original,'packet')),context=createWindowsCodexContext(root,config.codex.home,'reviewer');
 const sqlite=within(original,'sqlite');context.environment.CODEX_SQLITE_HOME=sqlite;
 const launch=codexLaunch(config,context.cwd),peer=new RpcPeer(launch.command,[...launch.args,...context.args,'-c','sqlite_home='+JSON.stringify(sqlite)],
  {cwd:context.cwd,env:environment({...codexEnv(config),...context.environment}),windowsJobRoot:root},20000);
 const abort=()=>{void peer.close().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{
  if(signal.aborted)throw new DomainError('RUN_CANCELLED',409);
  await peer.request('initialize',{clientInfo:{name:'dream_maker_review_reconciliation',version:'0.1.0'},capabilities:{experimentalApi:true}});peer.notify('initialized',{});
  const page=await peer.request('thread/turns/list',{threadId:input.threadId,limit:16,sortDirection:'desc',itemsView:'notLoaded'});
  if(!Array.isArray(page.data)||page.data.length!==1||page.nextCursor!==null)return fail();const turn=object(page.data[0]);
  if(turn.id!==log.turnId||turn.status!=='interrupted'||turn.error!=null||hash(readFileSync(log.path))!==log.sha256||signal.aborted)return fail();
  const profile=config.codex.permissionProfile!;
  const resumed=await peer.request('thread/resume',windowsCodexResumeRequest({
   threadId:input.threadId,model:input.model,cwd:context.cwd,permissionProfile:profile,
   config:windowsCodexSupervisorConfig(profile),excludeTurns:false
  }));
  if(signal.aborted)return fail();
  const resumedThread=object(resumed.thread??{}),resumedTurns=resumedThread.turns,active=object(resumed.activePermissionProfile??{}),sandbox=object(resumed.sandbox??{});
  if(resumedThread.id!==input.threadId||resumed.model!==input.model||resumed.modelProvider!=='openai'||resumed.serviceTier!=='default'||
    resumed.approvalPolicy!=='never'||resumed.cwd!==context.cwd||active.id!==profile||active.extends!==null||
    sandbox.type!=='readOnly'||sandbox.networkAccess!==false||!Array.isArray(resumed.runtimeWorkspaceRoots)||resumed.runtimeWorkspaceRoots.length!==0||
    !Array.isArray(resumedTurns)||resumedTurns.length!==1||object(resumedTurns[0]).id!==log.turnId||object(resumedTurns[0]).status!=='interrupted')return fail();
  return {schema:'dream-maker.interrupted-review-observation.v1',threadId:input.threadId,turnId:log.turnId,status:'interrupted',inputHash:input.inputHash,
   contextHash:hash({original,argvHash:input.argvHash,homeHash:hash(config.codex.home)}),transcriptHash:log.sha256,userOnly:true,modelDispatchesByInspection:0,cleanupReturned:true};
 }finally{signal.removeEventListener('abort',abort);await peer.finish();if(signal.aborted)throw new DomainError('RUN_CANCELLED',409);}
}
