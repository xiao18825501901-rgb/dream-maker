import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {resolve,dirname,relative,sep,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {DomainError,within} from './security.js';
import {treeHash} from './workspace.js';
import type {Run} from '../shared/types.js';
const same=(a:string,b:string)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
function fail(code:string):never{throw new DomainError(code,409,'此存储位置尚未完成迁移核验；不会访问旧目录或继续旧运行。');}
function contained(root:string,path:string){const name=relative(resolve(root),resolve(path));if(!name||isAbsolute(name)||name==='..'||name.startsWith('..'+sep))fail('STORAGE_ROOT_CHANGED');return within(root,name.split(sep).join('/'));}
function isContained(root:string,path:string){
 const name=relative(resolve(root),resolve(path));
 if(!name||isAbsolute(name)||name==='..'||name.startsWith('..'+sep))return false;
 try{within(root,name.split(sep).join('/'));return true;}catch{return false;}
}
function additionalDataRoots(scope:Record<string,unknown>):string[]{
 const value=scope.additionalDataRoots;
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>8||!value.every(item=>typeof item==='string'&&isAbsolute(item)))fail('STORAGE_SCOPE_INVALID');
 return value.map(item=>resolve(item as string));
}
function jsonDocument(path:string){
 const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1000000)fail('WORKSPACE_RELOCATION_INVALID');
 const bytes=readFileSync(path);if(bytes.byteLength>1000000)fail('WORKSPACE_RELOCATION_INVALID');
 try{const value=JSON.parse(bytes.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))fail('WORKSPACE_RELOCATION_INVALID');return {value:value as Record<string,unknown>,bytes};}catch{fail('WORKSPACE_RELOCATION_INVALID');}
}
const jsonFile=(path:string)=>jsonDocument(path).value;
export type StorageScopeOptions={allowAdditionalDataRoots?:boolean};
/** A local suite marker scopes this installation, without changing portable users or global settings. */
export function assertProjectStorage(projectRoot:string,data:string,options:StorageScopeOptions={}):void{
 let folder=resolve(projectRoot);
 for(let n=0;n<16;n++){
  const marker=resolve(folder,'workspace-storage.json');
  if(existsSync(marker)){
   const scope=jsonFile(marker);
   if(scope.schema!=='dream-maker.workspace-storage.v1'||typeof scope.suiteRoot!=='string'||!same(folder,scope.suiteRoot))fail('STORAGE_SCOPE_INVALID');
   const roots=additionalDataRoots(scope);
   if(isContained(folder,data))return;
   if(options.allowAdditionalDataRoots&&roots.some(root=>isContained(root,data)))return;
   fail('STORAGE_ROOT_CHANGED');
  }
  const parent=dirname(folder);if(parent===folder)return;folder=parent;
 }
}
function expected(run:Run,data:string){
 if(!/^[A-Za-z0-9_-]{1,120}$/.test(run.id))fail('WORKSPACE_LOCATION_CHANGED');
 return within(data,'workspaces/'+run.id);
}
/** Storage relocation never grants an old run execution, dispatch, acceptance or process permission. */
export function executionWorkspace(run:Run,data:string):string{
 const path=expected(run,data);if(!same(run.workspace,path))fail('WORKSPACE_LOCATION_CHANGED');return path;
}
/** Historical provenance remains in SQLite; only controller-verified F copies may be read. */
export function readWorkspace(run:Run,data:string):string{
 const path=expected(run,data);if(same(run.workspace,path))return path;
 const manifestPath=within(data,'workspace-relocations.json');if(!existsSync(manifestPath))fail('WORKSPACE_LOCATION_CHANGED');
 const manifest=jsonFile(manifestPath),reference=manifest.copyReceipt as {path?:unknown;sha256?:unknown}|undefined;
 if(manifest.schema!=='dream-maker.workspace-relocations.v1'||manifest.provenance!=='COPIED_BYTES_NOT_EXECUTION_PROOF'||typeof manifest.dataRoot!=='string'||!same(manifest.dataRoot,data)||!Array.isArray(manifest.entries)||manifest.entries.length>5000||!reference||typeof reference.path!=='string'||typeof reference.sha256!=='string'||!/^[a-f0-9]{64}$/.test(reference.sha256))fail('WORKSPACE_RELOCATION_INVALID');
 // The receipt is bounded by the same installation scope; never follow a reference back to C:.
 assertProjectStorage(data,reference.path);
 const {value:receipt,bytes}=jsonDocument(reference.path);
 if(createHash('sha256').update(bytes).digest('hex')!==reference.sha256||receipt.schema!=='dream-maker.project-copy-receipt.v2'||receipt.allFileHashes!=='PASS'||receipt.sourceSecondPass!=='PASS'||receipt.sourceNamespaces!=='PASS'||typeof receipt.suite!=='string'||typeof receipt.source!=='string')fail('WORKSPACE_RELOCATION_INVALID');
 contained(receipt.suite,data);
 const entries=(manifest.entries as Record<string,unknown>[]).filter(item=>item&&item.runId===run.id);
 if(entries.length!==1)fail('WORKSPACE_LOCATION_CHANGED');const item=entries[0];
 if(typeof item.from!=='string'||!same(item.from,run.workspace)||typeof item.to!=='string'||!same(item.to,path)||item.recordedTreeHash!==run.treeHash||typeof item.treeHash!=='string'||!/^[a-f0-9]{64}$/.test(item.treeHash))fail('WORKSPACE_RELOCATION_INVALID');
 const legacyName=relative(receipt.source,item.from);if(isAbsolute(legacyName)||legacyName==='..'||legacyName.startsWith('..'+sep))fail('WORKSPACE_RELOCATION_INVALID');
 if(treeHash(path)!==item.treeHash)fail('RELOCATED_WORKSPACE_CHANGED');return path;
}
