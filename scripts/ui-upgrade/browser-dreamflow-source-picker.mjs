// Real Chrome, isolated synthetic DreamFlow server and metadata-only catalog.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {cp,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../../dist/server/http.js';
import {NativeOwner} from '../../dist/server/native-owner.js';
import {childEnv,hash} from '../../dist/server/security.js';
const root=resolve(import.meta.dirname,'../..'),suite=resolve('F:/DreamMakerSuite');
assert.equal(root,join(suite,'worktrees','kimi-p1-v1'));
const env=childEnv();for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,env);
const {chromium}=await import(pathToFileURL(join(suite,'runtime/browser-tools/node_modules/playwright/index.mjs')).href);
const parent=join(root,'.runtime','test-temp');await mkdir(parent,{recursive:true});
const dir=await mkdtemp(join(parent,'chrome-picker-')),data=join(dir,'.runtime');
await mkdir(join(dir,'config'),{recursive:true});await mkdir(data,{recursive:true});
for(const sub of ['web','shared'])await cp(join(root,'dist',sub),join(dir,'dist',sub),{recursive:true});
const pin=async(name,obj)=>{const path=join(dir,name),bytes=JSON.stringify(obj);await writeFile(path,bytes);return {path,sha256:hash(bytes)};};
const ids=['first','second'].map(id=>({provider:'vendor-a',authentication:'api_key',authRef:'auth-'+id,accountRef:'account-'+id}));
const model='org/physical-two',catalogId='vendor-a/'+model;
const sources=await pin('sources.json',{schema:'dream-maker.custom-account-sources.v2',accounts:ids.map((id,i)=>({...id,secretEnv:'DM_CUSTOM_SYNTH_PICKER_'+i+'_API_KEY',capabilities:[{model,protocol:'openai-responses',endpoint:'https://offline.invalid/v1/responses'}]}))});
const authority=await pin('authority.json',{scopeId:'OFFLINE_BROWSER_PICKER',authorizationHash:'OFFLINE_AUTH',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2});
await writeFile(join(dir,'config/native-owner.local.json'),JSON.stringify({schema:'dream-maker.native-owner.v1',scopeRoot:dir,authority,customAccountSources:sources,prices:{},maxOutputTokens:128,maxRequests:8}));
const catalogRequests=[];
const catalog=createServer((req,res)=>{catalogRequests.push([req.method,req.url]);if(req.method!=='GET'||req.url!=='/v1/models'){res.writeHead(404).end();return;}
 res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({object:'list',data:[catalogId,'group/alias'].map(id=>({id,object:'model',owned_by:'vendor-a',native_endpoints:['/v1/responses']}))}));});
