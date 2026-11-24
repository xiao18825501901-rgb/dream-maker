// Development-only real HTTP/browser fixture: isolated accounting, NO native role proof or provider calls.
// Never load the root native owner or its real developer ledger for a form-control test.
import {resolve} from 'node:path';
import {mkdirSync} from 'node:fs';
import {childEnv,DomainError} from '../../dist/server/security.js';
import {createApp} from '../../dist/server/http.js';
import {NativeBudget} from '../../dist/server/native-budget.js';
const allowed=childEnv();for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,allowed);
const root=resolve(import.meta.dirname,'../..'),data=resolve(root,'.runtime/revamp-20261101/onboarding-browser-data');
mkdirSync(data,{recursive:true});
const noNative=()=>{throw new DomainError('OFFLINE_BROWSER_NO_NATIVE_ROLES',409);};
const app=await createApp({root,data,configPath:resolve(data,'config.json'),product:'dreamflow',port:0,nativeOwnerBuilder:()=>{
 const budget=new NativeBudget(resolve(data,'isolated-budget.sqlite'),{scopeId:'W13_BROWSER_OFFLINE_NOT_LIVE',authorizationHash:'TEST_ONLY_NO_OWNER_APPROVAL',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2},()=>false);
 return {paidGuard:noNative,assertReady:noNative,executor:noNative,verify:noNative,async probeStatus(){return {roles:null,evidence:{},error:'OFFLINE_BROWSER_NO_NATIVE_ROLES'};},
  budgetStatus(){return {status:'HISTORY_ONLY',mode:'CAPPED',requests:budget.requests().length,maxRequests:0,byCurrency:budget.summary().byCurrency,userBudget:budget.userBudgetStatus()};},
  configureUserBudget(...args){return budget.configureUserBudget(...args);},maintenanceBusy(){return budget.summary().inFlight>0;},captureBudgetState(path){budget.captureState(path);return true;},async close(){budget.close();}};
}});
console.log(JSON.stringify({url:app.bootstrapUrl,origin:app.origin,product:'dreamflow',evidenceClass:'REAL_BROWSER_HTTP_WITH_ISOLATED_TEST_ACCOUNTING_NOT_LIVE'}));
let stopping=false;async function stop(){if(stopping)return;stopping=true;await app.close();process.exit(0);}process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
