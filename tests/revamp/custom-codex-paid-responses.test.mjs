// Actual loopback supervisor gateway and ledger with an offline Magpie peer and model reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { DeepSeekGateway } from '../../dist/server/deepseek-gateway.js';
import { MagpieAdmissionPipe } from '../../dist/server/magpie-control.js';
import { MagpieDshRequestTransport } from '../../dist/server/magpie-model-transport.js';
import { magpieRouteHash } from '../../dist/server/magpie-route.js';
import { NativeBudget } from '../../dist/server/native-budget.js';
import { chatSupervisorResponsesBody } from '../../dist/server/flow/chat-supervisor-responses.js';
import { paidCodexResponsesBody } from '../../dist/server/flow/paid-codex-responses.js';
import { responsesEvents } from '../../dist/server/flow/responses-wire.js';
import { DomainError, hash } from '../../dist/server/security.js';
import { offlineCustomBudget, offlineCustomQualification } from '../fixtures/custom-budget.mjs';

const route = {
  runtime: 'codex', provider: 'deepseek-official', protocol: 'openai-responses', model: 'deepseek-flash',
  authentication: 'api_key', authRef: 'offline_auth', accountRef: 'offline_account', upstreamAccountRef: 'deepseek-official/offline_peer',
};
const model = route.model;
const qualifiedModel = route.provider + '/' + model;
const output = '{"verdict":"PASS"}';
const limits = { model, maxOutputTokens: 128, prompt: 'offline task', instructions: 'controller rules', outputSchema: { type: 'object' } };
const input = () => ({
  model, stream: true, max_output_tokens: 32, tools: [],
  input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'untrusted client rules' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: limits.prompt }] },
  ],
  instructions: 'untrusted client instructions',
  text: { format: { type: 'json_schema', strict: true, name: 'review', schema: limits.outputSchema } },
});

