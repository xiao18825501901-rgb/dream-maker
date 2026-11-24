// OFFLINE app-server fixture for read-only interrupted-history inspection.
import {appendFileSync} from 'node:fs';
import readline from 'node:readline';

const threadId=process.argv[3]??'OFFLINE_THREAD';
const turnId=process.argv[4]??'OFFLINE_TURN';
const requestLog=process.argv[5];
if(!requestLog)throw new Error('REQUEST_LOG_REQUIRED');

for await(const line of readline.createInterface({input:process.stdin})){
    const message=JSON.parse(line);
    if(message.id===undefined)continue;
    appendFileSync(requestLog,JSON.stringify({method:message.method,params:message.params??null})+'\n');
    const reply=result=>process.stdout.write(JSON.stringify({id:message.id,result})+'\n');
    if(message.method==='initialize'){
        reply({userAgent:'offline-history-fixture'});
    }else if(message.method==='thread/turns/list'){
        if(message.params?.threadId!==threadId)throw new Error('FOREIGN_THREAD');
        reply({data:[{id:turnId,status:'interrupted',error:null}],nextCursor:null});
    }else if(message.method==='thread/resume'){
        const params=message.params??{};
        if(Object.hasOwn(params,'environments'))throw new Error('THREAD_RESUME_ENVIRONMENTS_INVALID');
        if(params.threadId!==threadId||params.modelProvider!=='openai'||params.serviceTier!=='default'||
            params.approvalPolicy!=='never'||params.permissions!=='dream-maker-supervisor-data'||
            !Array.isArray(params.runtimeWorkspaceRoots)||params.runtimeWorkspaceRoots.length!==0||
            params.config?.permissions?.['dream-maker-supervisor-data']?.filesystem?.[':minimal']!=='read'||
            params.config?.permissions?.['dream-maker-supervisor-data']?.network?.enabled!==false){
            throw new Error('THREAD_RESUME_BINDING_INVALID');
        }
        reply({
            thread:{id:threadId,turns:[{id:turnId,status:'interrupted'}]},
            model:params.model,
            modelProvider:'openai',
            serviceTier:'default',
            cwd:params.cwd,
            approvalPolicy:'never',
            activePermissionProfile:{id:'dream-maker-supervisor-data',extends:null},
            sandbox:{type:'readOnly',networkAccess:false},
            runtimeWorkspaceRoots:[]
        });
    }else{
        process.stdout.write(JSON.stringify({id:message.id,error:{code:-32601,message:'OFFLINE_METHOD_DENIED'}})+'\n');
    }
}
