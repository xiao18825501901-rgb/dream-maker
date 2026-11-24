// OFFLINE protocol fixture. This is NOT Codex and never contacts a model.
import readline from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
const mode=process.argv[2]??'success';let reads=0;
const thread = 'fixture-thread-' + process.pid;
const notify=(method,params)=>process.stdout.write(JSON.stringify({method,params})+'\n');
const quota=()=>({ordinaryUsageAllowed:mode==='quota-null'?null:mode!=='quota-denied',rateLimits:{spendControlReached:mode==='spend-unknown'?null:mode==='spend-control',credits:mode==='credits-unknown'?null:{hasCredits:mode==='paid-credits',unlimited:mode==='unlimited-credits'}},rateLimitsByLimitId:mode==='bucket-denied'?{codex:{spendControlReached:true,credits:{hasCredits:false,unlimited:false}}}:null});
for await (const line of readline.createInterface({ input: process.stdin })) {
    const m = JSON.parse(line);
    if(m.id!==undefined)appendFileSync('codex-fixture-requests.jsonl',JSON.stringify({method:m.method,...(['thread/start','turn/start'].includes(m.method)?{environments:m.params.environments,runtimeWorkspaceRoots:m.params.runtimeWorkspaceRoots,features:m.params.config?.features,outputSchema:m.params.outputSchema}:{} ),...(m.method==='thread/start'?{modelProvider:m.params.modelProvider}:{} )})+'\n');
    const reply = v => process.stdout.write(JSON.stringify({ id: m.id, result: v }) + '\n');
    if (m.method === 'initialize') {
        if(mode==='initialize-slow')await new Promise(resolve=>setTimeout(resolve,11000));
        if(mode!=='initialize-stall')reply({ userAgent: 'offline-fixture' });
    }
    else if(m.method==='account/read'){
        if(mode==='auth-refusal'){process.stdout.write(JSON.stringify({id:m.id,error:{code:-32600,message:'refresh token expired; 403 Forbidden; Bearer OFFLINE_PRIVATE_TOKEN'}})+'\n');continue;}
        if(mode!=='account-stall')reply({account:mode==='gateway-no-local-account'?null:{type:mode==='api-account'?'apiKey':'chatgpt'},requiresOpenaiAuth:false});
    }
    else if(m.method==='model/list')reply({data:[{id:'fixture-id',model:mode==='model-not-listed'?'a-different-model':'fixture-not-a-model',displayName:'fixture-private'}],nextCursor:null});
    else if(m.method==='account/rateLimits/read'){reads++;reply(mode==='second-read-denied'&&reads>1?{...quota(),ordinaryUsageAllowed:false}:quota());}
    else if (m.method === 'thread/start') {
        // K07 contract: a named permission profile, never the legacy sandbox field.
        if (typeof m.params.permissions !== 'string' || !m.params.permissions || m.params.sandbox !== undefined || m.params.approvalPolicy !== 'never')
            throw new Error('Wrong permission-profile contract');
        const definition=m.params.config?.permissions?.[m.params.permissions];
        const dataOnly=m.params.permissions==='dream-maker-supervisor-data';
        if(dataOnly ? (definition?.extends!==undefined||JSON.stringify(definition.filesystem)!==JSON.stringify({':minimal':'read'})||definition.network?.enabled!==false||!Array.isArray(m.params.environments)||m.params.environments.length||!Array.isArray(m.params.runtimeWorkspaceRoots)||m.params.runtimeWorkspaceRoots.length||m.params.config?.features?.stable_environment_tools!==false||m.params.config?.features?.multi_agent!==false||m.params.config?.project_doc_max_bytes!==0||m.params.allowProviderModelFallback!==false) : (definition?.extends!==':read-only'||definition.filesystem?.[':root']!=='deny'||definition.filesystem?.[':workspace_roots']?.['.']!=='read'||definition.network?.enabled!==false))
            throw new Error('Missing pinned controller policy');
        // Actual 0.162.0 experimental wire: id/extends; there is no source field.
        const profile = mode === 'profile-null' ? null
            : mode === 'profile-wrong' ? { id: 'an-unapproved-profile', extends: ':read-only' }
            : mode === 'profile-parent-missing' ? { id: m.params.permissions, extends: null }
            : { id: m.params.permissions, extends: mode==='data-parent'?':read-only':dataOnly?null:':read-only' };
        reply({thread:{id:mode==='malformed-thread'?{}:thread,...(dataOnly?{environments:mode==='data-environment'?[{environmentId:'local'}]:[]}:{} )},...(dataOnly?{runtimeWorkspaceRoots:mode==='data-roots'?[process.cwd()]:[]}:{}),model:mode==='wrong-model'?'different':m.params.model,modelProvider:mode==='wrong-provider'?'unapproved':(m.params.modelProvider??'openai'),serviceTier:mode==='paid-tier'?'fast':'default',cwd:mode==='wrong-cwd'?process.cwd()+'/foreign':process.cwd(),approvalPolicy:mode==='wrong-approval'?'on-request':'never',activePermissionProfile:profile,sandbox:{type:mode==='sandbox-writable'?'workspaceWrite':'readOnly',networkAccess:mode==='sandbox-network'}});
    }
    else if (m.method === 'turn/start') {
        if(mode==='rpc-deep-refusal'){
            process.stdout.write('{"id":'+m.id+',"error":{"data":'+'['.repeat(16000)+'null'+']'.repeat(16000)+'}}\n');continue;
        }
        if(mode==='rpc-refusal'){
            process.stdout.write(JSON.stringify({id:m.id,error:{code:-32600,message:'Input exceeds the maximum length of 1000000 characters; Bearer OFFLINE_SECRET_MARKER',data:{token:'OFFLINE_PRIVATE_DATA'}}})+'\n');continue;
        }
        if(mode==='review-packet')writeFileSync('codex-review-prompt.json',m.params.input[0].text);
        // K07 contract: the turn repeats the named profile and must not carry sandboxPolicy.
        if (typeof m.params.permissions !== 'string' || !m.params.permissions || m.params.sandboxPolicy !== undefined || m.params.approvalPolicy !== 'never')
            throw new Error('Wrong turn permission-profile contract');
        if(m.params.permissions==='dream-maker-supervisor-data'&&(!Array.isArray(m.params.environments)||m.params.environments.length))throw new Error('Data-only turn exposed an environment');
        if(mode==='preack-flood')for(let i=0;i<300;i++)notify('item/completed',{threadId:thread,turnId:'turn-1',item:{type:'agentMessage',text:'OFFLINE_FLOOD'}});
        reply({turn:{id:mode==='malformed-turn'?{}:mode==='missing-turn'?'':'turn-1'}});
        if(mode==='client-request')process.stdout.write(JSON.stringify({id:'fixture-client-request',method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:'turn-1'}})+'\n');
        if(mode==='tool-use')notify('item/started',{threadId:thread,turnId:'turn-1',item:{type:'commandExecution',command:'UNEXECUTED_FIXTURE_COMMAND'}});
        if(mode==='quota-update')notify('account/rateLimits/updated',{rateLimits:{spendControlReached:true}});
        if(mode==='account-update')notify('account/updated',{authMode:'apiKey',planType:null});
        notify('item/completed',{threadId:thread,turnId:'foreign-turn',item:{type:'agentMessage',text:'FOREIGN_OUTPUT'}});
        notify('thread/tokenUsage/updated',{threadId:thread,turnId:'foreign-turn',tokenUsage:{total:{inputTokens:99999,outputTokens:99999}}});
        notify('turn/completed',{threadId:thread,turn:{id:'foreign-turn',status:'completed'}});
        notify('item/completed',{threadId:thread,turnId:'turn-1',item:{type:'agentMessage',text:'{"verdict":"PASS","findings":[]}'}});
        notify('turn/completed',{threadId:mode==='wrong-thread'?'foreign-thread':thread,turn:{id:'turn-1',status:'completed'}});
    }
    else if(m.method==='turn/interrupt')reply({});
}