function providerStream(mode, responseModel = qualifiedModel) {
  const stream = responsesEvents({ id: 'offline_response', model: responseModel, content: output, toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  const events = stream.trimEnd().split('\n\n').map(block => JSON.parse(block.split('\n').find(line => line.startsWith('data: ')).slice(6)));
  const finished = events.at(-1).response;
  finished.usage.input_tokens_details = { cached_tokens: 1 };
  if (mode === 'drifted model') finished.model = model;
  if (mode === 'forged final text') finished.output[0].content[0].text = 'other';
  if (mode === 'tool reply') events.find(event => event.type === 'response.output_item.added').item.type = 'function_call';
  if (mode === 'truncated') events.pop();
  if (mode === 'malformed stream') return 'event: response.completed\ndata: {\n\n';
  if (mode === 'missing usage') delete finished.usage;
  if (mode === 'over limit') Object.assign(finished.usage, { output_tokens: 33, total_tokens: 43 });
  return events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('');
}

async function setup(t, mode, official) {
  const provider = official?.provider ?? route.provider;
  const selectedRoute = official ? {...route, provider, upstreamAccountRef:provider+'/offline_peer', runtime: official.runtime} : route;
  const upstreamModel = provider + '/' + model;
  const role = official?.role ?? 'reviewer';
  const frozen = official ? {model, maxOutputTokens:128, prompt:limits.prompt, instructions:limits.instructions} : limits;
  const defaultInput = official ? () => ({model, stream:false, max_tokens:32, messages:[{role:'system',content:'local CLI context'},{role:'user',content:'<task>'+limits.prompt+'</task>'}]}) : input;
  const prepare = official ? chatSupervisorResponsesBody : paidCodexResponsesBody;
  const base = join(process.cwd(), '.runtime', 'test-temp');
  mkdirSync(base, { recursive: true });
  const scratch = mkdtempSync(join(base, 'paid-responses-'));
  const authority = { scopeId: 'OFFLINE_PAID_RESPONSES', authorizationHash: 'OFFLINE_AUTH', totalMicros: 50_000_000, probeMicros: 5_000_000, warningMicros: 40_000_000, maxInFlight: 1, maxRepairs: 2 };
  if(official?.uncapped)Object.assign(authority,{mode:'UNCAPPED',uncappedApproval:{approvedBy:'USER',approvedAt:new Date().toISOString(),statement:'offline fixture',evidenceRef:'offline',supersedes:[]}});
  const qualification = mode === 'unqualified' ? () => {throw new DomainError('CUSTOM_QUALIFICATION_REQUIRED',409);} : offlineCustomQualification;
  const budget = new NativeBudget(join(scratch, 'budget.sqlite'), authority, undefined, undefined, 'FULL_DM', offlineCustomBudget, qualification);
  const price = { provider: official?.quoteProvider ?? provider, model:official?.quoteModel ?? model, currency: official?.currency ?? 'CNY', source: 'OFFLINE_PRICE', expiresAt: new Date(Date.now() + 300_000).toISOString(), maxInputTokens: 1048576, inputMissMicrosPerMillion: 2_000_000, inputHitMicrosPerMillion: 40_000, outputMicrosPerMillion: 8_000_000 };
  const identity={projectId:'offline_project',runId:'offline_run',configurationHash:'a'.repeat(64),planVersionHash:'b'.repeat(64),specHash:'c'.repeat(64),dispatchId:'offline_dispatch',generation:'offline_owner',role,roleId:role};
  const cap={currency:official?.budgetCurrency ?? 'CNY',maxMicros:official?.cap ?? 5_000_000};
  const probeContext=mode==='qualification'?{...identity,schema:'dream-maker.custom-probe-budget.v1',probeId:'custom_probe_offline',bindingHash:'d'.repeat(64),routeHash:magpieRouteHash(selectedRoute),flowBudget:cap,roleBudget:cap}:undefined;
  const permit=probeContext&&budget.beginCustomProbe(probeContext);
  let probeBinding;
  const customProbe=permit&&{permit,assertCurrent(binding){probeBinding=binding;assert.equal(binding.work.probeId,probeContext.probeId);}};
  const epoch = 'offline_paid_epoch';
  const pipeOutput = new PassThrough(), frames = [];
  const pipeInput = new Writable({ write(bytes, _encoding, callback) {
    const raw = bytes.toString().trimEnd(), frame = JSON.parse(raw);
    frames.push(frame);
    const admission = frame.request ?? frame.admission;
    const receipt = { epoch, id: admission.id, reservationId: admission.reservationId, controlHash: hash(raw), accepted: true };
    const result = frame.type === 'issue'
      ? { ...receipt, type: 'issued', schema: 'dream-maker.magpie-issued-key.v1', upstreamKeyId: 'e'.repeat(24), upstreamKey: 'sk-magpie-key-' + 'f'.repeat(48), expiresAtMs: Date.now() + 120_000 }
      : { ...receipt, type: 'admission', schema: 'dream-maker.magpie-admission-ack.v2' };
    pipeOutput.write(JSON.stringify(result) + '\n');
    callback();
  } });
  const finishedPipe = Promise.withResolvers();
  const control = new MagpieAdmissionPipe({ input: pipeInput, output: pipeOutput, closed: finishedPipe.promise, stop: async () => { finishedPipe.resolve(); } }, budget, { epoch, binaryHash: official?.binaryHash ?? '1'.repeat(64), ackTimeoutMs: 5000 });
  const session = { control, close: () => control.close(), observation: { address: '127.0.0.1:12345', epoch, binaryHash:official?.binaryHash, accounts:[{...selectedRoute,capabilities:[{model,protocol:selectedRoute.protocol}]}] }, prepareModelPayload(selected, raw, context, preparedRole) {
    assert.equal(preparedRole,role);
    assert.deepEqual(context, frozen);
    const payload = prepare(JSON.parse(raw), context);
    const body = JSON.stringify({ ...payload, model: upstreamModel });
    return { body, bodyHash: hash(body), route: selected, routeHash: magpieRouteHash(selected), method: 'POST', path: '/v1/responses', maxOutputTokens: payload.max_output_tokens };
  } };
  const sending = Promise.withResolvers();
  let sends = 0, contextReads = 0, upstreamSignal, preparedContext;
  const planner = mode === 'deferred' ? () => {
    contextReads++;
    if (!preparedContext) throw new DomainError('CODEX_PREPARED_PROMPT_REQUIRED', 409);
    return preparedContext;
  } : frozen;
  const channel = new MagpieDshRequestTransport({ session, budget, route:selectedRoute, role, planner,
    bindRequest: payload => ({
      schema: 'dream-maker.native-request-binding.v1', ...identity, engineeringMode: 'custom', work:probeContext?{kind:'QUALIFICATION',probeId:probeContext.probeId,bindingHash:probeContext.bindingHash}:{kind:'SUPERVISION'}, bodyHash: payload.bodyHash, routeHash: payload.routeHash,
    }),
    assertCurrent() { if (mode === 'stale after response' && sends) throw new DomainError('NATIVE_REQUEST_BINDING_STALE', 409); },
    async transport(url, init) {
      sends++;
      assert.equal(url, 'http://127.0.0.1:12345/v1/responses');
      assert.equal(init.headers.accept, 'text/event-stream');
      assert.match(init.headers.authorization, /^Bearer [a-f0-9]{64}$/);
      assert.equal(init.headers['X-DM-Gateway'], undefined);
      assert.equal(init.headers['ChatGPT-Account-ID'], undefined);
      const row = budget.requests()[0];
      assert.equal(row.usageStatus, 'PENDING');
      assert.equal(row.price.billing, undefined);
      assert.equal(row.routerAdmission.status, 'ACKNOWLEDGED');
      assert.equal(row.binding.bodyHash, hash(init.body));
      assert.deepEqual(JSON.parse(init.body), { ...prepare(defaultInput(), frozen), model: upstreamModel });
      upstreamSignal = init.signal;
      sending.resolve();
      if (mode === 'cancel') return new Promise((_resolve, reject) => {
        if (init.signal.aborted) return reject(init.signal.reason);
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
      return new Response(providerStream(mode,upstreamModel), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const gateway = new DeepSeekGateway(budget, () => price, '', 128, 1, () => assert.fail('direct provider'), official?'chat-completions':'responses', false, undefined, undefined, undefined, channel, customProbe, model);
  let closing;
  const close = () => closing ??= gateway.close();
  t.after(async () => { try { await close(); } finally { if(permit)budget.endCustomProbe(permit); budget.close(); rmSync(scratch, { recursive: true, force: true }); } });
  const { url, token } = await gateway.start();
  const request = (body = defaultInput(), headers = {}, signal) => fetch(url + (official?'/chat/completions':'/responses'), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...headers }, body: JSON.stringify(body), signal });
  return { budget, gateway, request, defaultInput, close, frames, permit, price, selectedRoute, probeBinding:()=>probeBinding, sending: sending.promise, sends: () => sends, signal: () => upstreamSignal,
    setContext: value => { preparedContext = value; }, contextReads: () => contextReads };

}

test('paid native Responses preserve only controller-approved reviewer text, schema and budget', () => {
  const body = paidCodexResponsesBody(input(), limits);
  assert.deepEqual(body, { model, input: [input().input[1]], store: false, stream: true, max_output_tokens: 32, instructions: limits.instructions, text: input().text });
  assert.equal(paidCodexResponsesBody({ ...input(), max_output_tokens: 360 }, limits).max_output_tokens, 128);
  for (const changes of [
    { store: true }, { stream: false }, { previous_response_id: 'other' }, { tools: [{ type: 'web_search' }] },
    { text: { format: { ...input().text.format, schema: { type: 'array' } } } },
  ]) assert.throws(() => paidCodexResponsesBody({ ...input(), ...changes }, limits), { code: 'RESPONSES_REQUEST_INVALID' });
});

test('paid native Responses meter the exact frozen body and release verified bare-model text', async t => {
  const x = await setup(t, 'complete');
  assert.equal((await x.request(input(), { 'X-DM-Gateway': 'wrong-wire' })).status, 401);
  assert.equal((await x.request({ ...input(), tools: [{ type: 'function' }] })).status, 409);
  assert.equal(x.budget.requests().length, 0);
  const reply = await x.request(), wire = await reply.text();
  assert.equal(reply.status, 200, wire);
  assert.match(wire, /event: response.completed/);
  assert.ok(!wire.includes(qualifiedModel));
  const [receipt] = x.gateway.receipts(), [row] = x.budget.requests();
  assert.equal(receipt.id, row.id);
  assert.equal(x.gateway.confirmedSupervisorOutput(model, output).outputTextHash, hash(output));
  assert.throws(() => x.gateway.confirmedSupervisorOutput(model, 'other'), { code: 'ROLE_EXECUTION_IDENTITY_UNVERIFIED' });
  assert.equal(row.maxOutputTokens, 32);
  assert.equal(row.usageStatus, 'KNOWN');
  assert.deepEqual(row.usage, { inputTokens: 10, outputTokens: 2, cacheHitTokens: 1 });
  assert.ok(row.chargedMicros > 0);
  assert.equal((await x.request()).status, 409);
  assert.equal(x.sends(), 1);
  assert.equal(x.frames.length, 2);
});

test('the paid Reviewer cannot reserve before its prepared prompt and reuses one frozen snapshot on send', async t => {
  const x = await setup(t, 'deferred');
  assert.equal((await x.request()).status, 409);
  assert.equal(x.budget.requests().length, 0);
  x.setContext({ ...limits, model: 'foreign' });
  assert.equal((await x.request()).status, 409);
  assert.equal(x.budget.requests().length, 0);
  assert.equal(x.frames.length, 0);
  x.setContext(structuredClone(limits));
  const reply = await x.request();
  assert.equal(reply.status, 200, await reply.text());
  assert.equal(x.contextReads(), 3);
  assert.equal(x.budget.requests().length, 1);
  assert.equal(x.sends(), 1);
});

for (const mode of ['drifted model', 'forged final text', 'tool reply', 'truncated', 'over limit', 'stale after response']) {
  test('paid native Responses withhold invalid or stale text: ' + mode, async t => {
    const x = await setup(t, mode);
    const reply = await x.request(), body = await reply.text();
    assert.equal(reply.status, 502, body);
    assert.ok(!body.includes('event:'));
    assert.throws(() => x.gateway.confirmedSupervisorOutput(model, output), { code: 'ROLE_EXECUTION_IDENTITY_UNVERIFIED' });
    const [row] = x.budget.requests();
    if (mode === 'over limit') {
      assert.equal(row.usageStatus, 'KNOWN');
      assert.equal(row.usage.outputTokens, 33);
      assert.equal(row.limitExceeded, true);
      assert.equal(row.outcome, 'NATIVE_USAGE_BOUND_EXCEEDED');
    } else {
      assert.equal(row.usageStatus, 'UNKNOWN');
      assert.equal(row.chargedMicros, row.reservedMicros);
    }
    assert.equal(x.sends(), 1);
  });
}

test('paid native Responses cancellation aborts the upstream and retains its hold', async t => {
  const x = await setup(t, 'cancel'), controller = new AbortController();
  const request = assert.rejects(x.request(input(), {}, controller.signal), { name: 'AbortError' });
  await x.sending;
  controller.abort();
  await request;
  await x.close();
  assert.equal(x.signal().aborted, true);
  assert.equal(x.sends(), 1);
  const [row] = x.budget.requests();
  assert.equal(row.usageStatus, 'UNKNOWN');
  assert.equal(row.chargedMicros, row.reservedMicros);
  assert.equal(x.gateway.receipts()[0].completionObserved, false);
});

// The controller selects this physical candidate by digest. The product owns the build allowlist.
const candidateHash = '78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6';
test('official CLI transport requires exact account capability, role and binary',()=>{
  const selected={...route,runtime:'opencode'};
  const account={...selected,capabilities:[{model,protocol:'openai-responses'}]};
  for(const [binaryHash,role,accounts] of [
    ['0'.repeat(64),'planner2',[account]], [candidateHash,'executor',[account]],
    [candidateHash,'reviewer',[{...account,authRef:'other'}]], [candidateHash,'reviewer',[account,account]],
    [candidateHash,'planner2',[{...account,capabilities:[{model:'different',protocol:'openai-responses'}]}]],
    [candidateHash,'reviewer',[{...account,capabilities:[{model,protocol:'chat-completions'}]}]],
  ]){
    const observation={address:'127.0.0.1:12345',binaryHash,accounts};
    assert.throws(()=>new MagpieDshRequestTransport({route:selected,role,planner:limits,session:{observation,
      prepareModelPayload(){assert.fail('prepared a denied route');}},
    }),{code:'MAGPIE_MODEL_ROLE_INVALID'});
  }
});
for (const runtime of ['opencode','cline']) {
  for (const role of ['planner2','reviewer']) {
    test(runtime + ' ' + role + ' returns one settled Chat completion through native Responses', async t => {
      const x = await setup(t, 'complete', {runtime,role,binaryHash:candidateHash});
      const body = x.defaultInput();
      assert.equal((await x.request({...body, messages:[{role:'user',content:'wrong prompt'}]})).status,409);
      assert.equal((await x.request({...body, tools:[{type:'function'}]})).status,409);
      assert.equal((await x.request(body, {'ChatGPT-Account-ID':'wrong wire'})).status,401);
      assert.equal(x.sends(),0);
      assert.equal(x.budget.requests().length,0);
      const reply = await x.request();
      assert.equal(reply.status,200);
      assert.equal(reply.headers.get('content-type'),'application/json');
      const chat = await reply.json();
      assert.equal(chat.model,model);
      assert.equal(chat.choices[0].message.content,output);
      assert.equal(chat.usage.prompt_cache_hit_tokens,1);
      const receipt = x.gateway.confirmedSupervisorOutput(model,output);
      const [row] = x.budget.requests();
      assert.equal(row.id,receipt.id);
      assert.equal(row.role,role);
      assert.equal(row.outcome,'COMPLETE');
      assert.equal(row.usageStatus,'KNOWN');
      assert.equal(row.maxOutputTokens,32);
      assert.equal((await x.request()).status,409);
      assert.equal(x.sends(),1);
    });
  }
}
test('official CLI engineering requires controller qualification before reservation',async t=>{
  const x=await setup(t,'unqualified',{runtime:'opencode',role:'planner2',binaryHash:candidateHash});
  const reply=await x.request();
  assert.equal(reply.status,409);
  assert.match(await reply.text(),/CUSTOM_QUALIFICATION_REQUIRED/);
  assert.equal(x.budget.requests().length,0);
  assert.equal(x.sends(),0);
});
test('official CLI qualification uses a dedicated permit, exact route and one metered request',async t=>{
  const x=await setup(t,'qualification',{runtime:'cline',role:'reviewer',provider:'explicit-provider',binaryHash:candidateHash});
  const reply=await x.request();
  assert.equal(reply.status,200,await reply.text());
  const [receipt]=x.gateway.receipts(), [row]=x.budget.requests();
  assert.equal(receipt.minimalResponseVerified,true);
  assert.equal(receipt.outputTextHash,hash(output));
  assert.equal(row.price.provider,'explicit-provider');
  assert.equal(row.customProbe.probeId,'custom_probe_offline');
  assert.equal(row.binding.work.kind,'QUALIFICATION');
  assert.throws(()=>x.budget.customProbePreflight(x.permit,x.price,32,structuredClone(row.binding),model,x.selectedRoute),{code:'CUSTOM_PROBE_PRICE_ROUTE_INVALID'});
  assert.throws(()=>x.budget.customProbePreflight(x.permit,x.price,1,x.probeBinding(),model,x.selectedRoute),{code:'CUSTOM_PROBE_PRICE_ROUTE_INVALID'});
  assert.throws(()=>x.budget.reserveCustomProbe(x.permit,x.price,row.maxOutputTokens,x.probeBinding(),model,x.selectedRoute),{code:'NATIVE_INNER_REQUEST_LIMIT'});
  assert.equal(row.usageStatus,'KNOWN');
  assert.ok(row.chargedMicros>0);
  assert.equal((await x.request()).status,409);
  assert.equal(x.sends(),1);
});
test('explicit USD probe settles against matching frozen currency and uncapped owner authority',async t=>{
  const x=await setup(t,'qualification',{runtime:'opencode',role:'planner2',provider:'explicit-provider',binaryHash:candidateHash,currency:'USD',budgetCurrency:'USD',uncapped:true});
  const reply=await x.request();
  assert.equal(reply.status,200,await reply.text());
  const [row]=x.budget.requests();
  assert.equal(row.price.currency,'USD');
  assert.equal(row.customBudget.role.currency,'USD');
  assert.equal(row.usageStatus,'KNOWN');
  assert.equal(x.sends(),1);
});
for (const patch of [{quoteProvider:'another'},{quoteModel:'another'},{currency:'USD'},{currency:'USD',budgetCurrency:'USD'},{cap:10}]) {
  test('official qualification rejects mismatched quote or insufficient cap '+JSON.stringify(patch),async t=>{
    const x=await setup(t,'qualification',{runtime:'cline',role:'reviewer',provider:'explicit-provider',binaryHash:candidateHash,...patch});
    const reply=await x.request();
    assert.equal(reply.status,409);
    assert.equal(x.sends(),0);
    assert.equal(x.budget.requests().length,0);
  });
}
test('official CLI withholds all output when the ledger fails to settle',async t=>{
  const x=await setup(t,'complete',{runtime:'opencode',role:'reviewer',binaryHash:candidateHash});
  x.budget.settle=()=>{throw new Error('offline ledger failure');};
  await assert.rejects(x.request(),/fetch failed/);
  assert.equal(x.gateway.receipts().length,0);
  assert.equal(x.budget.requests()[0].usageStatus,'PENDING');
  assert.equal(x.sends(),1);
});
for (const mode of ['drifted model','forged final text','malformed stream','tool reply','missing usage','truncated','over limit','stale after response']) {
  test('official CLI withholds failed native completion: '+mode,async t=>{
    const x=await setup(t,mode,{runtime:'cline',role:'reviewer',binaryHash:candidateHash});
    const reply=await x.request(), body=await reply.text();
    assert.equal(reply.status,502,body);
    assert.ok(!body.includes('event:')&&!body.includes(output));
    assert.throws(()=>x.gateway.confirmedSupervisorOutput(model,output),{code:'ROLE_EXECUTION_IDENTITY_UNVERIFIED'});
    const [row]=x.budget.requests();
    assert.equal(row.usageStatus,mode==='over limit'?'KNOWN':'UNKNOWN');
    if(mode==='over limit'){assert.equal(row.usage.outputTokens,33);assert.equal(row.limitExceeded,true);}
    else assert.equal(row.chargedMicros,row.reservedMicros);
    assert.equal(x.sends(),1);
  });
}

