// Actual pinned DSH registry + native file implementation + WSL, WITHOUT an LLM session.
import { mkdirSync,mkdtempSync,writeFileSync,readFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createExecutorTools } from '../../dist/server/executor-tools.js';
import { startToolBroker } from '../../dist/server/tool-broker.js';
import { WslSandbox } from '../../dist/server/wsl-sandbox.js';
import { Store } from '../../dist/server/store.js';
import { defaults } from '../../dist/server/config.js';
import { Interviews } from '../../dist/server/interview.js';
import { LayaBridge } from '../../dist/server/laya.js';
import { ModelProvider } from '../../dist/server/providers/model.js';
import { hash,id,childEnv } from '../../dist/server/security.js';
import { apply as installProductionPlugin,TOOL_NAMES } from '../../adapters/dsh-tools-plugin.mjs';
import { toolClient } from '../../adapters/dsh-tool-client.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(process.argv[2]!=='--actual-sdk-no-model')throw Error('EXPLICIT_ACTUAL_SDK_NO_MODEL_CHECK_REQUIRED');
const archon='C:/Users/Hp/Documents/Archon_Astra_DSH_Source_Package/Archon_Astra_DSH_Source_Package';
const dsh=resolve(archon,'upstream/deepseek-harness'),sdk=resolve(dsh,'packages/sdk/client');
const commit=execFileSync('git',['-C',dsh,'rev-parse','HEAD'],{env:childEnv(),encoding:'utf8'}).trim();
if(commit!=='4878cdabd87d4041bdaff61d04c966883b9fd07a')throw Error('DSH_SOURCE_PIN_CHANGED');
const require=createRequire(resolve(sdk,'package.json'));
const imports={'@deepseek-ai/cordis':require.resolve('@deepseek-ai/cordis'),
    '@deepseek-ai/dsh-tools':resolve(dsh,'packages/core/tools/lib/index.js'),
    '@deepseek-ai/dsh-system-prompt':resolve(dsh,'packages/core/system-prompt/lib/index.js')};
