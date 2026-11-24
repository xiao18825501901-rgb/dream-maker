// OFFLINE explicit Custom identities; original Engine/Store/Dispatch boundaries.
// No model, credential, Magpie account or live qualification is exercised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {harness,ready,root,bindOfflineApi} from '../helpers.mjs';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';
import {seedOfflineSqliteReview} from '../fixtures/sqlite-review.mjs';
import {FlowProfiles} from '../../dist/server/flow-profiles.js';
import {NativeOwner} from '../../dist/server/native-owner.js';
import {SqliteDatasets} from '../../dist/server/sqlite-data.js';
import {sqliteInputDescriptor} from '../../dist/server/sqlite-channel.js';
import {prepareSqliteRuntimeCommand} from '../../dist/server/data-runtime-plan.js';
import {WslSandbox,WSL_ENVIRONMENT} from '../../dist/server/wsl-sandbox.js';
import {withProcessOwnership} from '../../dist/server/flow/process-ownership.js';
import {DomainError,hash} from '../../dist/server/security.js';
import {treeHash} from '../../dist/server/workspace.js';

const actor = 'local-session:' + 'a'.repeat(64);
const reviewerSession = 'OFFLINE_CUSTOM_REVIEWER_SESSION';
const reviewerRequest = 'OFFLINE_CUSTOM_REVIEWER_REQUEST';
const plan = {
  schema: 'dream-maker.sqlite-runtime-plan.v1',
  protocol: 'SQLITE_IMAGE_V1',
  runtime: 'python',
  entry: 'data.py',
  args: [],
};
const healthyVolume = async () => ({
  schema: 'dream-maker.storage-volume-health.v1',
  scope: 'VOLUME_HEALTH_ONLY',
  drive: 'F:',
  fileSystem: 'NTFS',
  healthStatus: 'Healthy',
  operationalStatus: 'OK',
  totalBytes: 1000000,
  availableBytes: 500000,
  state: 'HEALTHY',
  evidence: 'WINDOWS_STORAGE_READ_ONLY',
  checkedAt: '2026-11-08T00:00:00.000Z',
});

function sqliteExchange(input, image) {
  const descriptor = sqliteInputDescriptor(input.image, input.binding);
  const sha256 = hash(image);
  const result = {
    schema: 'dream-maker.wsl-result.v1',
    jobId: 'wsl_job_offline_custom_sqlite',
    sourceHash: input.sourceHash,
    workerHash: hash(readFileSync(root + '/scripts/isolation/wsl-worker.py', 'utf8')),
    environment: WSL_ENVIRONMENT,
    status: 'EXECUTED',
    exitCode: 0,
    stdout: '',
    stderr: '',
    cleanup: {
      remainingPids: [],
      groupRemoved: true,
      delegationRestored: true,
      sourceUnchanged: true,
    },
    sqlite: {
      ...descriptor,
      schema: 'dream-maker.sqlite-execution.v1',
      snapshotHelperHash: hash(readFileSync(root + '/scripts/isolation/sqlite-snapshot.py', 'utf8')),
      snapshotStatus: 'READY',
      snapshot: {
        schema: 'dream-maker.sqlite-snapshot.v1',
        bytes: image.length,
        sha256,
        sqliteVersion: '3.45.1',
        integrity: 'ok',
      },
      generatedPidsAfter: [],
      snapshotPidsAfter: [],
      privateMountNamespace: true,
      runTmpfsBytes: 33554432,
      dataTmpfsBytes: 218103808,
      mountsRemoved: true,
      retention: {
        schema: 'dream-maker.sqlite-retention.v1',
        state: 'RETAINED',
        bytes: image.length,
        manifestHash: 'b'.repeat(64),
      },
    },
  };
  return {
    result,
    image,
    exchangeMetadata: {
      schema: 'dream-maker.sqlite-frame.v1',
      kind: 'SQLITE_IMAGE_V1',
      ...input.binding,
      imageBytes: image.length,
      imageHash: sha256,
      result,
    },
  };
}

