import {spawn as spawnProcess} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {childEnv,DomainError,hash} from './security.js';
import type {Config} from '../shared/types.js';
import type {Product} from '../shared/product.js';
import {wslProxyEnvironment,type WslProxyBinding} from './providers/codex-transport.js';

const prefix='/opt/dream-maker-controller/';
const keys=['schema','distro','supervisor','bridge','connector','node','program','home','port','hashes'];
const pins=['supervisor','bridge','connector','node','program'] as const;
const failureReasons=new Set(['PROGRAM_PIN_MISMATCH','DEDICATED_RESOURCE_PARENT_REQUIRED','PRIVATE_SOCKET_REQUIRED','HOME_CLEANUP_RECONCILIATION_REQUIRED','START_TIMEOUT','SERVICE_EXITED','REDIRECTED_PROGRAM','REGULAR_PROGRAM_REQUIRED','SYSTEM_FAILURE']);
const cleanupStages=new Set(['CGROUP_KILL','CHILD_REAP','KERNEL_EMPTY_CHECK','CGROUP_REMOVE','EMPTY_AND_REMOVED','CHILD_REAP_TIMEOUT','NO_CHILD_STARTED']);
export interface KimiServiceProfile {schema:'dream-maker.kimi-local-service.v1';distro:string;supervisor:string;bridge:string;connector:string;node:string;program:string;home:string;port:number;hashes:Record<typeof pins[number],string>}
type ServiceConfig=Pick<Config,'planner1'|'kimi'|'clash'>;
interface KimiWslNetwork {schema:'dream-maker.kimi-wsl-proxy.v1';environment:Record<string,string>}
function path(value:unknown):value is string{return typeof value==='string'&&value.startsWith(prefix)&&value.length<400&&value.slice(1).split('/').every(v=>v!=='.'&&v!=='..'&&/^[A-Za-z0-9._-]+$/.test(v));}
function invalid():never{throw new DomainError('KIMI_SERVICE_PROFILE_INVALID',409);}
export function validateKimiServiceProfile(raw:unknown,config:ServiceConfig):KimiServiceProfile{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))invalid();
 const p=raw as Record<string,unknown>;
 if(Object.keys(p).length!==keys.length||Object.keys(p).some(k=>!keys.includes(k))||p.schema!=='dream-maker.kimi-local-service.v1'||typeof p.distro!=='string'||!/^DreamMaker-[A-Za-z0-9._-]{1,65}$/.test(p.distro)||!Number.isInteger(p.port)||Number(p.port)<1024||Number(p.port)>65535||!path(p.home)||pins.some(k=>!path(p[k])))invalid();
 const hashes=p.hashes;
 if(!hashes||typeof hashes!=='object'||Array.isArray(hashes)||Object.keys(hashes).length!==pins.length||pins.some(k=>!/^[a-f0-9]{64}$/.test(String((hashes as Record<string,unknown>)[k]))))invalid();
 const expected=`http://127.0.0.1:${p.port}`;
 if(config.planner1.provider!=='kimi'||config.kimi?.enabled!==true||![expected,expected+'/'].includes(config.kimi.baseUrl))throw new DomainError('KIMI_SERVICE_BINDING_MISMATCH',409);
 return structuredClone(p) as unknown as KimiServiceProfile;
}

function kimiWslNetwork(binding:WslProxyBinding):KimiWslNetwork{
    return {schema:'dream-maker.kimi-wsl-proxy.v1',environment:wslProxyEnvironment(binding)};
}

