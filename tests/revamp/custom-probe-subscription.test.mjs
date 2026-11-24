import test from 'node:test';
import assert from 'node:assert/strict';
import { customProbeKind, customProbeRouteRuntime, runCustomProbeRuntime } from '../../dist/server/flow/custom-probe-runtime.js';
import { MagpieDshRequestTransport } from '../../dist/server/magpie-model-transport.js';
import { DeepSeekGateway } from '../../dist/server/deepseek-gateway.js';
import { CodexRunner } from '../../dist/server/providers/codex.js';
import { IndependentRunner } from '../../dist/server/providers/independent.js';
import { customProbeNonce } from '../../dist/server/security.js';
import { harness } from '../helpers.mjs';

const actor = {
  role: 'planner2',
  roleId: 'planner2',
  runtime: 'codex',
  provider: 'openai',
  authentication: 'CHATGPT_SUBSCRIPTION',
  transport: 'magpie',
  model: 'gpt-6-luna',
  authRef: 'openai-chatgpt-main',
  accountRef: 'openai-chatgpt-main-account'
};

function selectedRole(actor) {
  return {...actor, id: actor.roleId, model: {kind:'model', id:actor.model}, nativeException:false,
    authentication: actor.authentication==='API_KEY'?'api_key':'oauth', permissions:['source_read']};
}