async function setup(t) {
  const h = harness(t);
  fixedControllerCapacity(h.engine);
  bindOfflineApi(h.config);
  const {p, s} = await ready(h, 'live');
  const account = {
    provider: 'deepseek-official',
    authentication: 'api_key',
    authRef: 'SYNTHETIC_CUSTOM_AUTH',
    accountRef: 'SYNTHETIC_CUSTOM_ACCOUNT',
  };
  const role = (id, write = false) => ({
    id,
    ...account,
    runtime: 'dsh',
    model: {kind: 'model', id: 'deepseek-flash'},
    transport: 'magpie',
    nativeException: false,
    permissions: write ? ['source_read', 'source_write'] : ['source_read'],
    budget: {currency: 'CNY', maxMicros: 1000000},
  });
  const configuration = {
    mode: 'custom',
    laya: false,
    accounts: [account],
    roles: {
      planner2: role('planner2'),
      executors: [role('worker-one', true)],
      reviewer: role('reviewer'),
    },
    groups: [],
    privacy: {deniedProviders: [], deniedDataLabels: []},
    budget: {currency: 'CNY', maxMicros: 2000000},
    timeZone: 'Asia/Shanghai',
  };
  const profile = new FlowProfiles(h.store).confirm(
    p.id,
    {configuration, expectedRevision: 0, confirmed: true},
    actor,
    'OFFLINE_CUSTOM_SQLITE_PROFILE',
  );
  const prepared = h.engine.prepareCustomFlow(p.id, s.hash, profile.contentHash);
  const calls = {customReady: 0, classic: 0, data: 0, custom: 0};
  const imagePath = join(h.dir, 'offline-custom.sqlite');
  const database = new DatabaseSync(imagePath);
  database.exec("CREATE TABLE notes(value TEXT); INSERT INTO notes VALUES('CUSTOM_SQLITE_VALUE')");
  database.close();
  const image = readFileSync(imagePath);
  h.engine.nativeExecution = {
    assertReady() {
      calls.classic++;
      throw new DomainError('CLASSIC_ADMISSION_MUST_NOT_RUN', 409);
    },
    assertCustomReady(snapshot) {
      calls.customReady++;
      assert.equal(snapshot.mode, 'custom');
      assert.equal(snapshot.runId, prepared.flowConfig.runId);
    },
    custom() {
      calls.custom++;
      throw new DomainError('CUSTOM_MODEL_MUST_NOT_RUN', 409);
    },
    executor() {
      calls.classic++;
      throw new DomainError('CLASSIC_EXECUTOR_MUST_NOT_RUN', 409);
    },
    async verify() {
      throw new Error('VERIFIER_NOT_USED_BY_THIS_FIXTURE');
    },
    async runSqliteData(input) {
      calls.data++;
      return sqliteExchange(input, image);
    },
    async close() {},
  };
  h.engine.launch = () => {};
  const created = h.engine.create(p.id, s.hash, true, false, 'custom');
  h.store.release(p.id, created.id);
  const run = h.store.run(created.id);
  run.state = 'READY_FOR_DELIVERY';
  run.phase = 'REVIEWING';
  run.treeHash = treeHash(run.workspace);
  run.verification = {
    ok: true,
    exitCode: 0,
    command: [],
    stdout: '',
    stderr: '',
    treeHash: run.treeHash,
    at: '2026-11-08T00:00:00.000Z',
    evidenceId: 'rec_offline_custom_verification',
  };
  run.roleIdentities = {
    ...(run.roleIdentities ?? {}),
    reviewer: {
      runner: 'DSH',
      runtime: 'dsh',
      provider: account.provider,
      authentication: 'API_KEY',
      model: 'deepseek-flash',
      roleId: 'reviewer',
      authRef: account.authRef,
      accountRef: account.accountRef,
      configurationHash: run.flowConfigHash,
      routeHash: hash('OFFLINE_CUSTOM_REVIEWER_ROUTE'),
      sessionId: reviewerSession,
      requestId: reviewerRequest,
    },
  };
  run.sessions.reviewer = reviewerSession;
  run.plan = {...run.plan, dataRuntime: plan};
  run.review = null;
  h.store.saveRun(run);
  const review = seedOfflineSqliteReview(h.store, h.store.run(run.id), 'DSH');
  const current = h.store.run(run.id);
  const data = new SqliteDatasets(h.store, root, h.dir, {}, healthyVolume);
  h.engine.sqliteData = data;
  return {h, p, s, run: current, prepared, image, calls, review, data};
}

