import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {resolve,dirname,parse,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {capture} from './process.js';
import {childEnv,DomainError,hash} from './security.js';
import {WSL_ENVIRONMENT} from './wsl-sandbox.js';
const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const strip=(p:string)=>p.startsWith('\\\\?\\')?p.slice(4):p;
const fsReader={lstat:lstatSync,realpath:realpathSync.native};
type PathReader={lstat:(path:string)=>{isSymbolicLink():boolean;isDirectory():boolean};realpath:(path:string)=>string};
function fail(code='NATIVE_PROBE_CUSTODY_SCOPE_DENIED'):never{throw new DomainError(code,409);}
/** The F suite is the shared installation and the running product root is the second
 * approved installation root (an isolated Custom instance). Neither is a caller-supplied
 * data directory, and the ancestor walk below still rejects redirected paths. */
const scopeRoots=():string[]=>{const roots=[resolve('F:/DreamMakerSuite'),sourceRoot],seen=new Set<string>(),out:string[]=[];
 for(const value of roots){const key=value.toLowerCase();if(seen.has(key))continue;seen.add(key);out.push(key);}return out;};
/** The installation root itself is in scope, and so is everything beneath it. */
const withinScope=(path:string):boolean=>{const value=path.toLowerCase();return scopeRoots().some(root=>value===root||value.startsWith(root+sep));};
/** Inspect the whole ancestor chain, then use the actual Windows path with stable casing. */
export function probeCustodyDirectoryIdentity(input:string,reader:PathReader=fsReader):string{
 const root=resolve(strip(input));
 if(!withinScope(root))fail();
 let current=parse(root).root;
 for(const part of ['',...root.slice(current.length).split(sep)]){
  if(part)current=join(current,part);const info=reader.lstat(current);if(info.isSymbolicLink()||!info.isDirectory())fail();
 }
 const actual=resolve(strip(reader.realpath(root))).toLowerCase();if(!withinScope(actual))fail();return actual;
}
interface Registration {distribution:string;id:string;basePath:string;version:number}
export interface ProbeCustodyDiskIdentity {volumeSerial:string;fileId:string;birthtimeNs:string}
/** Node's Windows stat fields come from the opened file's volume/file identity, not its path. */
export function probeCustodyDiskIdentity(path:string):ProbeCustodyDiskIdentity{
 const info=lstatSync(path,{bigint:true});
 if(!info.isFile()||info.isSymbolicLink()||info.dev<=0n||info.ino<=0n||info.birthtimeNs<=0n)fail('NATIVE_PROBE_CUSTODY_ENVIRONMENT_CHANGED');
 return {volumeSerial:String(info.dev),fileId:String(info.ino),birthtimeNs:String(info.birthtimeNs)};
}
export function assertProbeCustodyDiskIdentity(expected:unknown,observed:unknown):void{
 const fields=['volumeSerial','fileId','birthtimeNs'];
 const valid=(v:unknown):v is ProbeCustodyDiskIdentity=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===fields.length&&
  fields.every(k=>typeof (v as Record<string,unknown>)[k]==='string'&&/^[1-9][0-9]{0,39}$/.test((v as Record<string,string>)[k]));
 if(!valid(expected)||!valid(observed)||fields.some(k=>expected[k as keyof ProbeCustodyDiskIdentity]!==observed[k as keyof ProbeCustodyDiskIdentity]))fail('NATIVE_PROBE_CUSTODY_ENVIRONMENT_CHANGED');
}
const guid=/^\{[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\}$/i;
/** Signing-key storage is separate from the Agent runtime. An explicit existing
 * dedicated WSL pin keeps exFAT/ACL failures closed without requiring WSL Codex login. */
export function selectProbeCustody(explicit:unknown,codex:{transport?:string;wslDistro?:string}):{transport:'stdio'|'wsl';distribution:string}{
 if(explicit===undefined)return{transport:codex.transport==='wsl'?'wsl':'stdio',distribution:codex.transport==='wsl'?codex.wslDistro??'':''};
 if(!explicit||typeof explicit!=='object'||Array.isArray(explicit))fail();
 const value=explicit as Record<string,unknown>;
 if(Object.keys(value).length!==2||value.type!=='DEDICATED_WSL'||value.distribution!==WSL_ENVIRONMENT)fail();
 return{transport:'wsl',distribution:WSL_ENVIRONMENT};
}
export function assertProbeCustodyRegistration(expected:Registration,observed:Registration):void{
 const valid=(v:Registration)=>v&&v.distribution===WSL_ENVIRONMENT&&typeof v.id==='string'&&guid.test(v.id)&&typeof v.basePath==='string'&&v.basePath.length<500&&v.version===2;
 if(!valid(expected)||!valid(observed)||expected.id.toLowerCase()!==observed.id.toLowerCase()||resolve(strip(expected.basePath)).toLowerCase()!==resolve(strip(observed.basePath)).toLowerCase())fail('NATIVE_PROBE_CUSTODY_ENVIRONMENT_CHANGED');
 const actual=probeCustodyDirectoryIdentity(observed.basePath),approved=probeCustodyDirectoryIdentity(resolve('F:/DreamMakerSuite/runtime/wsl',WSL_ENVIRONMENT));
 if(actual!==approved)fail('NATIVE_PROBE_CUSTODY_ENVIRONMENT_CHANGED');
 const disk=join(actual,'ext4.vhdx'),info=lstatSync(disk);if(!info.isFile()||info.isSymbolicLink())fail('NATIVE_PROBE_CUSTODY_ENVIRONMENT_CHANGED');
}
function pin(){
 const path=resolve(sourceRoot,'.runtime/controller/probe-custody-wsl-identity.json');probeCustodyDirectoryIdentity(dirname(path));
 const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>8192)fail('NATIVE_PROBE_CUSTODY_ENVIRONMENT_CHANGED');
 const bytes=readFileSync(path);if(bytes.length>8192)fail();let value:{schema:string;registration:Registration;diskIdentity:ProbeCustodyDiskIdentity;observedAt:string};
 try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('NATIVE_PROBE_CUSTODY_ENVIRONMENT_CHANGED');}
 if(!value||value.schema!=='dream-maker.probe-custody-wsl-identity.v2'||Object.keys(value).some(k=>!['schema','registration','diskIdentity','observedAt'].includes(k)))fail('NATIVE_PROBE_CUSTODY_ENVIRONMENT_CHANGED');
 assertProbeCustodyDiskIdentity(value.diskIdentity,value.diskIdentity);
 return {value,sha256:hash(bytes)};
}
export function probeCustodyEnvironmentHash():string{return pin().sha256;}
/** Registry metadata only; no auth file or other distribution is returned. */
export async function verifyProbeCustodyEnvironment(signal?:AbortSignal):Promise<void>{
 const expected=pin().value;
 const script="$ErrorActionPreference='Stop';$dmRows=@(foreach($dmKey in Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'){$dmValue=Get-ItemProperty -LiteralPath $dmKey.PSPath;if($dmValue.DistributionName -eq '"+WSL_ENVIRONMENT+"'){[pscustomobject]@{distribution=$dmValue.DistributionName;id=$dmKey.PSChildName;basePath=$dmValue.BasePath;version=$dmValue.Version}}});ConvertTo-Json -InputObject $dmRows -Compress";
 const r=await capture(join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{cwd:sourceRoot,env:childEnv(),signal,timeoutMs:15000,maxBytes:8192});
 let rows:Registration[];try{rows=JSON.parse(r.stdout);}catch{fail('NATIVE_PROBE_CUSTODY_ENVIRONMENT_CHANGED');}
 if(r.code!==0||!Array.isArray(rows)||rows.length!==1)fail('NATIVE_PROBE_CUSTODY_ENVIRONMENT_CHANGED');assertProbeCustodyRegistration(expected.registration,rows[0]);
 assertProbeCustodyDiskIdentity(expected.diskIdentity,probeCustodyDiskIdentity(join(rows[0].basePath,'ext4.vhdx')));
}
/** Both the binding and execution read this exact installed helper, independent of data root. */
export function probeCustodyHelper(){
 const path=resolve(sourceRoot,'scripts/isolation/probe-key-custody.py');probeCustodyDirectoryIdentity(dirname(path));
 const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>32768)fail();const bytes=readFileSync(path);if(bytes.length>32768)fail();return {source:bytes.toString('utf8'),sha256:hash(bytes)};
}
/** The original Windows ACL/DPAPI path must not require a dedicated WSL installation. */
export function probeCustodySourceBinding(transport:string|undefined,loaders={helper:()=>probeCustodyHelper().sha256,environment:probeCustodyEnvironmentHash}){
 return transport==='wsl'?{probeCipherCustody:loaders.helper(),probeCipherEnvironment:loaders.environment()}:
  {probeCipherCustody:null,probeCipherEnvironment:null};
}
