// Harmless synthetic canaries only. No setup/uninstall, model or real credential read.
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {capture} from '../../dist/server/process.js';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {childEnv,hash} from '../../dist/server/security.js';
import {prepareWindowsStorage} from '../../dist/server/siwc/windows-storage.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(process.argv[2]!=='--real-os'||process.platform!=='win32')throw Error('EXPLICIT_WINDOWS_CHECK_REQUIRED');
const entry='C:/Users/Hp/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js';
const home=resolve(root,'../../runtime/codex-home');
const parent=resolve(root,'.runtime/windows-token-checks');mkdirSync(parent,{recursive:true});
const data=mkdtempSync(resolve(parent,'owned-')),workspace=resolve(data,'workspace'),control=resolve(data,'controller');
mkdirSync(workspace);await prepareWindowsStorage(control);
const secret=resolve(control,'synthetic-canary.txt');writeFileSync(secret,'SYNTHETIC_NO_REAL_CREDENTIAL');
const own=resolve(workspace,'own.txt');writeFileSync(own,'OWN_SOURCE');
const script=resolve(workspace,'canary.cjs');
writeFileSync(script,`const fs=require('node:fs'),net=require('node:net');
const result={ownRead:false,workspaceWriteDenied:false,controllerReadDenied:false,networkDenied:false};
try{result.ownRead=fs.readFileSync('own.txt','utf8')==='OWN_SOURCE';}catch{}
try{fs.writeFileSync('unexpected-write.txt','SYNTHETIC');}catch(error){result.workspaceWriteDenied=['EACCES','EPERM'].includes(error.code);}
try{fs.readFileSync(process.argv[2]);}catch(error){result.controllerReadDenied=['EACCES','EPERM'].includes(error.code);}
const socket=net.connect({host:'127.0.0.1',port:Number(process.argv[3])});
socket.once('connect',()=>{socket.destroy();finish();});socket.once('error',error=>{result.networkDenied=['EACCES','EPERM'].includes(error.code);finish();});
const timer=setTimeout(()=>{socket.destroy();finish();},1500);let finished=false;
function finish(){if(finished)return;finished=true;clearTimeout(timer);console.log(JSON.stringify(result));}
`);
let connections=0;const server=createServer(s=>{connections++;s.destroy();});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
let result;
try{
 const run=await capture(process.execPath,[entry,'sandbox','-P',':read-only','-C',workspace,'--',process.execPath,script,secret,String(port)],{
  cwd:workspace,env:childEnv({CODEX_HOME:home}),timeoutMs:15000,maxBytes:8192});
 let observed=null;try{observed=JSON.parse(run.stdout.trim());}catch{}
 result={schema:'dream-maker.windows-token-check.v1',at:new Date().toISOString(),entry,home,
  evidenceClass:'REAL_SYNTHETIC_OS_CHECK_NOT_LIVE_AGENT',modelTurns:0,setupRequested:false,
  permissionProfile:':read-only',ownedDirectory:data,workspace,syntheticController:control,
  exitCode:run.code,errorCode:null,observed,listenerConnections:connections,
  diagnostic:run.stderr.slice(0,2000),node:process.version,scriptHash:hash(readFileSync(script))};
}finally{await new Promise(resolve=>server.close(resolve));}
const directory=resolve(root,'docs/windows-token/evidence');mkdirSync(directory,{recursive:true});
const output=resolve(directory,'canary-'+Date.now()+'.json');writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({result:result.observed,exitCode:result.exitCode,errorCode:result.errorCode,evidence:output}));
if(result.exitCode!==0||result.listenerConnections!==0||
 !['ownRead','workspaceWriteDenied','controllerReadDenied','networkDenied'].every(key=>result.observed?.[key]===true))process.exitCode=1;