test('a real Custom Flow executes protected SQLite through its own qualification, not Classic', async t => {
  const x = await setup(t);
  const operation = hash('OFFLINE_CUSTOM_SQLITE_OPERATION');
  const result = await x.h.engine.executeSqliteData(
    x.run.id,
    x.run.treeHash,
    0,
    true,
    operation,
    actor,
  );
  assert.equal(result.revision, 1);
  assert.equal(result.operation.replayed, false);
  assert.equal(x.calls.data, 1);
  assert.equal(x.calls.customReady >= 2, true);
  assert.equal(x.calls.classic, 0);
  assert.equal(x.calls.custom, 0);
});

test('Custom review source is derived from the recorded DSH identity and drift fails closed', async t => {
  const x = await setup(t);
  const run = x.h.store.run(x.run.id);
  run.roleIdentities.reviewer.accountRef = 'FOREIGN_ACCOUNT';
  x.h.store.saveRun(run);
  await assert.rejects(
    x.h.engine.executeSqliteData(
      run.id,
      run.treeHash,
      0,
      true,
      hash('OFFLINE_CUSTOM_SQLITE_DRIFT'),
      actor,
    ),
    {code: 'SQLITE_DATA_REVIEW_BINDING_REQUIRED'},
  );
  assert.equal(x.calls.data, 0);
  assert.equal(x.calls.classic, 0);
});

test('NativeOwner routes Custom SQLite through Custom qualification and the existing binary worker', async t => {
  const x = await setup(t);
  const owner = Object.create(NativeOwner.prototype);
  owner.context = {
    root,
    store: x.h.store,
    getConfig: () => x.h.config,
    getSecret: () => {
      throw Error('NO_CREDENTIAL_ACCESS');
    },
  };
  const calls = {customReady: 0, classic: 0, worker: 0};
  owner.assertCustomReady = snapshot => {
    calls.customReady++;
    assert.equal(snapshot.runId, x.run.id);
  };
  owner.assertReady = () => {
    calls.classic++;
    throw new DomainError('CLASSIC_ADMISSION_MUST_NOT_RUN', 409);
  };
  const sentinel = {
    result: {marker: 'OFFLINE_CUSTOM_WORKER_NOT_LAUNCHED'},
    image: null,
    exchangeMetadata: {},
  };
  let seen;
  t.mock.method(WslSandbox.prototype, 'runSqlite', async (...args) => {
    calls.worker++;
    seen = args;
    return sentinel;
  });
  const binding = {inputHash: 'a'.repeat(64), expectedRevision: 0};
  const input = {
    runId: x.run.id,
    specHash: x.run.specHash,
    sourceHash: x.run.treeHash,
    planHash: hash(plan),
    command: prepareSqliteRuntimeCommand(plan, binding),
    image: null,
    binding,
    signal: new AbortController().signal,
  };
  const scope = {
    store: x.h.store,
    projectId: x.p.id,
    runId: x.run.id,
    dispatchId: 'OFFLINE_CUSTOM_SQLITE_DISPATCH',
    generation: 'OFFLINE_GENERATION',
    mode: 'live',
  };
  const result = await withProcessOwnership(scope, () => owner.runSqliteData(input));
  assert.equal(result, sentinel);
  assert.equal(calls.customReady, 1);
  assert.equal(calls.classic, 0);
  assert.equal(calls.worker, 1);
  assert.equal(seen[0], x.run.workspace);
  assert.equal(seen[4].signal, input.signal);
});
