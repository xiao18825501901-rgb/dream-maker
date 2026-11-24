// Real SDK subprocess/profile handshake only. No prompt, inference or vendor transport.
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {buildNativeProfile,assertNativeProfile} from '../../adapters/dsh-native-profile.mjs';
import {startToolBroker} from '../../dist/server/tool-broker.js';
import {hash,childEnv} from '../../dist/server/security.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(process.argv[2]!=='--actual-sdk-no-model')throw Error('EXPLICIT_PROFILE_NO_MODEL_CHECK_REQUIRED');
const dsh='C:/Users/Hp/Documents/Archon_Astra_DSH_Source_Package/Archon_Astra_DSH_Source_Package/upstream/deepseek-harness';
const sdkCommit=execFileSync('git',['-C',dsh,'rev-parse','HEAD'],{env:childEnv(),encoding:'utf8'}).trim();
if(sdkCommit!=='4878cdabd87d4041bdaff61d04c966883b9fd07a')throw Error('DSH_SOURCE_PIN_CHANGED');
const sdkEntry=resolve(dsh,'packages/sdk/client/lib/index.js'),dshBin=resolve(dsh,'apps/cli/lib/bin.js');
const require=createRequire(resolve(dsh,'packages/boot/app-boot/package.json'));
const inputs={basePatch:resolve(dsh,'packages/bundle/base/cordis.patch.yml'),sdkPatch:resolve(dsh,'packages/bundle/sdk-app/cordis.patch.yml'),yamlModule:require.resolve('js-yaml')};
const checks=[];let requests=0,toolCalls=0,broker,harness,profile,attestation;
const proxyBearer='OFFLINE_PROFILE_ONLY_MODEL_PROXY_BEARER';
const proxy=createServer((_req,res)=>{requests++;res.writeHead(403);res.end('NO_MODEL_DISPATCH_AUTHORIZED');});
try{
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const modelURL=`http://127.0.0.1:${proxy.address().port}/v1`;
 broker=await startToolBroker({dispatch:async()=>{toolCalls++;throw Error('NO_AGENT_DISPATCH_AUTHORIZED');}});
 const parent=resolve(root,'.runtime/native-profile-checks');mkdirSync(parent,{recursive:true});const data=mkdtempSync(resolve(parent,'owned-'));
 profile=buildNativeProfile(data,{sdkCommit,...inputs,dependencies:[...Object.values(inputs),sdkEntry,dshBin].map(path=>({path,sha256:hash(readFileSync(path))}))},
  {modelURL,maxTokens:256,contextTokens:1048576,pluginURL:pathToFileURL(resolve(root,'adapters/dsh-tools-plugin.mjs')).href});
 const toolsModule=resolve(dsh,'packages/core/tools/lib/index.js'),configPath=resolve(data,'tool-client.json');
 writeFileSync(configPath,JSON.stringify({schema:'dream-maker.dsh-tool-client.v1',sdkCommit,sdkToolsModule:toolsModule,toolUrl:broker.url,dependencies:[{path:toolsModule,sha256:hash(readFileSync(toolsModule))}]}),{flag:'wx',mode:0o600});
 const {DeepSeekHarness}=await import(pathToFileURL(sdkEntry).href);
 const env=childEnv({DEEPSEEK_API_KEY:proxyBearer,DEEPSEEK_BASE_URL:modelURL,DSH_TELEMETRY_DISABLED:'1',SHENLIN_LAYA_ENABLED:'false',
  DM_TOOL_PROXY_TOKEN:broker.token,DM_DSH_TOOL_CLIENT_CONFIG:configPath,DM_DSH_TOOL_CLIENT_SHA256:hash(readFileSync(configPath)),
  DM_DSH_PROFILE_MANIFEST:profile.manifestPath,DM_DSH_PROFILE_SHA256:profile.manifestSha256});
 harness=new DeepSeekHarness({cwd:data,processCwd:data,dshHome:profile.home,dshBin,profile:'sdk',env,
  provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off',maxTokens:256,initializeTimeoutMs:15000,shutdownTimeoutMs:3000,disposeEofGraceMs:3000,disposeGraceMs:2000});
 await harness.start();checks.push({name:'actual SDK subprocess initializes the dedicated frozen profile',result:'PASS'});
 attestation=JSON.parse(readFileSync(resolve(profile.home,'runtime-attestation.json'),'utf8'));
 const expected=['desk_edit','desk_read','desk_run','desk_search','desk_write'];
 if(attestation.profileSha256!==profile.manifestSha256||JSON.stringify(attestation.roster)!==JSON.stringify(expected)||attestation.modelURL!==modelURL||attestation.cwd!==data)throw Error('ACTUAL_PROFILE_ATTESTATION_MISMATCH');
 checks.push({name:'actual runtime registers exactly five controller tools and the pinned local model route',result:'PASS',attestation});
 const manifest=assertNativeProfile(profile.manifestPath,profile.manifestSha256);
 checks.push({name:'frozen whitelist disables host tools, implicit Laya/MCP, credential fallback, telemetry and automatic loops',result:'PASS',disabled:manifest.disabled});
 await harness.close();harness=undefined;
 let exited=false;try{process.kill(attestation.pid,0);}catch(e){exited=e.code==='ESRCH';}
 if(!exited)throw Error('OWNED_RUNTIME_EXIT_NOT_PROVEN');
 assertNativeProfile(profile.manifestPath,profile.manifestSha256);
 checks.push({name:'SDK owned close reaps the attested runtime and preserves frozen profile files',result:'PASS',pid:attestation.pid});
 if(requests!==0||toolCalls!==0)throw Error('UNEXPECTED_REQUEST_WITHOUT_MODEL_PROMPT');
 checks.push({name:'handshake makes zero local model or tool requests; no vendor transport exists',result:'PASS',requests,toolCalls});
}catch(error){
 checks.push({name:'actual dedicated profile initialization',result:'FAIL',code:error.code??'PROFILE_RUNTIME_CHECK_FAILED',
  diagnostic:String(error.message??error).replaceAll(proxyBearer,'[REDACTED]').replaceAll(broker?.token??'UNUSED_BEARER','[REDACTED]').slice(0,4000)});process.exitCode=1;
}finally{
 try{await harness?.close();}catch{checks.push({name:'owned runtime close',result:'FAIL',code:'CLOSE_NOT_PROVEN'});process.exitCode=1;}
 await broker?.close();proxy.closeAllConnections();await new Promise(r=>proxy.close(r));
 const directory=resolve(root,'docs/native-runtime/evidence');mkdirSync(directory,{recursive:true});const output=resolve(directory,'profile-'+Date.now()+'.json');
 writeFileSync(output,JSON.stringify({schema:'dream-maker.actual-profile.v1',at:new Date().toISOString(),sdkCommit,evidenceClass:'ACTUAL_SDK_PROFILE_NO_MODEL_NOT_LIVE_AGENT',
  modelCalls:0,requests,toolCalls,profile,checks},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({checks:checks.map(({name,result,code})=>({name,result,code})),evidence:output}));
}
