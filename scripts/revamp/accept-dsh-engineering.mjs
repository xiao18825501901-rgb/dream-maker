// Explicit operator action. No Codex login, user project approval, provider fallback or second ledger.
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,existsSync,lstatSync} from 'node:fs';
import {Settings} from '../../dist/server/config.js';
import {Store} from '../../dist/server/store.js';
import {Engine} from '../../dist/server/engine.js';
import {NativeOwner} from '../../dist/server/native-owner.js';
import {LayaBridge} from '../../dist/server/laya.js';
import {nativeReadiness} from '../../dist/server/providers/dsh.js';
import {dshEngineeringContract} from '../../dist/server/flow/dsh-engineering.js';
import {installDshControllerCredential} from '../../dist/server/controller-dsh-credential.js';
import {DomainError,hash} from '../../dist/server/security.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),args=process.argv.slice(2);
const confirmed=args[0]==='--confirm',checking=args.length===1&&args[0]==='--check',operation=confirmed&&args.length===3&&args[1]==='--operation'?args[2]:null;
if(!checking&&!operation)throw Error('USAGE: node scripts/revamp/accept-dsh-engineering.mjs --check OR --confirm --operation <unique-reference>');
const settings=new Settings(join(root,'config/local.json')),store=new Store(join(root,'.runtime/dream-maker.sqlite')),owner=new NativeOwner({root,store,getConfig:()=>settings.value}),engine=new Engine(store,new LayaBridge(()=>settings.value),()=>settings.value,root,join(root,'.runtime'),0,owner);
const controller=new AbortController(),cancel=()=>controller.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);let credentials;
try{
 const readiness=nativeReadiness(settings.value);if(!readiness.ok)throw new DomainError('NATIVE_INTEGRATION_BLOCKED',409);
 const operator=JSON.parse(readFileSync(join(root,'config/native-owner.local.json'),'utf8')),price=JSON.parse(readFileSync(operator.prices.executor.path,'utf8'));
 if(hash(readFileSync(operator.prices.executor.path))!==operator.prices.executor.sha256||price.provider!=='deepseek-official'||price.model!=='deepseek-flash'||price.currency!=='CNY'||Date.parse(price.expiresAt)<=Date.now())throw new DomainError('NATIVE_PRICE_ROUTE_MISMATCH',409);
 const contract=dshEngineeringContract(),perRequestMicros=Math.ceil((price.maxInputTokens*price.inputMissMicrosPerMillion+operator.maxOutputTokens*price.outputMicrosPerMillion)/1e6);
 if(perRequestMicros*contract.maxRequests>contract.maxReservedMicros)throw new DomainError('ENGINEERING_BUDGET_COST_LIMIT',409);
 const preparation=owner.dshEngineeringPreparation();
 if(checking)console.log(JSON.stringify({status:'LOCAL_PREREQUISITES_ONLY',preparation,readiness:'PASS',maxRequests:contract.maxRequests,maximumReservedCny:perRequestMicros*contract.maxRequests/1e6,codexOAuth:'NOT_REQUESTED',modelCalls:0}));
 else{
  credentials=installDshControllerCredential(settings.value.dsh);
  const report=await engine.runDshEngineeringAcceptance(operation,true,controller.signal),reportPath=resolve(report.workspace,'../report.json'),serialized=JSON.stringify(report,null,2);
  if(existsSync(reportPath)){
   const info=lstatSync(reportPath);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>2000000||hash(readFileSync(reportPath))!==hash(serialized))throw new DomainError('ENGINEERING_ACCEPTANCE_RESULT_CHANGED',409);
  }else writeFileSync(reportPath,serialized,{flag:'wx'});
  console.log(JSON.stringify({status:report.status,acceptanceId:report.acceptanceId,workspace:report.workspace,sourceHash:report.sourceHash,report:reportPath,requests:report.stage.ledgerRequestIds.length,verifiedCases:report.verification.cases.length,purpose:report.purpose,fourRoleLive:report.fourRoleLive,reviewer:report.reviewer}));
 }
}catch(error){console.log(JSON.stringify({status:'BLOCKED_OR_FAILED',code:error instanceof DomainError?error.code:'ENGINEERING_ACCEPTANCE_UNAVAILABLE',codexOAuth:'NOT_REQUESTED',fourRoleLive:'NOT_RUN'}));process.exitCode=1;}
finally{try{await engine.close();}finally{store.close();credentials?.restore();process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}}
