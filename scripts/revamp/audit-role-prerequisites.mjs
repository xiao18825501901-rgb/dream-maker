// Read-only local prerequisite inventory. Never starts a model turn, login, desktop app or proxy change.
import { readFileSync,existsSync,mkdirSync,writeFileSync } from 'node:fs';
import { resolve,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { childEnv,within } from '../../dist/server/security.js';
const root=fileURLToPath(new URL('../..',import.meta.url));
const config=JSON.parse(readFileSync(resolve(root,'config/local.json'),'utf8')),c=config.codex;
const output=within(root,'.runtime/revamp-20261101/role-prerequisites-'+new Date().toISOString().replace(/[^0-9T]/g,''));
mkdirSync(output,{recursive:false,mode:0o700});
function run(command,args,env){const r=spawnSync(command,args,{cwd:root,env,shell:false,windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:128000});return{exit:r.status,text:(r.stdout??'')+'\n'+(r.stderr??''),error:!!r.error};}
function authStatus(result){return{exitCode:result.exit,status:result.error?'LOCAL_CHECK_FAILED':result.exit!==0?'NOT_LOGGED_IN_OR_UNAVAILABLE':/chatgpt/i.test(result.text)?'CACHED_CHATGPT_LOGIN':/api key/i.test(result.text)?'API_KEY_NOT_TARGET_SUBSCRIPTION':'AUTH_MODE_NOT_VERIFIED',remoteCallability:'NOT_VERIFIED'};}
async function listening(raw){const u=new URL(raw);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')return false;return new Promise(res=>{const socket=net.connect({host:'127.0.0.1',port:Number(u.port)});let done=false;const end=value=>{if(done)return;done=true;socket.destroy();res(value);};socket.setTimeout(1000);socket.once('connect',()=>end(true));socket.once('error',()=>end(false));socket.once('timeout',()=>end(false));});}
const windowsEntry='C:/Users/Hp/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js';
const windowsHome=within(root,relative(root,c.home).replaceAll('\\','/'));
const windows=existsSync(windowsEntry)?{
 version:run(process.execPath,[windowsEntry,'--version'],childEnv({CODEX_HOME:windowsHome})).text.match(/codex-cli\s+[\w.-]+/)?.[0]??'NOT_VERIFIED',
 ...authStatus(run(process.execPath,[windowsEntry,'-c','cli_auth_credentials_store="file"','login','status'],childEnv({CODEX_HOME:windowsHome}))),
 scope:'PROJECT_DEDICATED_HOME_NOT_THE_DESKTOP_BUNDLE',home:windowsHome
}:{status:'INDEPENDENT_CLI_MISSING'};
if(c.wslDistro!=='DreamMaker-Acceptance-20261011'||!c.wslBinary.startsWith('/opt/dream-maker-controller/codex-0.162.0/')||!c.wslHome.startsWith('/opt/dream-maker-controller/'))throw Error('WSL_SCOPE_REVIEW_REQUIRED');
const linuxArgs=['--distribution',c.wslDistro,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','HOME=/opt/dream-maker-controller','CODEX_HOME='+c.wslHome,c.wslBinary];
const wsl={distribution:c.wslDistro,home:c.wslHome,
 version:run(c.wslCommand,[...linuxArgs,'--version'],childEnv()).text.match(/codex-cli\s+[\w.-]+/)?.[0]??'NOT_VERIFIED',
 ...authStatus(run(c.wslCommand,[...linuxArgs,'-c','cli_auth_credentials_store="file"','login','status'],childEnv()))};
const report={schema:'dream-maker.role-prerequisites.v1',at:new Date().toISOString(),evidenceClass:'ACTUAL_LOCAL_CLI_STATUS_NO_MODEL_NO_AUTH_IMPORT',
 planner1:{runner:'Existing Kimi model-only binding',provider:config.planner1.provider,configuredModel:config.planner1.model,serviceListening:await listening(config.kimi.baseUrl),authentication:'NOT_VERIFIED',live:'NOT_RUN'},
 planner2:{targetRunner:'Independent Codex CLI',configuredModel:c.model,actualModel:'NOT_VERIFIED',configuredTransport:c.transport,currentFallback:config.independent?.enabled?'DEGRADED_SAME_VENDOR DeepSeek':'OFF',live:'NOT_RUN'},
 reviewer:{targetRunner:'Independent Codex CLI, separate session',configuredModel:c.model,actualModel:'NOT_VERIFIED',currentFallback:config.independent?.enabled?'DEGRADED_SAME_VENDOR DeepSeek':'OFF',live:'NOT_RUN'},
 executor:{runner:'Existing DSH SDK execution adapter',developmentEntry:'npx @deepseek-ai/dsh web',configuredModel:config.dsh.model,finalRoute:'NOT_VERIFIED_THIS_REVAMP',live:'NOT_RUN'},
 windows,wsl,modelTurnsRequested:0,credentialsCopied:false,sharedConfigurationModified:false,overall:'PARTIAL'};
writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,windows:windows.status,wsl:wsl.status,kimiListening:report.planner1.serviceListening,modelTurnsRequested:0}));