test('probe and product bind the same physical account and reject an unproven selection before use', async t => {
  const {NativeOwner}=await import('../../dist/server/native-owner.js');
  const {magpieRouteHash}=await import('../../dist/server/magpie-route.js');
  const h=harness(t), frozen=selectedRole(actor);
  const account={provider:actor.provider,authentication:'oauth',authRef:actor.authRef,accountRef:actor.accountRef,model:actor.model,upstreamAccountRef:'openai/'+'a'.repeat(64)};
  const session={observation:{scope:'LOCAL_CONTROL_PROCESS_ONLY',realCredentialsPermitted:true,accounts:[account],accountCount:1}};
  const owner=Object.create(NativeOwner.prototype), input={role:'planner2'}, binding={};
  let signed;
  owner.customRunAccountSelection=()=>({snapshot:{}});
  owner.customProbeBinding=()=>binding;
  owner.customProofs={assertCustomReady(actual,expected){assert.equal(actual,binding);assert.deepEqual(expected,signed);}};
  signed={roleId:'planner2',routeHash:magpieRouteHash({...account,runtime:'codex',protocol:'openai-responses'})};
  assert.equal(magpieRouteHash(owner.qualifiedCustomMagpieRoute(session,input,frozen)),signed.routeHash);
  account.upstreamAccountRef='openai/'+'b'.repeat(64);
  assert.throws(()=>owner.qualifiedCustomMagpieRoute(session,input,frozen),{code:'ERR_ASSERTION'});
  const mismatch={...actor,accountRef:'different-frozen-account'};
  const probe={actor:mismatch,session,selectedRole:frozen,workspace:h.dir,nonce:customProbeNonce(),assertCurrent(){},budget:{beginCustomProbe(){assert.fail('unexpected permit');}}};
  await assert.rejects(runCustomProbeRuntime(probe),{code:'CUSTOM_PROBE_BINDING_CHANGED'});
  const unknown={...frozen,provider:'offline-provider',authentication:'api_key',model:{kind:'model',id:'unverified'}};
  assert.throws(()=>owner.qualifiedCustomMagpieRoute(session,input,unknown),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
  await assert.rejects(runCustomProbeRuntime({...probe,selectedRole:unknown}),{code:'CUSTOM_MAGPIE_ROUTE_UNSUPPORTED'});
});

test('GPT Planner 2 subscription is a distinct Magpie probe shape', () => {
  assert.equal(customProbeKind(actor), 'codex-subscription');
  assert.equal(customProbeRouteRuntime('codex-subscription'), 'codex');
  const transport = new MagpieDshRequestTransport({
    session: { observation: { address: '127.0.0.1:12345' } },
    budget: {},
    route: {
      runtime: customProbeRouteRuntime('codex-subscription'),
      provider: 'openai',
      protocol: 'openai-responses',
      model: 'gpt-6-luna',
      authentication: 'oauth',
      authRef: 'openai-chatgpt-main',
      accountRef: 'openai-chatgpt-main-account',
      upstreamAccountRef: 'openai/' + 'b'.repeat(64)
    },
    role: 'planner2',
    planner: { model: 'gpt-6-luna', maxOutputTokens: 128, prompt: 'offline', instructions: 'offline' },
    bindRequest() {},
    assertCurrent() {}
  });
  assert.equal(transport.upstream, 'http://127.0.0.1:12345/backend-api/codex/responses');
  for (const changed of [
    { ...actor, role: 'reviewer', roleId: 'reviewer' },
    { ...actor, role: 'executor', roleId: 'executor-one' },
    { ...actor, model: 'deepseek-flash' },
    { ...actor, authentication: 'API_KEY' },
    { ...actor, transport: 'native' }
  ]) {
    assert.throws(
      () => customProbeKind(changed),
      (error) => error?.code === 'CUSTOM_PROBE_RUNTIME_UNSUPPORTED'
    );
  }
});

test('DeepSeek API-key Codex remains on the existing Magpie probe shape', () => {
  assert.equal(
    customProbeKind({
      ...actor,
      provider: 'deepseek-official',
      authentication: 'API_KEY',
      model: 'deepseek-flash',
      authRef: 'deepseek-official-main',
      accountRef: 'deepseek-official-main-account'
    }),
    'codex'
  );
});

test('subscription probe binds the formal run id, never the qualification probe id', async (t) => {
  const h = harness(t);
  const runId = 'run_formal_probe_scope';
  const probeId = 'custom_probe_OFFLINE_SCOPE';
  const nonce = customProbeNonce();
  const permit = Object.freeze({});
  let observedInput;

  t.mock.method(CodexRunner.prototype, 'run', async (input) => {
    observedInput = input;
    return {
      text: nonce,
      sessionId: 'session_offline_subscription_probe',
      usage: {
        role: 'planner2',
        requestId: 'request_offline_subscription_probe',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: null,
        source: 'OFFLINE'
      },
      identity: {
        runner: 'CODEX_CLI',
        provider: 'magpie',
        authentication: 'CHATGPT_SUBSCRIPTION',
        model: actor.model
      }
    };
  });
  t.mock.method(DeepSeekGateway.prototype, 'start', async () => ({
    url: 'http://127.0.0.1:1/v1',
    token: 'offline-gateway-token'
  }));
  t.mock.method(DeepSeekGateway.prototype, 'confirmedSupervisorOutput', () => ({
    outcome: 'COMPLETE'
  }));
  t.mock.method(DeepSeekGateway.prototype, 'receipts', () => [{
    id: 'offline_receipt',
    minimalResponseVerified: true,
    completionObserved: true,
    outcome: 'COMPLETE',
    observedModel: actor.model,
    responseId: 'offline_response',
    responseSha256: 'a'.repeat(64)
  }]);
  t.mock.method(DeepSeekGateway.prototype, 'close', async () => {});

  const budget = {
    beginCustomProbe() {
      return permit;
    },
    endCustomProbe() {}
  };
  const session = {
    observation: {
      address: '127.0.0.1:12345',
      scope: 'LOCAL_CONTROL_PROCESS_ONLY', accountCount: 1, realCredentialsPermitted: true,
      accounts: [{
        authentication: selectedRole(actor).authentication, authRef: actor.authRef,
        accountRef: actor.accountRef,
        provider: actor.provider,
        model: actor.model,
        upstreamAccountRef: 'openai/' + 'b'.repeat(64)
      }]
    }
  };

  const result = await runCustomProbeRuntime({
    root: h.dir,
    getConfig: () => ({}),
    budget,
    session,
    actor, selectedRole: selectedRole(actor),
    context: {
      schema: 'dream-maker.custom-probe-budget.v1',
      probeId,
      bindingHash: 'a'.repeat(64),
      projectId: 'project_offline',
      runId,
      configurationHash: 'b'.repeat(64),
      planVersionHash: 'c'.repeat(64),
      specHash: 'd'.repeat(64),
      role: 'planner2',
      roleId: 'planner2',
      dispatchId: 'dispatch_offline',
      generation: 'generation_offline',
      flowBudget: { currency: 'CNY', maxMicros: 1000000 },
      roleBudget: { currency: 'CNY', maxMicros: 1000000 }
    },
    workspace: h.dir,
    nonce,
    signal: new AbortController().signal,
    maxOutputTokens: 8192,
    price: () => {
      throw new Error('OFFLINE_PRICE_MUST_NOT_RUN');
    },
    assertCurrent() {},
    emit() {}
  });

  assert.equal(observedInput.runId, runId);
  assert.notEqual(observedInput.runId, probeId);
  assert.equal(result.runner, 'CODEX');
});

test('independent probe accepts only its exact Magpie provider-qualified model', async (t) => {
  const actor = {
    role: 'reviewer',
    roleId: 'reviewer',
    runtime: 'independent',
    provider: 'deepseek-official',
    authentication: 'API_KEY',
    transport: 'magpie',
    model: 'deepseek-v4-pro',
    authRef: 'deepseek-official-main',
    accountRef: 'deepseek-official-main-account'
  };
  const attempt = async (outputModel) => {
    const h = harness(t), nonce = customProbeNonce();
    t.mock.method(IndependentRunner.prototype, 'run', async () => ({
      text: nonce,
      sessionId: 'response_offline_independent',
      model: outputModel,
      usage: {
        role: 'reviewer',
        requestId: 'response_offline_independent',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: null,
        source: 'OFFLINE'
      }
    }));
    t.mock.method(DeepSeekGateway.prototype, 'start', async () => ({
      url: 'http://127.0.0.1:1/v1',
      token: 'a'.repeat(64)
    }));
    t.mock.method(DeepSeekGateway.prototype, 'receipts', () => [{
      id: 'offline_receipt',
      minimalResponseVerified: true,
      completionObserved: true,
      outcome: 'COMPLETE',
      observedModel: actor.model,
      responseId: 'response_offline_independent',
      responseSha256: 'a'.repeat(64)
    }]);
    t.mock.method(DeepSeekGateway.prototype, 'close', async () => {});
    const budget = {beginCustomProbe: () => Object.freeze({}), endCustomProbe() {}};
    const session = {
      observation: {
        address: '127.0.0.1:12345',
        scope: 'LOCAL_CONTROL_PROCESS_ONLY', accountCount: 1, realCredentialsPermitted: true,
        accounts: [{
          authentication: selectedRole(actor).authentication, authRef: actor.authRef,
          accountRef: actor.accountRef,
          provider: actor.provider,
          model: actor.model,
          upstreamAccountRef: 'deepseek-official/0123456789'
        }]
      }
    };
    return runCustomProbeRuntime({
      root: h.dir,
      getConfig: () => ({}),
      budget,
      session,
      actor, selectedRole: selectedRole(actor),
      context: {
        schema: 'dream-maker.custom-probe-budget.v1',
        probeId: 'custom_probe_OFFLINE_INDEPENDENT',
        bindingHash: 'a'.repeat(64),
        projectId: 'project_offline',
        runId: 'run_offline_independent',
        configurationHash: 'b'.repeat(64),
        planVersionHash: 'c'.repeat(64),
        specHash: 'd'.repeat(64),
        role: 'reviewer',
        roleId: 'reviewer',
        dispatchId: 'dispatch_offline',
        generation: 'generation_offline',
        flowBudget: {currency: 'CNY', maxMicros: 1000000},
        roleBudget: {currency: 'CNY', maxMicros: 1000000}
      },
      workspace: h.dir,
      nonce,
      signal: new AbortController().signal,
      maxOutputTokens: 8192,
      price: () => { throw new Error('OFFLINE_PRICE_MUST_NOT_RUN'); },
      assertCurrent() {},
      emit() {}
    });
  };

  const accepted = await attempt('deepseek-official/deepseek-v4-pro');
  assert.equal(accepted.runner, 'INDEPENDENT_API');
  await assert.rejects(
    attempt('foreign-provider/deepseek-v4-pro'),
    (error) => error?.code === 'CUSTOM_PROBE_RESPONSE_UNVERIFIED'
  );
});

test('historical offline classification keeps Claude separate from DeepSeek reviewer CLIs',()=>{
 const reviewer={...actor,role:'reviewer',roleId:'reviewer',provider:'deepseek-official',authentication:'API_KEY'};
 assert.throws(()=>customProbeKind({...reviewer,runtime:'claude',model:'deepseek-flash'}),{code:'CUSTOM_PROBE_RUNTIME_UNSUPPORTED'});
 for(const runtime of ['opencode','cline'])assert.equal(customProbeKind({...reviewer,runtime,model:'deepseek-v4-pro'}),runtime);
});

test('DSH qualification stays Flash-only because Magpie licensing reserves V4 Pro for the independent Reviewer', () => {
  const base = {
    role: 'executor',
    roleId: 'executor-one',
    runtime: 'dsh',
    provider: 'deepseek-official',
    authentication: 'API_KEY',
    transport: 'magpie',
    authRef: 'deepseek-official-main',
    accountRef: 'deepseek-official-main-account'
  };
  assert.equal(customProbeKind({ ...base, model: 'deepseek-flash' }), 'dsh');
  assert.throws(
    () => customProbeKind({ ...base, model: 'deepseek-v4-pro' }),
    (error) => error?.code === 'CUSTOM_PROBE_RUNTIME_UNSUPPORTED' && /independent Reviewer/.test(error.message)
  );
  assert.throws(
    () => customProbeKind({ ...base, model: 'deepseek-chat' }),
    (error) => error?.code === 'CUSTOM_PROBE_RUNTIME_UNSUPPORTED'
  );
});
