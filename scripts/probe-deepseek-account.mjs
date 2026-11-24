// Explicit official account GET only, never inference, deposits or raw auth logging.
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import {jsonFetch,registerCredentialEnv,within} from '../dist/server/security.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const endpoint='https://api.deepseek.com/user/balance';
export function summarizeAccount(response){
 const fail=()=>{throw Error('ACCOUNT_RESPONSE_UNVERIFIED');};
 if(!response||typeof response.is_available!=='boolean'||!Array.isArray(response.balance_infos)||!response.balance_infos.length||response.balance_infos.length>2)fail();
 const seen=new Set(),decimal=/^-?\d{1,18}(?:\.\d{1,8})?$/;
 const balances=response.balance_infos.map(row=>{
  if(!row||!['CNY','USD'].includes(row.currency)||seen.has(row.currency)||
   !['total_balance','granted_balance','topped_up_balance'].every(field=>typeof row[field]==='string'&&decimal.test(row[field])))fail();
  seen.add(row.currency);
  return{currency:row.currency,totalBalance:row.total_balance,grantedBalance:row.granted_balance,toppedUpBalance:row.topped_up_balance};
 });
 const cny=balances.find(row=>row.currency==='CNY');let micros=null;
 if(cny){const [whole,fraction='']=cny.totalBalance.replace(/^-/,'').split('.');
  const absolute=BigInt(whole)*1000000n+BigInt((fraction+'000000').slice(0,6));
  micros=cny.totalBalance.startsWith('-')?-absolute:absolute;
 }
 return{isAvailable:response.is_available,balances,cnyMicros:micros===null?null:micros.toString()};
}
async function main(){
 const [flag,name]=process.argv.slice(2);
 if(flag!=='--read-only-account'||!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name??'')||process.argv.length!==4)throw Error('EXPLICIT_ACCOUNT_READ_AND_ENV_NAME_REQUIRED');
 registerCredentialEnv(name);
 const report={schema:'dream-maker.deepseek-account-read.v1',at:new Date().toISOString(),method:'GET',endpoint,keyEnv:name,
  evidenceClass:'REAL_ACCOUNT_METADATA_NOT_MODEL_ACCEPTANCE',modelCalls:0,paidRequests:0,balanceValuesRecorded:false};
 let summary;
 try{
  if(!process.env[name])throw Error('SELECTED_CREDENTIAL_MISSING');
  summary=summarizeAccount(await jsonFetch(endpoint,{method:'GET',headers:{authorization:'Bearer '+process.env[name]},signal:AbortSignal.timeout(10000)},8192));
  Object.assign(report,{status:'READ_COMPLETED',isAvailable:summary.isAvailable,currencies:summary.balances.map(row=>row.currency),
   cnyBalanceAtLeastScope:summary.cnyMicros!==null&&BigInt(summary.cnyMicros)>=50000000n,
   cnyBalanceAtLeastDshReservation:summary.cnyMicros!==null&&BigInt(summary.cnyMicros)>=2099200n});
 }catch(error){report.status='BLOCKED';report.code=/^UPSTREAM_HTTP_\d{3}$/.test(error.code??'')?error.code:
  ['ACCOUNT_RESPONSE_UNVERIFIED','SELECTED_CREDENTIAL_MISSING'].includes(error.message)?error.message:'ACCOUNT_METADATA_UNAVAILABLE';process.exitCode=1;}
 const directory=within(root,'docs/account-read/evidence');mkdirSync(directory,{recursive:true});
 const output=resolve(directory,'account-'+Date.now()+'.json');writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({report,summary,evidence:output},null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
