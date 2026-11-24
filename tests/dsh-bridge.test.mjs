import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { harness, root } from './helpers.mjs';
import { DshRunner, nativeReadiness,dshRuntimeReadiness } from '../dist/server/providers/dsh.js';
import { hash } from '../dist/server/security.js';
function fixture(t) { const h = harness(t); h.config.codex.home = h.dir; h.config.codex.model = 'fixture-only'; h.config.dsh.modulePath = resolve(root, 'tests/fixtures/dsh-adapter.mjs'); h.config.dsh.keyEnv = 'DM_DSH_TEST_API_KEY'; process.env.DM_DSH_TEST_API_KEY = 'synthetic-bridge-test-value'; t.after(() => delete process.env.DM_DSH_TEST_API_KEY); const toolConfig=resolve(h.dir,'offline-tool-config.json');writeFileSync(toolConfig,'{"scope":"OFFLINE_TOOL_PROXY_FIXTURE"}'); const evidence = resolve(h.dir, 'offline-proof.txt'); writeFileSync(evidence, 'SYNTHETIC TEST ATTESTATION; NOT LIVE OS ISOLATION EVIDENCE'); h.config.nativeAuditPath = resolve(h.dir, 'fixture-audit.json'); const audit = { configurationHash: nativeReadiness(h.config).configurationHash, status: 'LIVE_READY', osIsolationVerified: true, secretIsolationVerified: true, noImplicitLayaVerified: true, verifierImplemented: true, sandboxExecutionVerified: true, expiresAt: new Date(Date.now() + 60000).toISOString(), moduleSha256: hash(readFileSync(h.config.dsh.modulePath)), evidenceFiles: [{ path: evidence, sha256: hash(readFileSync(evidence)) }] }; writeFileSync(h.config.nativeAuditPath, JSON.stringify(audit)); return { h, audit, input: { role: 'executor', workspace: h.dir, prompt: 'OFFLINE fixture only', model: 'deepseek-flash', specHash: 'fixture', runId: 'fixture', laya: { adoption: 'off' }, signal: new AbortController().signal }, runner: new DshRunner(() => h.config, root, async () => ({ url:'http://127.0.0.1:1/v1',token:'OFFLINE_EPHEMERAL_TOKEN',close:async()=>{},receipts:()=>[] }),async()=>({url:'http://127.0.0.1:1/tools',token:'OFFLINE_TOOL_BEARER',configPath:toolConfig,configSha256:hash(readFileSync(toolConfig)),close:async()=>{}})) }; }
test('DSH own-bridge fixture launches module, routes model and returns tool notifications', async (t) => { const f = fixture(t), events = []; const result = await f.runner.run(f.input, e => events.push(e)); assert.equal(result.text, 'OFFLINE DSH ADAPTER FIXTURE'); assert.equal(result.usage.costUsd, null); assert.equal(events[0].method, 'dm/event'); assert.equal(readFileSync(resolve(f.h.dir, 'fixture-executor.txt'), 'utf8'), 'OFFLINE FIXTURE'); });
test('DSH verification subprocess does not receive provider credentials', async (t) => { const f = fixture(t); const result = await f.runner.call('dm/verify', f.input, () => { }); assert.equal(result.stdout, 'NO_PROVIDER_KEY'); assert.equal(result.exitCode, 0); });
test('DSH refuses expired or changed audit evidence before spawning', async (t) => { const f = fixture(t); f.audit.expiresAt = '2020-01-01T00:00:00Z'; writeFileSync(f.h.config.nativeAuditPath, JSON.stringify(f.audit)); await assert.rejects(f.runner.run(f.input, () => { }), { code: 'NATIVE_INTEGRATION_BLOCKED' }); });
test('even an otherwise accepted audit cannot bypass the inner-request monetary gateway', async t => {
    const f=fixture(t), unguarded=new DshRunner(()=>f.h.config,root);
    await assert.rejects(unguarded.run(f.input,()=>{}),{code:'NATIVE_BUDGET_REQUIRED'});
});
test('model gateway alone cannot dispatch an unconfined tool runtime',async t=>{
 const f=fixture(t),gateway=async()=>({url:'http://127.0.0.1:1/v1',token:'OFFLINE',close:async()=>{},receipts:()=>[]});
 const missingTools=new DshRunner(()=>f.h.config,root,gateway);
 await assert.rejects(missingTools.run(f.input,()=>{}),{code:'NATIVE_TOOL_PROXY_REQUIRED'});
});

test('DSH-only runtime audit does not require Codex settings and still checks expiry and evidence',t=>{
 const f=fixture(t);f.h.config.codex.home='';f.h.config.codex.model='';f.audit.configurationHash=nativeReadiness(f.h.config).configurationHash;writeFileSync(f.h.config.nativeAuditPath,JSON.stringify(f.audit));
 assert.equal(nativeReadiness(f.h.config).ok,false);assert.equal(dshRuntimeReadiness(f.h.config).ok,true);
 f.audit.expiresAt='2020-01-01T00:00:00Z';writeFileSync(f.h.config.nativeAuditPath,JSON.stringify(f.audit));assert.equal(dshRuntimeReadiness(f.h.config).ok,false);
});
