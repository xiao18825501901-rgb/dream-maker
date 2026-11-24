// Explicit trusted-controller action. No SDK download, sign-in or budget reset.
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Settings} from '../dist/server/config.js';
import {Store} from '../dist/server/store.js';
import {NativeOwner} from '../dist/server/native-owner.js';
import {ModelProvider} from '../dist/server/providers/model.js';
import {ClashService,withCodexRoleProbeLease} from '../dist/server/clash-service.js';
import {redact,DomainError} from '../dist/server/security.js';
import {existsSync} from 'node:fs';
import {installDshControllerCredential} from '../dist/server/controller-dsh-credential.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [action,role]=process.argv.slice(2);
if(!['role','advance'].includes(action)||action==='role'&&!['planner1','planner2','executor','reviewer'].includes(role)||action==='advance'&&role)
    throw Error('USAGE: node scripts/probe-native.mjs role <planner1|planner2|executor|reviewer> OR advance');
const configPath=resolve(process.env.DM_CONFIG??resolve(root,'config/local.json'));
if(!existsSync(configPath)){
    console.log(JSON.stringify({status:'BLOCKED',code:'EXPLICIT_LOCAL_CONFIG_REQUIRED',projectAcceptance:'NOT_RUN'}));
    process.exit(1);
}
const settings=new Settings(configPath);
const credentials=installDshControllerCredential(settings.value.dsh);
process.once('exit',credentials.restore);
const data=resolve(process.env.DM_DATA??resolve(root,'.runtime'));
const store=new Store(resolve(data,'dream-maker.sqlite'));
const clash=new ClashService(()=>settings.value,resolve(data,'controller','clash-route'),
    observation=>{store.event(null,null,'network.routed-request',observation);});
const owner=new NativeOwner({root,store,getConfig:()=>settings.value,
    fetch:clash.fetch,fetchForRole:role=>clash.fetchForRole(role),
    childEnvironment:extra=>clash.childEnvironment(extra)});
const model=new ModelProvider(()=>settings.value,root,clash.jsonRequestForRole('planner1'),owner.paidGuard);
const controller=new AbortController();
const cancelled=()=>controller.abort();
process.once('SIGINT',cancelled);process.once('SIGTERM',cancelled);
try{
    if(action==='role'){
        const reference=await withCodexRoleProbeLease(
            clash,
            role,
            controller.signal,
            () => owner.probe(role,controller.signal,model)
        );
        console.log(redact({evidenceClass:'MINIMUM_ROLE_RESPONSE_NOT_PROJECT_ACCEPTANCE',role,reference}));
    }else{
        await owner.advanceProbes(model);
        console.log(JSON.stringify({budgetPhase:'REPRESENTATIVE',projectAcceptance:'NOT_RUN'}));
    }
}catch(error){
    console.log(JSON.stringify({status:'BLOCKED',code:error instanceof DomainError?error.code:'NATIVE_PROBE_UNAVAILABLE',projectAcceptance:'NOT_RUN'}));
    process.exitCode=1;
}finally{
    await owner.close();store.close();credentials.restore();process.removeListener('SIGINT',cancelled);process.removeListener('SIGTERM',cancelled);
}
