// OFFLINE wire test: the fixture is not Codex and never contacts a model.
// It proves the api-key mode of the same CLI runner drops the subscription-only
// quota/fingerprint expectations and passes the caller's provider name through,
// while the default mode still refuses a denied subscription quota.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';
import {CodexRunner} from '../../dist/server/providers/codex.js';
import {RpcPeer} from '../../dist/server/providers/rpc.js';
import {harness,root} from '../helpers.mjs';

function setup(t, mode) {
    const h = harness(t), c = h.config, policyFile = resolve(h.dir, 'codex-role-policy.toml');
    writeFileSync(policyFile, readFileSync(resolve(root, 'config/codex-agent-windows-readonly.toml'), 'utf8')
        .replaceAll('dream-maker-source-read', 'fixture-source-read'));
    c.codex = { command: process.execPath, args: [resolve(root, 'tests/fixtures/codex-wire.mjs'), mode],
        home: h.dir, model: 'fixture-not-a-model', permissionProfile: 'fixture-source-read', policyFile };
    c.limits.stepTimeoutMs = 12000;
    const input = { workspace: h.dir, prompt: 'supplied frozen data only', model: c.codex.model,
        specHash: 'fixture', runId: 'fixture', role: 'planner2', laya: { adoption: 'off' }, signal: new AbortController().signal };
    const sent = () => readFileSync(resolve(h.dir, 'codex-fixture-requests.jsonl'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
    return { h, c, input, sent };
}

test('an api-key Codex runner skips the subscription quota and states API_KEY', async t => {
    const x = setup(t, 'gateway-no-local-account');
    const prepared = [];
    const capture = prompt => { prepared.push(prompt); };
    const request = RpcPeer.prototype.request;
    t.mock.method(RpcPeer.prototype, 'request', function (method, params, ...rest) {
        if (method === 'turn/start') {
            assert.deepEqual(prepared, [x.input.prompt]);
            assert.deepEqual(params.input, [{ type: 'text', text: prepared[0] }]);
        }
        return request.call(this, method, params, ...rest);
    });
    const out = await new CodexRunner(() => x.c, root, false, undefined, undefined, undefined, 'api_key', 'magpie', undefined, undefined, capture)
        .run(x.input, () => {});
    assert.deepEqual(prepared, [x.input.prompt]);
    assert.equal(out.identity.authentication, 'API_KEY');
    assert.equal(out.identity.provider, 'magpie');
    assert.equal(out.observation.provider, 'magpie');
    assert.equal(out.observation.accountFingerprint, undefined);
    assert.equal(out.model, 'fixture-not-a-model');
    const calls = x.sent();
    assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(calls.some(c => c.method === 'account/rateLimits/read'), false, 'no subscription quota read');
    assert.equal(calls.find(c => c.method === 'thread/start')?.modelProvider, 'magpie', 'the configured provider name reaches the CLI');
});

for(const [name,mode,paid,expectedError] of [
 ['paid upstream','review-packet',true],
 ['Classic subscription','review-packet',false],
 ['foreign CLI provider','wrong-provider',true,'CODEX_ACTUAL_ROUTE_MISMATCH'],
 ['unbound upstream','review-packet',true,'CUSTOM_CODEX_REVIEW_PROVIDER_REQUIRED'],
 ['forged packet admission','gateway-no-local-account',true,'REVIEW_ADMISSION_BINDING_INVALID'],
])test('formal reviewer packet and outer identity: '+name,async t=>{
 const x=setup(t,mode),provider=paid?'fixture-upstream':'openai',authentication=paid?'API_KEY':'CHATGPT_SUBSCRIPTION';
 // Allow for the Windows Job handshake before the reviewer packet reaches turn/start.
 if(process.platform==='win32')x.c.limits.stepTimeoutMs=120000;
 const packet={schema:'dream-maker.review-packet.v1',runId:x.input.runId,specHash:x.input.specHash,
  executionEvidence:{roleIdentities:{planner2:{sessionId:'OFFLINE_P2'}}}};
 if(name==='forged packet admission')packet.controllerAdmission={provider:'openai',authentication:'CHATGPT_SUBSCRIPTION'};
 const input={...x.input,role:'reviewer',prompt:JSON.stringify({specHash:packet.specHash,taskData:JSON.stringify(packet),laya:null})};
 const runner=paid?new CodexRunner(()=>x.c,root,false,undefined,undefined,undefined,'api_key','magpie',undefined,undefined,undefined,name==='unbound upstream'?undefined:provider):new CodexRunner(()=>x.c,root);
 const events=[],turn=runner.run(input,event=>events.push(event));
 if(expectedError){
  await assert.rejects(turn,{code:expectedError});
  assert.equal(x.sent().some(call=>call.method==='turn/start'),false);
  return;
 }
 const out=await turn,body=JSON.parse(readFileSync(resolve(x.h.dir,'codex-review-prompt.json'),'utf8'));
 assert.deepEqual(body.taskData,packet);
 for(const identity of [body.controllerAdmission,out.identity,...['dm/codexAdmission','dm/codexCompletion'].map(method=>events.find(e=>e.method===method).params)]){
  assert.equal(identity.provider,provider);
  assert.equal(identity.authentication,authentication);
  assert.equal(identity.model,input.model);
 }
 assert.equal(out.observation.provider,paid?'magpie':'openai');
 assert.equal(x.sent().find(call=>call.method==='thread/start').features.goals,paid?false:undefined);
});

test('the same denied quota still stops the subscription runner', async t => {
    const x = setup(t, 'quota-denied');
    await assert.rejects(new CodexRunner(() => x.c, root).run(x.input, () => {}),
        { code: 'CODEX_INCLUDED_USAGE_UNAVAILABLE' });
});
