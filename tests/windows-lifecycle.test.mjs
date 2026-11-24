import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';
import { own, capture } from '../dist/server/process.js';
import { childEnv } from '../dist/server/security.js';
import { harness, root, until } from './helpers.mjs';
import { fixtureProjectPlan } from './fixtures/full-project-plan.mjs';

async function start(t, data, port = 0,entry='main.js') {
    const owned = own(process.execPath, [resolve(root, 'dist/server',entry)], {
        cwd: root, env: childEnv({ DM_DATA_DIR: data, DM_CONFIG: resolve(data, 'config.json'), DM_PORT: String(port) })
    });
    let stdout = '';
    owned.child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    owned.child.stderr.resume();
    t.after(() => owned.stop());
    const url = await until(() => stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#bootstrap=[a-f0-9]+/)?.[0], 15000);
    const origin = new URL(url).origin;
    const login = await fetch(origin + '/api/session', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrap: new URL(url).hash.split('=')[1] })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0], { csrf } = await login.json();
    const call = async (path, method = 'GET', body) => {
        const response = await fetch(origin + '/api' + path, {
            method, headers: { cookie, ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() }) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: response.status, body: await response.json() };
    };
    return { owned, origin, cookie, call };
}

async function build(app) {
    const created = await app.call('/projects', 'POST', { name: 'Restart canary', idea: 'A local study board', mode: 'demo' });
    const pid = created.body.project.id;
    const finished = await app.call(`/projects/${pid}/finish`, 'POST', {});
    await app.call(`/projects/${pid}/approve`, 'POST', { specHash: finished.body.spec.hash });
    const result = await app.call(`/projects/${pid}/build`, 'POST', { specHash: finished.body.spec.hash, approved: true });
    assert.equal(result.status, 200);
    return { pid, rid: result.body.runs[0].id };
}

test('real server termination and restart preserve projects and block uncertain dispatch', async t => {
    let first, second;
    t.after(async () => { await second?.owned.stop(); await first?.owned.stop(); });
    const h = harness(t), data = resolve(h.dir, 'Windows data with spaces \u4e2d\u6587');
    first = await start(t, data);
    const { pid, rid } = await build(first);
    // The demo turn is fast, so it may reach a terminal state before the process is killed. Record the
    // state we actually observed and assert the invariant that belongs to it — an assertion that only
    // holds when the race is lost is a flake, not a gate.
    const stateBeforeStop = (await first.call(`/projects/${pid}`)).body.runs.find(r => r.id === rid)?.state;
    await first.owned.stop();
    assert.ok(existsSync(resolve(data, 'server.lock')), 'hard termination must leave a stale owner record');
    second = await start(t, data);
    const recovered = await second.call(`/projects/${pid}`), run = recovered.body.runs.find(r => r.id === rid);
    const calls = run.calls;
    // Whatever the observed state, a restart must never re-dispatch work on its own.
    await new Promise(r => setTimeout(r, 350));
    assert.equal((await second.call(`/projects/${pid}`)).body.runs[0].calls, calls);
    assert.equal((await fetch(second.origin + '/api/session', { headers: { cookie: first.cookie } })).status, 401);
    if (stateBeforeStop === 'READY_FOR_DELIVERY') {
        // It finished before the crash: recovery must not clobber a completed run.
        assert.equal(run.state, 'READY_FOR_DELIVERY');
        assert.equal(run.reason, null);
        return;
    }
    assert.equal(run.state, 'BLOCKED');
    assert.ok(['WORKER_RESTART_RESULT_UNCERTAIN','PROCESS_CLEANUP_UNPROVEN'].includes(run.reason), 'an unfinished durable dispatch has the stronger cleanup gate');
    const duplicate = await second.call(`/projects/${pid}/build`, 'POST', { specHash: run.specHash, approved: true });
    assert.equal(duplicate.status, 409, 'uncertain run must retain its single-writer lease');
    if(run.reason==='PROCESS_CLEANUP_UNPROVEN'){
        assert.equal((await second.call(`/runs/${rid}/cancel`, 'POST', {})).status,409,'cancel cannot bypass an unproven durable dispatch');
        const reconciled=await second.call(`/runs/${rid}/reconcile`,'POST',{});
        assert.equal(reconciled.status,200,JSON.stringify(reconciled.body));
    }else assert.equal((await second.call(`/runs/${rid}/cancel`, 'POST', {})).status, 200);
    assert.equal((await second.call(`/projects/${pid}`)).body.runs[0].state, 'CANCELLED');
});