// Execute only the bytes whose digest was selected in trusted local startup settings. No shell,
// secret, extra CLI flag, or Windows environment enters this bootstrap.
const bootstrap="import os,sys,stat,hashlib; p=sys.argv[1]; parts=p.split('/')[1:]; current='';\nfor part in parts:\n current+='/'+part\n if stat.S_ISLNK(os.lstat(current).st_mode): raise ValueError('REDIRECTED_SUPERVISOR')\nf=os.open(p,os.O_RDONLY|os.O_NOFOLLOW); raw=os.read(f,131073); os.close(f);\nif len(raw)>131072 or hashlib.sha256(raw).hexdigest()!=sys.argv[2]: raise ValueError('SUPERVISOR_PIN_MISMATCH')\nexec(compile(raw,p,'exec'),{'__name__':'__main__','__file__':p})";
export interface KimiLocalService {serviceId:string;stop():Promise<void>}
export async function startKimiLocalService(input:{product:Product;config:ServiceConfig;env?:NodeJS.ProcessEnv;readProfile?:(path:string)=>unknown;resolveWslProxy?:(profile:KimiServiceProfile)=>Promise<WslProxyBinding>;spawn?:typeof spawnProcess;timeoutMs?:number;signal?:AbortSignal;onEvent?:(event:Record<string,unknown>)=>void}):Promise<KimiLocalService|null>{
 const env=input.env??process.env,selected=env.DM_KIMI_SERVICE_PROFILE;
 if(input.product==='dreamflow'||selected===undefined||selected==='')return null;
 if(input.signal?.aborted)throw new DomainError('KIMI_SERVICE_START_CANCELLED',409);
 const raw=(input.readProfile??(p=>{const b=readFileSync(p);if(b.length>16384)invalid();return JSON.parse(b.toString('utf8'));}))(selected);
 const profile=validateKimiServiceProfile(raw,input.config),serviceId='kimi_service_'+randomBytes(10).toString('hex');
 const socket=prefix+'owned-kimi-services/'+serviceId+'/control.sock';
 let network:KimiWslNetwork|undefined;
 if(input.config.clash.enabled){
  if(typeof input.resolveWslProxy!=='function')throw new DomainError('KIMI_CONTROLLED_NETWORK_REQUIRED',409);
  try{network=kimiWslNetwork(await input.resolveWslProxy(profile));}
  catch(error){if(error instanceof DomainError&&error.code==='KIMI_SERVICE_START_CANCELLED')throw error;throw new DomainError('KIMI_CONTROLLED_NETWORK_REQUIRED',409);}
 }
 const request={...profile,serviceId,instanceId:serviceId,accountRef:input.config.planner1.accountRef??'',...(network?{network}:{})};
 input.onEvent?.({type:'STARTING',serviceId,profileHash:hash(profile)});
 if(input.signal?.aborted)throw new DomainError('KIMI_SERVICE_START_CANCELLED',409);
 const child=(input.spawn??spawnProcess)('wsl.exe',['-d',profile.distro,'-u','root','--exec','/usr/bin/python3','-c',bootstrap,profile.supervisor,profile.hashes.supervisor],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:childEnv()});
 let pending='',total=0,invalidEvent=false,failed=false,cancelled=false,ready=false,cleanup=false,closed=false;
 let readyResolve:()=>void,readyReject:(e:unknown)=>void;
 const readyPromise=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 let closeResolve:(v:{code:number|null;error?:string})=>void;
 const closePromise=new Promise<{code:number|null;error?:string}>(resolve=>{closeResolve=resolve;});
 const onAbort=()=>{cancelled=true;readyReject(new DomainError('KIMI_SERVICE_START_CANCELLED',409));child.stdin.end();};
 const refuse=()=>{invalidEvent=true;readyReject(new DomainError('KIMI_SERVICE_START_FAILED',409));child.stdin.end();};
 child.stdin.on('error',refuse);
 child.stderr.on('data',()=>{}); // Drain, never retain upstream authentication/error text.
 child.stdout.on('data',(bytes:Buffer)=>{
  total+=bytes.length;pending+=bytes.toString('utf8');if(total>65536||pending.length>8192){refuse();return;}
  while(pending.includes('\n')){
   const end=pending.indexOf('\n'),line=pending.slice(0,end);pending=pending.slice(end+1);
   let event:Record<string,unknown>;try{event=JSON.parse(line);}catch{refuse();return;}
   if(!event||typeof event!=='object'||Array.isArray(event)||event.schema!=='dream-maker.kimi-service-event.v1'||event.serviceId!==serviceId){refuse();return;}
   if(event.type==='READY'&&!ready&&event.port===profile.port&&event.socket===socket){ready=true;readyResolve();}
   else if(event.type==='CLEANUP'&&typeof event.proven==='boolean'&&Array.isArray(event.remainingPids)){cleanup=event.proven===true&&event.remainingPids.length===0;}
   else if(event.type==='FAILED'){failed=true;readyReject(new DomainError('KIMI_SERVICE_START_FAILED',409));child.stdin.end();}
   else{refuse();return;}
   // Evidence exposes fixed metadata only. Never forward arbitrary fields from a peer.
   input.onEvent?.({type:event.type,serviceId,...(event.type==='READY'?{port:profile.port,socket}:{proven:cleanup}),...(event.type==='FAILED'?{reason:typeof event.reason==='string'&&failureReasons.has(event.reason)?event.reason:'UNSPECIFIED'}:{}),...(['CLEANUP','FAILED'].includes(String(event.type))?{stage:typeof event.stage==='string'&&cleanupStages.has(event.stage)?event.stage:'UNSPECIFIED',errno:typeof event.errno==='number'&&Number.isInteger(event.errno)&&event.errno>=0&&event.errno<=4095?event.errno:null}:{})});
  }
 });
 child.on('error',()=>{closed=true;readyReject(new DomainError('KIMI_SERVICE_START_FAILED',409));closeResolve({code:null,error:'SPAWN_ERROR'});});
 child.on('close',code=>{closed=true;input.signal?.removeEventListener('abort',onAbort);if(!ready)readyReject(new DomainError('KIMI_SERVICE_START_FAILED',409));closeResolve({code});});
 let stopping:Promise<void>|undefined;
 const installed:Record<string,string>={DM_KIMI_BRIDGE:'1',DM_KIMI_BRIDGE_DISTRO:profile.distro,DM_KIMI_BRIDGE_SOCKET:socket,DM_KIMI_BRIDGE_CONNECTOR:profile.connector,DM_KIMI_BRIDGE_INSTANCE:serviceId,DM_KIMI_BRIDGE_ACCOUNT:input.config.planner1.accountRef??''};
 const previous=Object.fromEntries(Object.keys(installed).map(k=>[k,env[k]]));
 const stop=()=>stopping??=(async()=>{
  child.stdin.end();let timer:ReturnType<typeof setTimeout>|undefined;
  const ended=await Promise.race([closePromise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new DomainError('KIMI_SERVICE_CLEANUP_UNPROVEN',409)),15000);})]).finally(()=>clearTimeout(timer));
  if(!cleanup||invalidEvent||pending.length||ended.error)throw new DomainError('KIMI_SERVICE_CLEANUP_UNPROVEN',409);
  if(Object.entries(installed).every(([k,v])=>env[k]===v))for(const k of Object.keys(installed)){if(previous[k]===undefined)delete env[k];else env[k]=previous[k];}
 })();
 child.stdin.write(JSON.stringify(request)+'\n');
 input.signal?.addEventListener('abort',onAbort,{once:true});
 if(input.signal?.aborted)onAbort();
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await Promise.race([readyPromise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new DomainError('KIMI_SERVICE_START_TIMEOUT',409)),input.timeoutMs??30000);})]);
  if(cancelled)throw new DomainError('KIMI_SERVICE_START_CANCELLED',409);
  if(closed||invalidEvent||failed)throw new DomainError('KIMI_SERVICE_START_FAILED',409);
 }catch(error){try{await stop();}catch{throw new DomainError('APPLICATION_CLOSE_UNCERTAIN',409);}throw error;}
 finally{clearTimeout(timer);}
 Object.assign(env,installed);
 return {serviceId,stop};
}
