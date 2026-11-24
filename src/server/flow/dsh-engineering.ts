import {mkdirSync,readFileSync,existsSync,lstatSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve,parse} from 'node:path';
import type {Role,AgentOutput} from '../../shared/types.js';
import type {FileBinding} from '../executor-tools.js';
import {createBoundedFileTools,editUniqueText} from '../executor-tools.js';
import {DomainError,hash,hasSecret,id,object,text,within} from '../security.js';
import {files,treeHash} from '../workspace.js';
import {validateSandboxCommand,type SandboxCommand,type SandboxResult} from '../wsl-sandbox.js';

const contract={schema:'dream-maker.dsh-engineering-contract.v1',purpose:'DSH_EXECUTOR_COMPONENT_ONLY',
 files:['main.mjs','README.md'],maxTools:8,maxRequests:8,maxReservedMicros:20000000,maxSeconds:900,
 task:'制作无依赖的本地JSON记账汇总命令行工具。只创建main.mjs和中文README.md。工作区已由控制端确认最初为空：创建这两个新文件时，desk_write的expected_sha必须使用空字符串""，不要填NEW、null、空文件哈希或即将写入内容的哈希。desk_read对不存在的允许文件返回exists:false及sha256:""；修改已有文件才使用desk_read返回的真实sha256。请直接用两次desk_write写好这两个文件，避免无必要的搜索。node main.mjs从stdin读取JSON数组；每项category为未带首尾空格的1至80字字符串（不含控制字符），amount为绝对值不超过1000000000的整数分；数组最多1000项。按category精确分组，以JavaScript默认字符串顺序排序，stdout只输出JSON和换行：{"total":整数,"categories":[{"category":"类别","amount":整数}]}。空数组输出{"total":0,"categories":[]}。允许负数。无效JSON/结构/记录：exit2，stdout空，stderr为ERROR INVALID_INPUT加换行。只接受无参数或--help；--help打印Usage: node main.mjs < expenses.json加换行并exit0；其他参数exit2且stderr为ERROR INVALID_ARGS加换行。不能联网、安装依赖、读取文件/凭据或改变系统设置。你必须调用desk_write等真实工具写文件，可用desk_run验证；最多8次工具调用，优先一次写好完整main.mjs再写README.md。不要只在回答里贴代码。完成后简短说明。',
 cases:[
  {id:'empty',args:[],stdin:'[]',exitCode:0,stdout:'{"total":0,"categories":[]}\n',stderr:''},
  {id:'grouped-chinese',args:[],stdin:'[{"category":"餐饮","amount":1234},{"category":"交通","amount":250},{"category":"餐饮","amount":-234}]',exitCode:0,stdout:'{"total":1250,"categories":[{"category":"交通","amount":250},{"category":"餐饮","amount":1000}]}\n',stderr:''},
  {id:'invalid-json',args:[],stdin:'[broken',exitCode:2,stdout:'',stderr:'ERROR INVALID_INPUT\n'},
  {id:'invalid-record',args:[],stdin:'[{"category":"x","amount":0.5}]',exitCode:2,stdout:'',stderr:'ERROR INVALID_INPUT\n'},
  {id:'help',args:['--help'],stdin:'',exitCode:0,stdout:'Usage: node main.mjs < expenses.json\n',stderr:''},
  {id:'invalid-args',args:['--other'],stdin:'[]',exitCode:2,stdout:'',stderr:'ERROR INVALID_ARGS\n'}
 ]};