const [cordis,toolSdk,prompts]=await Promise.all(Object.values(imports).map(path=>import(pathToFileURL(path).href)));
const directory=resolve(root,'.runtime/dsh-tool-checks');mkdirSync(directory,{recursive:true});const data=mkdtempSync(resolve(directory,'actual-'));
const store=new Store(resolve(data,'controller.sqlite')),config=structuredClone(defaults),checks=[];
let ctx,broker;
try{
    const interview=new Interviews(store,new ModelProvider(()=>config,root),new LayaBridge(()=>config),()=>config);
    const p=interview.create('实际SDK工具安全检查','测试工具扩展，不调用模型。','demo');await interview.finish(p.id,'',false);
    const pp=store.project(p.id),spec=store.spec(pp.specId);interview.approve(p.id,spec.hash);
    const rid=id('run'),workspace=resolve(data,'source');mkdirSync(workspace);
    // Explicit controller safety-test run, not a promoted native audit or genuine project.
    const now=new Date().toISOString();const run={id:rid,projectId:p.id,mode:'demo',version:1,specId:spec.id,specHash:spec.hash,configFingerprint:hash(config),state:'IMPLEMENTING',phase:'IMPLEMENTING',repairCount:0,maxRepairs:2,calls:0,maxCalls:30,createdAt:now,updatedAt:now,workspace,treeHash:null,tasks:[],findings:[],plan:null,verification:null,review:null,artifacts:[],reason:null,failedFingerprints:[],attempt:0,demoFault:false,maxSeconds:600,usage:[],sessions:{}};
    store.insertRun(run);store.acquire(p.id,rid);store.approve(p.id,spec.hash,'BUILD');
    const modulePath=resolve(archon,'dist/provider/file-tools.js'),io=resolve(archon,'dist/core/io.js');
    const binding={modulePath,dependencies:[modulePath,io].map(path=>({path,sha256:hash(readFileSync(path))})),readPaths:['main.mjs','src'],writePaths:['main.mjs','src']};
    const controller=await createExecutorTools(store,()=>config,rid,binding,new WslSandbox(root));broker=await startToolBroker(controller);
    ctx=new cordis.Context();await ctx.plugin(prompts.default);await ctx.plugin(toolSdk.default,{mode:'native',maxParallelSubCalls:1});
    const clientPath=resolve(data,'tool-client.json');
    const clientConfig=Buffer.from(JSON.stringify({schema:'dream-maker.dsh-tool-client.v1',sdkCommit:commit,sdkToolsModule:imports['@deepseek-ai/dsh-tools'],toolUrl:broker.url,dependencies:Object.values(imports).map(path=>({path,sha256:hash(readFileSync(path))}))}));
    writeFileSync(clientPath,clientConfig);
    process.env.DM_DSH_TOOL_CLIENT_CONFIG=clientPath;process.env.DM_DSH_TOOL_CLIENT_SHA256=hash(clientConfig);process.env.DM_TOOL_PROXY_TOKEN=broker.token;
    await installProductionPlugin(ctx);
    const roster=()=>ctx.tools.schemas().map(s=>s.name).sort();
    if(JSON.stringify(roster())!==JSON.stringify([...TOOL_NAMES].sort()))throw Error('ACTUAL_ROSTER_MISMATCH');
    checks.push({name:'actual Cordis/DSH ToolRuntime registers precisely five guarded tools',result:'PASS',roster:roster(),imports});
    const signal=new AbortController().signal;
    async function call(name,args){const result=await ctx.tools.execute({signal,callId:id('tool_call'),name,arguments:args});if(result.isError)throw Error(JSON.stringify(result.content));return JSON.parse(result.value.text);}
    await call('desk_write',{path:'main.mjs',content:"process.stdout.write('42\\n');\n",expected_sha:''});
    const read=await call('desk_read',{path:'main.mjs'});if(read.sha256!==hash(read.content))throw Error('SDK_READ_HASH_MISMATCH');
    const exec=await call('desk_run',{runtime:'node',entry:'main.mjs',args:[],stdin:''});
    if(exec.execution.status!=='EXECUTED'||exec.execution.exitCode!==0||exec.execution.stdout!=='42\n')throw Error('SDK_OS_ROUTE_FAILED');
    checks.push({name:'actual SDK write/read then native sandbox command returns real42',result:'PASS',execution:exec.execution});
    await call('desk_edit',{path:'main.mjs',old_text:'42',new_text:'43',expected_sha:read.sha256});
    const repaired=await call('desk_run',{runtime:'node',entry:'main.mjs',args:[],stdin:''});if(repaired.execution.stdout!=='43\n')throw Error('SDK_EDIT_OR_EXECUTION_FAILED');
    checks.push({name:'actual SDK edit uses observed SHA and changed program executes in WSL',result:'PASS',execution:repaired.execution});
    ctx.tools.register(toolSdk.defineTool({name:'unsafe_host_shell',description:'Safety canary that MUST NOT run',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>{throw Error('UNEXPECTED_HOST_TOOL_BODY');}}));
    const denied=await ctx.tools.execute({signal,callId:id('tool_call'),name:'unsafe_host_shell',arguments:{}});if(!denied.isError)throw Error('MONOTONIC_GUARD_FAILED');
    checks.push({name:'later native tool registration cannot bypass monotonic guard',result:'PASS'});
    const foreign=await fetch(broker.url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+broker.token,origin:'http://localhost:1'},body:JSON.stringify({name:'desk_read',args:{path:'main.mjs'}})});if(foreign.status!==403)throw Error('BROWSER_ORIGIN_NOT_DENIED');
    store.release(p.id,rid);
    const lost=await ctx.tools.execute({signal,callId:id('tool_call'),name:'desk_read',arguments:{path:'main.mjs'}});if(!lost.isError)throw Error('LEASE_LOSS_NOT_DENIED');
    checks.push({name:'foreign Origin and lost writer lease denied in actual SDK/broker path',result:'PASS'});
}catch(error){checks.push({name:'actual SDK no-model sequence',result:'FAIL',code:error.code??error.message});process.exitCode=1;}
finally{
    delete process.env.DM_DSH_TOOL_CLIENT_CONFIG;delete process.env.DM_DSH_TOOL_CLIENT_SHA256;delete process.env.DM_TOOL_PROXY_TOKEN;
    await ctx?.fiber.dispose();await broker?.close();store.close();
    const evidence=resolve(root,'docs/native-tools/evidence');mkdirSync(evidence,{recursive:true});const output=resolve(evidence,'actual-sdk-'+Date.now()+'.json');
    writeFileSync(output,JSON.stringify({schema:'dream-maker.actual-dsh-tools.v1',at:new Date().toISOString(),dshCommit:commit,evidenceClass:'ACTUAL_SDK_REGISTRY_AND_OS_NO_MODEL_NOT_LIVE_AGENT',modelCalls:0,checks},null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({checks:checks.map(({name,result,code})=>({name,result,code})),evidence:output}));
}
