// No inference, raw authentication response, key value, or global proxy change.
import { writeFileSync } from 'node:fs';
const [output,name]=process.argv.slice(2);
if(!output||!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name??'')) throw Error('EXPLICIT_OUTPUT_ENV_REQUIRED');
const report={schema:'dream-maker.openai-access-diagnostic.v1',recordedAt:new Date().toISOString(),modelCalls:0,results:[]};
for(const authenticated of [false,true]) {
    try {
        const r=await fetch('https://api.openai.com/v1/models',{redirect:'error',headers:authenticated?{authorization:'Bearer '+process.env[name]}:{},signal:AbortSignal.timeout(10000)});
        let category='NOT_DISCLOSED';
        if(!r.ok&&r.headers.get('content-type')?.includes('application/json')) {
            const raw=await r.json();
            const code=raw.error?.code;
            if(['unsupported_country_region_territory','invalid_api_key','insufficient_permissions','ip_not_authorized','rate_limit_exceeded'].includes(code)) category=code;
        } else await r.body?.cancel();
        report.results.push({authenticated,status:r.status,errorCategory:category,server:r.headers.get('server')});
    } catch { report.results.push({authenticated,status:'NETWORK_FAILURE'}); }
}
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(report));