export const dshEngineeringContractHash=hash(contract);
export const dshEngineeringContract=()=>structuredClone(contract);
export interface DshEngineeringInput {acceptanceId:string;workspace:string;contractHash:string;configurationHash:string;signal:AbortSignal}
export interface DshEngineeringPreparation {contractHash:string;configurationHash:string}
export interface DshEngineeringStage {output:AgentOutput;sourceHash:string;ledgerRequestIds:string[];requests:unknown[]}
export interface DshEngineeringVerification {sourceHash:string;ok:boolean;cases:{id:string;ok:boolean;execution:SandboxResult}[]}
export interface DshEngineeringReport {schema:'dream-maker.dsh-engineering-result.v1';acceptanceId:string;purpose:'DSH_EXECUTOR_COMPONENT_ONLY';status:'VERIFIED_EXECUTOR_COMPONENT';
 contractHash:string;configurationHash:string;workspace:string;sourceHash:string;stage:DshEngineeringStage;verification:DshEngineeringVerification;fourRoleLive:'NOT_RUN';reviewer:'BLOCKED';}
interface JournalRow {id:string;kind:string;data:Record<string,unknown>}
type RecordJournal=(kind:string,data:Record<string,unknown>)=>string;
interface Kernel {run(workspace:string,command:SandboxCommand,options:{signal:AbortSignal}):Promise<unknown>}
const keys:Record<string,string[]>={desk_read:['path'],desk_search:['text'],desk_write:['path','content','expected_sha'],desk_edit:['path','old_text','new_text','expected_sha'],desk_run:['runtime','entry','args','stdin']};
function assertWorkspace(workspace:string){let at=parse(resolve(workspace)).root;for(const segment of resolve(workspace).slice(at.length).split(/[\\/]/).filter(Boolean)){at=join(at,segment);if(lstatSync(at).isSymbolicLink())throw new DomainError('ENGINEERING_WORKSPACE_REDIRECTED',409);}const catalog=files(workspace);if(catalog.some(f=>!contract.files.includes(f.path)||f.bytes>65536)||catalog.reduce((sum,f)=>sum+f.bytes,0)>131072)throw new DomainError('ENGINEERING_WORKSPACE_LIMIT',409);return catalog;}
/** Same audited file primitive and original WSL kernel; this scope has no user Run or approvals. */
export async function createDshEngineeringTools(input:DshEngineeringInput,binding:FileBinding,kernel:Kernel,assertCurrent:()=>void,record:RecordJournal,journal:()=>JournalRow[]) {
 if(input.contractHash!==dshEngineeringContractHash)throw new DomainError('ENGINEERING_ACCEPTANCE_STALE',409);
 const native=await createBoundedFileTools({...binding,readPaths:[...contract.files],writePaths:[...contract.files]},input.workspace),observed=new Map<string,string>();
 let expectedTree=treeHash(input.workspace),active=false,unknown=false;
 const current=(signal:AbortSignal)=>{assertCurrent();if(signal.aborted||input.signal.aborted)throw new DomainError('RUN_CANCELLED',409);assertWorkspace(input.workspace);if(treeHash(input.workspace)!==expectedTree)throw new DomainError('EXTERNAL_WORKSPACE_CHANGE',409);};
 const history=()=>{const rows=journal(),intents=rows.filter(r=>r.kind==='EngineeringToolIntent'),results=rows.filter(r=>r.kind==='EngineeringToolResult');
  if(unknown||results.some(r=>r.data.status==='UNKNOWN_EFFECT')||intents.some(r=>!results.some(s=>s.data.intentId===r.id&&['COMPLETE','FAILED_NO_EFFECT'].includes(String(s.data.status)))))throw new DomainError('TOOL_RECOVERY_REQUIRED',409);
  const initial=rows.filter(r=>r.kind==='EngineeringAcceptanceIntent');if(initial.length!==1||initial[0].data.workspace!==input.workspace||initial[0].data.contractHash!==input.contractHash||initial[0].data.configurationHash!==input.configurationHash||initial[0].data.initialSourceHash!==hash([]))throw new DomainError('ENGINEERING_ACCEPTANCE_STALE',409);
  const last=intents.at(-1),settled=last?results.filter(r=>r.data.intentId===last.id).at(-1):undefined;
  if((settled?.data.sourceHash??last?.data.sourceHash??initial[0].data.initialSourceHash)!==expectedTree)throw new DomainError('EXTERNAL_WORKSPACE_CHANGE',409);
  return intents;};
 history();assertWorkspace(input.workspace);
 const read=async(path:string)=>{const target=await native.resolve(path,true);if(!existsSync(target)){observed.set(path,'');return{exists:false,content:'',sha256:''};}const content=await native.read(path);if(hasSecret(content))throw new DomainError('SECRET_IN_TOOL_OUTPUT',403);const sha256=hash(content);observed.set(path,sha256);return{content,sha256};};
 return {async dispatch(role:Role,name:string,raw:unknown,signal:AbortSignal):Promise<Record<string,unknown>>{
  if(role!=='executor')throw new DomainError('EXECUTOR_ROLE_REQUIRED',403);if(active)throw new DomainError('ONE_EXECUTOR_TOOL_ONLY',409);
  if(!Object.hasOwn(keys,name))throw new DomainError('EXECUTOR_TOOL_DENIED',403);
  const args=object(raw),expected=keys[name];if(Object.keys(args).length!==expected.length||expected.some(k=>!Object.hasOwn(args,k))||hasSecret(JSON.stringify(args)))throw new DomainError('INVALID_TOOL_ARGUMENTS',400);
  const path=name==='desk_run'?String(args.entry):name==='desk_search'?undefined:text(args.path,100);
  if(path!==undefined&&!contract.files.includes(path))throw new DomainError('ENGINEERING_TOOL_PATH_DENIED',403);
  history();current(signal);if(history().length>=contract.maxTools)throw new DomainError('ENGINEERING_TOOL_LIMIT',409);
  const intentId=record('EngineeringToolIntent',{tool:name,...(path?{path}:{}),sourceHash:expectedTree,requestHash:hash(args)});active=true;let effect=false;
  try{let result:Record<string,unknown>;
   if(name==='desk_read')result=await read(path!);
   else if(name==='desk_search')result={matches:await native.search(text(args.text,500))};
   else if(name==='desk_run'){
    const command=validateSandboxCommand(args);if(command.runtime!=='node'||command.entry!=='main.mjs'||!existsSync(within(input.workspace,'main.mjs')))throw new DomainError('SANDBOX_ENTRY_DENIED',403);
    effect=true;result={execution:await kernel.run(input.workspace,command,{signal:AbortSignal.any([signal,input.signal])})};effect=false;
   }else{
    const target=await native.resolve(path!,true);let content=args.content,expectedSha=args.expected_sha;
    if(name==='desk_edit'){const previous=await read(path!),edited=editUniqueText(previous.content,String(args.old_text),String(args.new_text));if(typeof args.old_text!=='string'||!args.old_text||typeof args.new_text!=='string'||previous.sha256!==expectedSha||edited===undefined)throw new DomainError('STALE_OR_AMBIGUOUS_EDIT',409);content=edited;}
    const invalid=typeof content!=='string'?'CONTENT_TYPE':Buffer.byteLength(content)>65536?'CONTENT_BYTES':typeof expectedSha!=='string'?'EXPECTED_SHA_TYPE':expectedSha!==''&&!/^[a-f0-9]{64}$/.test(expectedSha)?'EXPECTED_SHA_FORMAT':hasSecret(content)?'SECRET_DETECTED':null;
    if(invalid){record('EngineeringToolArgumentRejected',{intentId,tool:name,rule:invalid,contentBytes:typeof content==='string'?Buffer.byteLength(content):null,expectedShaType:typeof expectedSha,expectedShaLength:typeof expectedSha==='string'?expectedSha.length:null});throw new DomainError('ENGINEERING_TOOL_CONTENT_DENIED',403);}
    if(expectedSha&&observed.get(path!)!==expectedSha)throw new DomainError('READ_BEFORE_WRITE_REQUIRED',409);
    const stage=join(dirname(input.workspace),'tool-stage');mkdirSync(stage,{recursive:true});if(lstatSync(stage).isSymbolicLink())throw new DomainError('ENGINEERING_WORKSPACE_REDIRECTED',409);
    const temp=join(stage,id('write')),fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,content as string);fsyncSync(fd);}finally{closeSync(fd);}
    try{current(signal);const old=existsSync(target)?readFileSync(target):null;
     if(old&&(lstatSync(target).isSymbolicLink()||!lstatSync(target).isFile()||lstatSync(target).nlink!==1)||(old?hash(old):'')!==expectedSha)throw new DomainError('STALE_TOOL_WRITE',409);
     renameSync(temp,target);effect=true;expectedTree=treeHash(input.workspace);observed.set(path!,hash(content));result={sha256:hash(content),sourceHash:expectedTree};
    }finally{if(existsSync(temp))unlinkSync(temp);}
   }
   current(signal);if(hasSecret(JSON.stringify(result)))throw new DomainError('SECRET_IN_TOOL_OUTPUT',403);
   record('EngineeringToolResult',{intentId,tool:name,status:'COMPLETE',sourceHash:expectedTree,responseHash:hash(result),...(['desk_write','desk_edit'].includes(name)?{path,sha256:result.sha256}:{})});return result;
  }catch(error){unknown=effect;try{record('EngineeringToolResult',{intentId,tool:name,status:effect?'UNKNOWN_EFFECT':'FAILED_NO_EFFECT',code:error instanceof DomainError?error.code:'ENGINEERING_TOOL_FAILED'});}catch{unknown=true;}throw error;
  }finally{active=false;}
 }};
}
/** File bytes must be backed by this execution's acknowledged writes, not external pre-seeding. */
export function dshEngineeringArtifacts(input:DshEngineeringInput,journal:JournalRow[]){
 const catalog=assertWorkspace(input.workspace),sourceHash=treeHash(input.workspace),intents=journal.filter(r=>r.kind==='EngineeringToolIntent'),results=journal.filter(r=>r.kind==='EngineeringToolResult');
 const last=intents.at(-1),settled=last?results.filter(r=>r.data.intentId===last.id).at(-1):undefined;
 if(catalog.length!==contract.files.length||intents.some(r=>!results.some(s=>s.data.intentId===r.id&&['COMPLETE','FAILED_NO_EFFECT'].includes(String(s.data.status))))||
  results.some(r=>r.data.status==='UNKNOWN_EFFECT')||(settled?.data.sourceHash??last?.data.sourceHash)!==sourceHash||contract.files.some(path=>{
   const written=results.filter(r=>r.data.status==='COMPLETE'&&['desk_write','desk_edit'].includes(String(r.data.tool))&&r.data.path===path).at(-1);
   return !written||written.data.sha256!==catalog.find(f=>f.path===path)?.sha256;
  }))throw new DomainError('ENGINEERING_TOOL_EXECUTION_UNVERIFIED',409);
 return{sourceHash,catalog};
}
export async function verifyDshEngineering(input:DshEngineeringInput,kernel:{run(workspace:string,command:SandboxCommand,options:{signal:AbortSignal}):Promise<SandboxResult>},assertCurrent:()=>void):Promise<DshEngineeringVerification>{
 const catalog=assertWorkspace(input.workspace),sourceHash=treeHash(input.workspace);if(contract.files.some(path=>!catalog.some(f=>f.path===path)))throw new DomainError('ENGINEERING_ARTIFACT_MISSING',409);
 const cases:DshEngineeringVerification['cases']=[];
 for(const c of contract.cases){assertCurrent();if(input.signal.aborted)throw new DomainError('RUN_CANCELLED',409);
  const execution=await kernel.run(input.workspace,{runtime:'node',entry:'main.mjs',args:c.args,stdin:c.stdin},{signal:input.signal});
  if(execution.sourceHash!==sourceHash||treeHash(input.workspace)!==sourceHash)throw new DomainError('VERIFIER_SOURCE_CHANGED',409);
  cases.push({id:c.id,ok:execution.status==='EXECUTED'&&execution.exitCode===c.exitCode&&execution.stdout===c.stdout&&execution.stderr===c.stderr,execution});
 }
 assertCurrent();return{sourceHash,ok:cases.every(c=>c.ok),cases};
}
