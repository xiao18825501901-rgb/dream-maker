// OFFLINE pure helper parsing. Canary values are synthetic and never sent to WSL/accounts.
import test from 'node:test';import assert from 'node:assert/strict';import{spawnSync}from'node:child_process';import{resolve}from'node:path';import{childEnv}from'../../dist/server/security.js';
const helper=resolve('scripts/isolation/network-context-observer.py');
function inspect(log,account){const source='import importlib.util,json,sys; s=importlib.util.spec_from_file_location("dm_observer",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); v=json.load(sys.stdin); print(json.dumps({"rejections":m.classify_login_log(v["log"]),"account":m.account_summary(v["account"])}))';const r=spawnSync('python',['-I','-c',source,helper],{cwd:process.cwd(),env:childEnv(),input:JSON.stringify({log,account}),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:16384});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
test('observed token-exchange policy errors preserve time and only a masked request ID',()=>{
 const raw='2026-11-02T17:34:55.859476Z ERROR Token exchange failed: token endpoint returned status 403 Forbidden: Country, region, or territory not supported (request id: 0123456789abcdef-TST)';
 const v=inspect(raw,{});assert.equal(v.rejections.length,1);assert.equal(v.rejections[0].reason,'REGION_UNSUPPORTED');assert.equal(v.rejections[0].requestId,'012345…-TST');assert.equal(v.rejections[0].at,'2026-11-02T17:34:55.859476Z');assert.ok(!JSON.stringify(v).includes('6789abcdef'));
});

test('unrelated policy text and arbitrary account fields cannot create a login verdict or fingerprint',()=>{
 const v=inspect('2026-11-02T17:34:55Z ERROR unrelated country, region, or territory not supported',{auth_mode:'api_key',account_id:'unrelated-id',tokens:{access_token:'OFFLINE_CANARY'}});
 assert.deepEqual(v.rejections,[]);assert.deepEqual(v.account,{mode:'UNKNOWN',fingerprint:null});
});
test('generic forbidden and transport errors remain distinct from regional policy',()=>{
 const log='2026-11-02T17:34:55Z ERROR token exchange failed: status 403 Forbidden\n2026-11-02T17:35:55Z ERROR token exchange failed: TLS handshake timed out';const v=inspect(log,{});assert.deepEqual(v.rejections.map(r=>r.reason),['FORBIDDEN_UNKNOWN','TRANSPORT_ERROR']);
});
test('cached account projection cannot return a token, email, code, cookie or the raw account ID',()=>{
 const secret='OFFLINE_CREDENTIAL_CANARY_NOT_REAL',id='OFFLINE_ACCOUNT_CANARY';const v=inspect('unrelated '+secret,{auth_mode:'chatgpt',tokens:{access_token:secret,refresh_token:secret,id_token:secret,account_id:id},email:'private@example.invalid'});
 assert.equal(v.account.mode,'CHATGPT');assert.match(v.account.fingerprint,/^[a-f0-9]{16}$/);assert.ok(!JSON.stringify(v).includes(secret));assert.ok(!JSON.stringify(v).includes(id));assert.ok(!JSON.stringify(v).includes('private@example.invalid'));assert.deepEqual(v.rejections,[]);
});
