// Owned browser scenario only: original Store/Engine, fixed Demo, no native owner or credentials.
import {resolve} from 'node:path';
import {mkdirSync,cpSync,existsSync,readFileSync} from 'node:fs';
import {createApp} from '../../dist/server/http.js';
import {childEnv,choose,DomainError} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';
import {UserPlans} from '../../dist/server/user-plans.js';
import {acquireServerLock} from '../../dist/server/server-lock.js';
import {releaseFailedStartupLock} from '../../dist/server/local-product.js';
import {fixtureProjectPlan} from '../fixtures/full-project-plan.mjs';
const source=choose(process.argv[2],['legacy','current']),root=resolve(import.meta.dirname,'../..'),data=resolve(root,'.runtime/revamp-20261101/managed-data-browser-data');
const clean=childEnv();for(const name of Object.keys(process.env))delete process.env[name];Object.assign(process.env,clean);mkdirSync(data,{recursive:true});
let controllerRoot=root;
if(source==='legacy'){
 controllerRoot=resolve(data,'legacy-controller');
 if(!existsSync(controllerRoot)){
  mkdirSync(resolve(controllerRoot,'examples'),{recursive:true});cpSync(resolve(root,'tests/fixtures/legacy-study-board'),resolve(controllerRoot,'examples/study-board'),{recursive:true});
  for(const name of ['dist/web','dist/shared','prompts'])cpSync(resolve(root,name),resolve(controllerRoot,name),{recursive:true});
  mkdirSync(resolve(controllerRoot,'scripts'));cpSync(resolve(root,'scripts/verify-board.mjs'),resolve(controllerRoot,'scripts/verify-board.mjs'));
 }
 if(treeHash(resolve(controllerRoot,'examples/study-board'))!=='6fabb72ff9ba50d02d57a01a8c3bcd2590fa1281689dbbde55f33cee44787f72')throw Error('LEGACY_FIXTURE_SOURCE_CHANGED');
 // Existing fixture files are never refreshed or overwritten during a rerun.
 for(const name of ['dist/web/ui.js','dist/web/preview.js','dist/web/managed-data-view.js'])if(!readFileSync(resolve(controllerRoot,name)).equals(readFileSync(resolve(root,name))))throw Error('LEGACY_FIXTURE_UI_STALE');
}
const lock=acquireServerLock(resolve(data,'server.lock'),{dataDir:data}),denied=()=>{throw new DomainError('FIXED_DEMO_BROWSER_NO_NATIVE_ROLES',409);};let app;
try{app=await createApp({root:controllerRoot,data,configPath:resolve(data,'config.json'),port:0,demoDelayMs:0,nativeExecution:{assertReady:denied,executor:denied,verify:denied,async close(){}}});}catch(error){releaseFailedStartupLock(lock,error);throw error;}
if(!app.store.projects().length)new UserPlans(app.store).create({schema:'dream-maker.user-plan.v1',name:'数据迁移与恢复 · 固定样例核验',mode:'demo',plan:fixtureProjectPlan([{id:'R1',text:'仅核验固定 Demo 的数据迁移、独立保存与恢复，不是产品 Live 验收。',origin:'USER',sources:['USER_DOCUMENT']}])},'OFFLINE_BROWSER_FIXTURE_NOT_OWNER_APPROVAL');
console.log(JSON.stringify({url:app.bootstrapUrl,origin:app.origin,source,scope:'FIXED_DEMO_BROWSER_ONLY',nativeOwner:false}));
let stopping=false;async function stop(){if(stopping)return;stopping=true;try{await app.close();lock.release();process.exit(0);}catch(error){console.error(error?.code??'FIXTURE_CLOSE_UNCERTAIN');}}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
