// Pure process-launch policy. No Edge process is started, inspected or stopped.
import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from '../helpers.mjs';
import {withProcessOwnership} from '../../dist/server/flow/process-ownership.js';
import {own} from '../../dist/server/process.js';
import {assertNotProtectedProcess} from '../../dist/server/protected-processes.js';

test('DM-owned launchers reject direct Edge and shell-mediated Edge termination before process intent', async t => {
    const h=harness(t);
    const scope={store:h.store,projectId:null,runId:null,dispatchId:'OFFLINE_EDGE_GUARD',generation:'OFFLINE_EDGE_GUARD',mode:'live'};
    const denied=[
        ['C:/DreamMakerSuite/nonexistent/msedge.exe',['--version']],
        ['taskkill.exe',['/IM','msedge.exe','/F']],
        ['powershell.exe',['-NoProfile','-Command','Stop-Process -Name msedge -Force']],
    ];
    for(const [command,args] of denied){
        assert.throws(
            ()=>withProcessOwnership(scope,()=>own(command,args,{cwd:h.dir})),
            {code:'EDGE_PROCESS_PRESERVATION_REQUIRED'},
        );
    }
    assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM records WHERE kind LIKE 'OwnedProcess%'").get().n,0);
});

test('the protection is narrow and does not block ordinary owned executables', async t => {
    const h=harness(t);
    const scope={store:h.store,projectId:null,runId:null,dispatchId:'OFFLINE_NON_EDGE',generation:'OFFLINE_NON_EDGE',mode:'live'};
    const child=withProcessOwnership(scope,()=>own(process.execPath,['-e','process.stdout.write("ok")'],{cwd:h.dir}));
    let stdout='';
    child.child.stdout.on('data',chunk=>stdout+=chunk);
    child.child.stderr.resume();
    await child.closed;
    await child.stop();
    assert.equal(stdout,'ok');
});

test('the policy rejects indirect Edge wrappers and generic termination tools without spawning', () => {
    const denied=[
        ['taskkill.exe',['/PID','424242','/T','/F']],
        ['powershell.exe',['-NoProfile','-Command','Stop-Process -Id 424242 -Force']],
        ['cmd.exe',['/d','/s','/c','start','','msedge.exe']],
        ['powershell.exe',['-NoProfile','-Command','Start-Process msedge.exe']],
    ];
    for(const [command,args] of denied){
        assert.throws(
            ()=>assertNotProtectedProcess(command,args),
            {code:'EDGE_PROCESS_PRESERVATION_REQUIRED'},
        );
    }
});
