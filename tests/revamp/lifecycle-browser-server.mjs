// Dedicated browser fixture, explicit fixed Demo plan and no native owner/account/model authority.
import {resolve} from 'node:path';
import {mkdirSync} from 'node:fs';
import {childEnv,choose,DomainError} from '../../dist/server/security.js';
import {createApp} from '../../dist/server/http.js';
import {UserPlans} from '../../dist/server/user-plans.js';
import {acquireServerLock} from '../../dist/server/server-lock.js';
import {releaseFailedStartupLock} from '../../dist/server/local-product.js';
import {fixtureProjectPlan} from '../fixtures/full-project-plan.mjs';
const product=choose(process.argv[2],['dream-maker','dreamflow']),root=resolve(import.meta.dirname,'../..'),data=resolve(root,'.runtime/revamp-20261101/lifecycle-browser-'+product+'-data');
const clean=childEnv();for(const name of Object.keys(process.env))delete process.env[name];Object.assign(process.env,clean);mkdirSync(data,{recursive:true});
const lock=acquireServerLock(resolve(data,'server.lock'),{dataDir:data}),denied=()=>{throw new DomainError('OFFLINE_BROWSER_NO_NATIVE_ROLES',409);};let app;
try{app=await createApp({root,data,configPath:resolve(data,'config.json'),product,port:0,demoDelayMs:10000,nativeExecution:{assertReady:denied,executor:denied,verify:denied,async close(){}}});}
catch(error){releaseFailedStartupLock(lock,error);throw error;}
if(!app.store.projects().length)new UserPlans(app.store).create({schema:'dream-maker.user-plan.v1',name:'暂停与恢复 · Demo 核验',mode:'demo',plan:fixtureProjectPlan([{id:'R1',text:'仅核验固定 Demo 的暂停与已有方案保留；不是实际产品项目。',origin:'USER',sources:['USER_DOCUMENT']}])},'OFFLINE_BROWSER_FIXTURE_NOT_OWNER_APPROVAL');
console.log(JSON.stringify({url:app.bootstrapUrl,origin:app.origin,product,dataClass:'ISOLATED_FIXED_DEMO_NOT_LIVE'}));
let stopping=false;async function stop(){if(stopping)return;stopping=true;try{await app.close();lock.release();process.exit(0);}catch(error){console.error(error?.code??'FIXTURE_CLOSE_UNCERTAIN');}}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