test('DreamFlow and DM exclude concurrent owners and reopen the same plan without a P1 account',async t=>{
 let first,second;t.after(async()=>{await second?.owned.stop();await first?.owned.stop();});
 const h=harness(t),data=resolve(h.dir,'shared DreamFlow and DM');
 first=await start(t,data,0,'dreamflow-main.js');
 assert.equal((await first.call('/product')).body.product,'dreamflow');
 const doc={schema:'dream-maker.user-plan.v1',name:'独立入口重启',mode:'live',plan:fixtureProjectPlan([{id:'R1',text:'保存并恢复自己的方案',origin:'USER',sources:['USER_DOCUMENT']}])};
 const created=await first.call('/user-plans','POST',{document:doc});assert.equal(created.status,200);
 const pid=created.body.project.id,sid=created.body.spec.id,lock=readFileSync(resolve(data,'server.lock'),'utf8');
 const contender=await capture(process.execPath,[resolve(root,'dist/server/main.js')],{cwd:root,env:childEnv({DM_DATA_DIR:data,DM_CONFIG:resolve(data,'config.json'),DM_PORT:'0'}),timeoutMs:15000});
 assert.notEqual(contender.code,0);assert.match(contender.stderr,/SERVER_LOCK_ACTIVE/);
 assert.equal(readFileSync(resolve(data,'server.lock'),'utf8'),lock);
 await first.owned.stop();second=await start(t,data);
 const reopened=await second.call('/projects/'+pid);assert.equal(reopened.status,200);
 assert.equal(reopened.body.spec.id,sid);assert.deepEqual(reopened.body.spec,created.body.spec);
 assert.equal(reopened.body.project.planner1Mode,'USER');assert.equal(reopened.body.runs.length,0);
 assert.equal((await second.call('/projects/'+pid+'/next','POST',{})).body.error,'USER_PLANNER_REQUIRED');
 assert.equal((await second.call('/projects/'+pid+'/plans')).body.plans[0].approval,null);
});

test('a live owner lock identifies its process and refuses a second server on the same data directory', async t => {
    let first, contender;
    t.after(async () => { await contender?.stop(); await first?.owned.stop(); });
    const h = harness(t), data = resolve(h.dir, 'shared data directory');
    first = await start(t, data);
    const lockPath = resolve(data, 'server.lock');
    const before = readFileSync(lockPath, 'utf8');
    const record = JSON.parse(before);

    assert.equal(record.schema, 'dream-maker.server-lock.v1');
    assert.equal(record.pid, first.owned.child.pid);
    assert.match(record.processIdentity, /^win32:\d+$/);
    assert.ok(Number.isFinite(Date.parse(record.acquiredAt)));
    assert.equal(record.dataDir, data);
    assert.ok(record.nonce.length >= 16);

    contender = own(process.execPath, [resolve(root, 'dist/server/main.js')], {
        cwd: root, env: childEnv({ DM_DATA_DIR: data, DM_CONFIG: resolve(data, 'config.json'), DM_PORT: '0' })
    });
    let stderr = '';
    contender.child.stdout.resume();
    contender.child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    let timeout;
    const result = await Promise.race([
        contender.closed,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('second server did not fail')), 15000); })
    ]);
    clearTimeout(timeout);

    assert.notEqual(result.code, 0);
    assert.match(stderr, /SERVER_LOCK_ACTIVE|Another Dream Maker process owns this data directory/);
    assert.equal(readFileSync(lockPath, 'utf8'), before, 'a refused contender must not overwrite or remove the owner lock');
    assert.equal((await fetch(first.origin + '/api/session', { headers: { cookie: first.cookie } })).status, 200, 'the original loopback server remains alive');
});

test('occupied port fails startup, removes only its own lock, and leaves the occupant serving', async t => {
    const h = harness(t), data = resolve(h.dir, 'occupied port');
    const canary = net.createServer(socket => socket.end('unrelated-port-canary'));
    await new Promise(r => canary.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => canary.close(r)));
    const owned = own(process.execPath, [resolve(root, 'dist/server/main.js')], {
        cwd: root, env: childEnv({ DM_DATA_DIR: data, DM_CONFIG: resolve(data, 'config.json'), DM_PORT: String(canary.address().port) })
    });
    owned.child.stdout.resume(); owned.child.stderr.resume();
    t.after(() => owned.stop());
    const result = await Promise.race([owned.closed, new Promise((_, reject) => setTimeout(() => reject(Error('startup did not fail')), 15000))]);
    assert.notEqual(result.code, 0);
    assert.equal(existsSync(resolve(data, 'server.lock')), false);
    const reply = await new Promise((res, rej) => {
        const client = net.connect(canary.address().port, '127.0.0.1'); let bytes = '';
        client.on('data', chunk => { bytes += chunk; }); client.on('end', () => res(bytes)); client.on('error', rej);
    });
    assert.equal(reply, 'unrelated-port-canary');
});

test('Windows timeout stops the owned process tree while an unrelated canary survives', { skip: process.platform !== 'win32' }, async t => {
    const h = harness(t), pidfile = resolve(h.dir, 'pids.json');
    const canary = own(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root });
    canary.child.stdout.resume(); canary.child.stderr.resume(); t.after(() => canary.stop());
    const operation = capture(process.execPath, [resolve(root, 'tests/fixtures/process-tree.mjs'), pidfile], { cwd: h.dir, timeoutMs: 2000 });
    const rejection = assert.rejects(operation, { code: 'PROCESS_TIMEOUT' });
    await until(() => existsSync(pidfile));
    const pids = JSON.parse(readFileSync(pidfile, 'utf8'));
    await rejection;
    const running = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
    await until(() => !running(pids.parent) && !running(pids.child));
    assert.equal(running(canary.child.pid), true);
});
test('a child that closes its pipes cannot crash the host through an unhandled stream error', async t => {
    // The child closes stdin and exits immediately; our capture() then closes an already-dead pipe.
    const { capture } = await import('../dist/server/process.js');
    const result = await capture(process.execPath, ['-e', 'process.stdin.destroy(); process.exit(0)'], { timeoutMs: 15000 });
    assert.equal(result.code, 0);
    assert.equal(typeof result.stdout, 'string');
});
