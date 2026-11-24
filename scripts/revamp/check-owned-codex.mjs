// Benign actual local CLI --version in its own Linux process group. No auth/model/role turn.
import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture } from '../../dist/server/process.js';
import { RpcPeer } from '../../dist/server/providers/rpc.js';
import { childEnv,hash,id } from '../../dist/server/security.js';
if(!process.argv.includes('--run-local-version-only'))throw Error('EXPLICIT_BENIGN_LOCAL_CHECK_REQUIRED');
const root=fileURLToPath(new URL('../..',import.meta.url)),config=JSON.parse(readFileSync(resolve(root,'config/local.json'),'utf8')).codex;
if(config.wslDistro!=='DreamMaker-Acceptance-20261011'||!config.wslBinary.includes('/codex-0.162.0/')||!config.wslHome.startsWith('/opt/dream-maker-controller/'))throw Error('DEDICATED_PINNED_CLI_SCOPE_REQUIRED');
const script=readFileSync(resolve(root,'scripts/isolation/codex-owned-process.py'),'utf8'),markerRoot='/opt/dream-maker-controller/owned-role-processes-revamp',markerId=id('owned_codex');
const output=resolve(root,'.runtime/revamp-20261101/owned-codex-check-'+new Date().toISOString().replace(/[^0-9T]/g,''));mkdirSync(output,{recursive:false,mode:0o700});
const argv=args=>['-d',config.wslDistro,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-c',script,...args];
const run=async args=>capture(config.wslCommand||'wsl.exe',argv(args),{cwd:root,env:childEnv(),timeoutMs:20000,maxBytes:30000});
const report={schema:'dream-maker.owned-codex-local-check.v1',at:new Date().toISOString(),evidenceClass:'ACTUAL_LOCAL_CLI_VERSION_AND_PROCESS_GROUP_NO_MODEL_NOT_LIVE_ROLE',helperSha256:hash(script),markerRoot,markerId,modelTurnsRequested:0,credentialsCopied:false,sharedConfigurationModified:false,checks:[]};
try{
 const executed=await run(['exec',markerRoot,markerId,config.wslBinary,config.wslHome,config.wslCwdRoot,'--version']);
 report.version=executed.stdout.match(/codex-cli\s+[\w.-]+/)?.[0]??null;
 if(executed.code!==0||report.version!=='codex-cli 0.162.0')throw Error('PINNED_LOCAL_VERSION_UNVERIFIED');
 report.checks.push({kind:'VERSION',status:'PASS'});
 const first=await run(['status',markerRoot,markerId]);if(first.code!==0)throw Error('OWNED_MARKER_UNVERIFIED');
 const observed=JSON.parse(first.stdout);report.marker=observed.marker;report.markerSha256=observed.markerSha256;
 if(observed.cleanup.proven!==false)throw Error('UNPINNED_MARKER_MUST_NOT_PROVE_RECOVERY');
 const second=await run(['status',markerRoot,markerId,observed.markerSha256]);if(second.code!==0)throw Error('OWNED_GROUP_STATUS_UNVERIFIED');
 const closed=JSON.parse(second.stdout);report.cleanup=closed.cleanup;report.members=closed.members;
 if(closed.cleanup.proven!==true||closed.members.length)throw Error('OWNED_GROUP_NOT_PROVEN_EMPTY');
 report.checks.push({kind:'PINNED_LINUX_PROCESS_GROUP_ABSENCE',status:'PASS'});
 if(process.argv.includes('--include-app-server-handshake-no-turn')){
  const serverMarker=id('owned_codex');let peer;
  try{
   peer=new RpcPeer(config.wslCommand||'wsl.exe',argv(['exec',markerRoot,serverMarker,config.wslBinary,config.wslHome,config.wslCwdRoot,'app-server']),{cwd:root,env:childEnv()},12000);
   await peer.request('initialize',{clientInfo:{name:'dm_owned_process_check',version:'0.1.0'},capabilities:{experimentalApi:true}});peer.notify('initialized',{});
   const active=JSON.parse((await run(['status',markerRoot,serverMarker])).stdout);
   const pinned=JSON.parse((await run(['status',markerRoot,serverMarker,active.markerSha256])).stdout);
   if(!pinned.members.length||pinned.cleanup.proven!==false)throw Error('ACTIVE_GROUP_MUST_NOT_PROVE_CLEANUP');
   report.server={markerId:serverMarker,marker:pinned.marker,markerSha256:pinned.markerSha256,activeMembers:pinned.members,activeCleanup:pinned.cleanup,threadRequests:0,turnRequests:0};
   await peer.finish();peer=undefined;
   const ended=JSON.parse((await run(['status',markerRoot,serverMarker,pinned.markerSha256])).stdout);report.server.closed=ended.cleanup;report.server.remainingMembers=ended.members;
   if(!ended.cleanup.proven||ended.members.length)throw Error('APP_SERVER_GROUP_CLEANUP_UNVERIFIED');
   report.checks.push({kind:'ACTUAL_ACTIVE_GROUP_REFUSAL_AND_STDIN_EXIT',status:'PASS'});
  }finally{await peer?.finish();}
 }
 report.overall='PASS_LOCAL_PROCESS_ONLY_NOT_ROLE_ACCEPTANCE';
}catch(error){report.overall='NOT_VERIFIED';report.code=error instanceof Error&&/^[A-Z_]{1,100}$/.test(error.message)?error.message:'LOCAL_CHECK_UNVERIFIED';process.exitCode=1;}
writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,overall:report.overall,version:report.version??null,cleanup:report.cleanup??null,code:report.code??null,modelTurnsRequested:0}));
