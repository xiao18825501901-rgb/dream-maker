// Official model-list GET only. No credentials, auth response, prompts or inference logged.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { jsonFetch } from '../dist/server/security.js';
const [output, name] = process.argv.slice(2);
if (!output || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name ?? '')) throw Error('EXPLICIT_OUTPUT_AND_ENV_NAME_REQUIRED');
const report = { schema:'dream-maker.deepseek-api-metadata.v1',recordedAt:new Date().toISOString(),
    evidenceClass:'REAL_API_METADATA_NOT_DSH_MODEL_RESPONSE',modelTurns:0,paidInferenceRequests:0,
    provider:'deepseek-official',baseUrl:'https://api.deepseek.com',requestedModel:'deepseek-flash',
    keyEnv:name,keyPresent:!!process.env[name],sdkRouteVerified:false,result:null };
try {
    if (!process.env[name]) throw Object.assign(Error(),{code:'SELECTED_CREDENTIAL_NOT_PRESENT'});
    const list=await jsonFetch('https://api.deepseek.com/models',{headers:{authorization:'Bearer '+process.env[name]},signal:AbortSignal.timeout(10000)});
    report.result={status:'PASS',requestedModelListed:Array.isArray(list.data)&&list.data.some(m=>m.id==='deepseek-flash'),
        listedFlashIds:Array.isArray(list.data)?list.data.filter(m=>typeof m.id==='string'&&/^deepseek[-a-z0-9.]*flash$/.test(m.id)).map(m=>m.id):[]};
} catch (e) { report.result={status:'BLOCKED',code:e.code??'MODEL_METADATA_UNAVAILABLE'}; }
mkdirSync(dirname(resolve(output)),{recursive:true});
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(report));
