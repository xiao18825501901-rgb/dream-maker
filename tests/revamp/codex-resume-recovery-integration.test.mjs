// OFFLINE protocol test: product interrupted-review inspection must prove that the
// original thread can be cold-resumed without issuing a model turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectInterruptedCodexReview} from '../../dist/server/providers/codex-history.js';
import {codexLaunch,windowsCodexContextArguments} from '../../dist/server/providers/codex-transport.js';
import {defaults} from '../../dist/server/config.js';
import {hash} from '../../dist/server/security.js';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const fixture=resolve(root,'tests/fixtures/codex-history-wire.mjs');
const policyFile=resolve(root,'config/codex-supervisor-windows.toml');
const threadId='OFFLINE_THREAD';
const turnId='OFFLINE_TURN';
const model='OFFLINE_MODEL';

test('interrupted review recovery requires fixed-schema cold resume and never starts a turn',async t=>{
    const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});
    const directory=mkdtempSync(join(parent,'codex-resume-recovery-'));
    t.after(()=>rmSync(directory,{recursive:true,force:true}));
    mkdirSync(join(directory,'scripts/isolation'),{recursive:true});
    copyFileSync(resolve(root,'scripts/isolation/windows-owned-job.cs'),
        join(directory,'scripts/isolation/windows-owned-job.cs'));
    const home=join(directory,'codex-home'),original=join(directory,'.runtime/windows-codex/reviewer-original'),
        packet=join(original,'packet'),requestLog=join(directory,'requests.jsonl');
    mkdirSync(join(home,'sessions/2026/11/07'),{recursive:true});
    mkdirSync(packet,{recursive:true});
    const config=structuredClone(defaults);
    config.codex={
        ...config.codex,
        command:process.execPath,
        args:[fixture,'app-server',threadId,turnId,requestLog],
        home,
        model,
        permissionProfile:'dream-maker-supervisor-data',
        policyFile,
        transport:'stdio'
    };
    writeFileSync(join(original,'context.json'),JSON.stringify({
        schema:'dream-maker.windows-codex-context.v1',
        role:'reviewer',
        homeHash:hash(home),
        cwd:packet
    }));
    const inputHash=hash('original review input');
    const transcript=[
        {type:'session_meta',payload:{id:threadId}},
        {type:'event_msg',payload:{type:'task_started',turn_id:turnId}},
        {type:'response_item',payload:{type:'message',role:'user',content:[{
            type:'input_text',
            text:'<environment_context>\n  <current_date>2026-11-07</current_date>\n  <timezone>Asia/Shanghai</timezone>\n</environment_context>'
        }]}},
        {type:'turn_context',payload:{turn_id:turnId,cwd:packet,model,approval_policy:'never'}},
        {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'original review input'}]}}
    ];
    writeFileSync(join(home,`sessions/2026/11/07/rollout-2026-11-07T00-00-00-${threadId}.jsonl`),
        transcript.map(row=>JSON.stringify(row)).join('\n'));
    const launch=codexLaunch(config,packet);
    const input={
        runId:'OFFLINE_RUN',
        specHash:'a'.repeat(64),
        dispatchId:'OFFLINE_DISPATCH',
        threadId,
        model,
        policyHash:hash(readFileSync(policyFile)),
        inputHash,
        commandHash:hash(process.execPath),
        argvHash:hash([...launch.args,...windowsCodexContextArguments(original)])
    };
    const observation=await inspectInterruptedCodexReview(directory,config,input,new AbortController().signal);
    assert.equal(observation.threadId,threadId);
    assert.equal(observation.turnId,turnId);
    assert.equal(observation.modelDispatchesByInspection,0);
    const requests=readFileSync(requestLog,'utf8').trim().split('\n').map(JSON.parse);
    const resumed=requests.filter(request=>request.method==='thread/resume');
    assert.equal(resumed.length,1);
    assert.equal(resumed[0].params.threadId,threadId);
    assert.equal(Object.hasOwn(resumed[0].params,'environments'),false);
    assert.equal(resumed[0].params.permissions,'dream-maker-supervisor-data');
    assert.deepEqual(resumed[0].params.runtimeWorkspaceRoots,[]);
    assert.equal(requests.some(request=>request.method==='turn/start'),false);
});