await new Promise(resolve=>catalog.listen(0,'127.0.0.1',resolve));
let app,browser,secretReads=0,providerCalls=0,paidAttempts=0,step='start';const requests=[],external=[];
try{
 app=await createApp({root:dir,data,configPath:join(data,'config.json'),port:0,product:'dreamflow',desktopMagpieCatalogPort:catalog.address().port,paidRequestGuard:()=>{paidAttempts++;throw Error('UNEXPECTED_PAID_REQUEST');},nativeOwnerBuilder:ctx=>new NativeOwner({...ctx,getSecret:()=>{secretReads++;throw Error('UNEXPECTED_SECRET_READ');},fetch:async()=>{providerCalls++;throw Error('UNEXPECTED_PROVIDER_CALL');}})});
 const project=app.interviews.create('离线账户选择验证','本机测试','demo');
 browser=await chromium.launchPersistentContext(join(dir,'chrome-profile'),{executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,viewport:{width:1440,height:1040},args:['--disable-background-networking','--no-first-run','--disk-cache-dir='+join(dir,'cache')],env:{...env,TEMP:dir,TMP:dir}});
 await browser.route('**/*',async route=>{if(new URL(route.request().url()).origin!==app.origin){external.push(true);await route.abort();}else await route.continue();});
 const page=await browser.newPage();page.setDefaultTimeout(15000);
 page.on('response',resp=>{const {pathname}=new URL(resp.url());if(pathname.startsWith('/api/'))requests.push({method:resp.request().method(),path:pathname.replace(project.id,'[project]'),status:resp.status()});});
 const action=id=>page.locator('[data-action="'+id+'"]'),field=name=>page.locator('[name="'+name+'"]'),submit=()=>page.locator('#custom-flow-form button[type="submit"]').click();
 const waitStep=n=>page.locator('#custom-step-title').filter({hasText:'第 '+n+' 步'}).waitFor();
 step='authenticate';await page.goto(app.bootstrapUrl);await page.locator('#app[aria-busy="false"]').waitFor();await page.goto(app.origin+'/?project='+project.id);await action('custom-configure').click();await waitStep(1);
 step='choose second identity';const identitiesReply=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/account-sources');await action('custom-read-account-identities').click();const identitiesResponse=await identitiesReply;assert.deepEqual(await identitiesResponse.json(),{sources:ids});await field('account-provider-0').selectOption('vendor-a');await field('account-auth-0').selectOption('api_key');
 const candidates=action('custom-attach-account-identity');await candidates.nth(1).waitFor();assert.deepEqual(await candidates.evaluateAll(rows=>rows.map(row=>[row.dataset.source,row.dataset.sourceAccount])),ids.map(x=>[x.authRef,x.accountRef]));await candidates.nth(1).click();assert.equal(await candidates.nth(1).isDisabled(),true);
 step='choose physical catalog and harnesses';await submit();await waitStep(2);await action('custom-read-models').click();const harnesses=['codex','pi','cline'];
 for(const [i,h] of harnesses.entries()){
  await field('role-runtime-'+i).selectOption(h);const selector=field('role-catalog-'+i);assert.equal(await selector.locator('option').filter({hasText:catalogId}).textContent(),catalogId+' · '+({codex:'openai-responses',pi:'openai-responses（Pi 原生工具协议，需核验 Magpie 构建与账户）',cline:'openai-responses（经 Magpie 转换，需核验账户与构建）'}[h]));await selector.selectOption(catalogId);assert.equal(await field('role-model-'+i).inputValue(),model);assert.equal(await field('role-account-'+i).inputValue(),ids[1].authRef);
 }
 step='reopen local draft';await action('custom-close').click();await page.reload();await action('custom-configure').click();await waitStep(2);
 const checkRoles=async()=>{for(const [i,h] of harnesses.entries()){assert.equal(await field('role-account-'+i).inputValue(),ids[1].authRef);assert.equal(await field('role-model-'+i).inputValue(),model);assert.equal(await field('role-runtime-'+i).inputValue(),h);}};
 await checkRoles();step='confirm profile';await submit();await waitStep(3);await submit();await waitStep(4);await field('customConsent').check();
 const saved=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('flow-profile'));await submit();const response=await saved;assert.ok(response.ok());
 const payload=await response.json(),configuration=payload.current.configuration;assert.deepEqual(configuration.accounts.map(({provider,authentication,authRef,accountRef})=>({provider,authentication,authRef,accountRef})),[ids[1]]);
 const roles=[configuration.roles.planner2,...configuration.roles.executors,configuration.roles.reviewer].map(({id,authRef,accountRef,model,runtime})=>({id,authRef,accountRef,model:model.id,harness:runtime}));
 for(const [i,role] of roles.entries()){assert.equal(role.model,model);assert.equal(role.harness,harnesses[i]);assert.equal(role.authRef,ids[1].authRef);assert.equal(role.accountRef,ids[1].accountRef);}
 step='reopen saved profile';await page.reload();await action('custom-configure').click();await waitStep(1);await submit();await waitStep(2);await checkRoles();
 const ledger=new DatabaseSync(join(data,'controller/native-budget.sqlite'),{readOnly:true});let paidLedgerRows;try{paidLedgerRows=ledger.prepare('SELECT count(*) AS n FROM requests').get().n;}finally{ledger.close();}
 const modelAttempts=app.store.db.prepare("SELECT count(*) AS n FROM records WHERE kind='ModelAttempt'").get().n;
 assert.deepEqual([paidLedgerRows,modelAttempts,secretReads,providerCalls,paidAttempts,external.length],[0,0,0,0,0,0]);assert.deepEqual(catalogRequests,[['GET','/v1/models']]);
 const report={scope:'OFFLINE_SYNTHETIC_CHROME',browser:browser.browser()?.version(),result:'PASS',identities:ids,selected:ids[1],catalogId,roles,reopenedLocalDraft:true,reopenedSavedProfile:true,revision:payload.current.revision,requests,catalogRequests,paidLedgerRows,modelAttempts,secretReads,providerCalls,paidAttempts,externalRequests:external.length};
 const path=join(dir,'redacted-result.json');await writeFile(path,JSON.stringify(report,null,2));console.log('PASS '+path);
}catch(error){console.error('Stage: '+step,JSON.stringify(requests.slice(-7)));throw error;}finally{try{await browser?.close();}finally{try{await app?.close();}finally{await new Promise(resolve=>catalog.close(resolve));}}}
