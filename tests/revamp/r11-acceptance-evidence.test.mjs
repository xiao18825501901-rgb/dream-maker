// OFFLINE R11 contract tests. No model, verifier process, or product write is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAcceptanceEvidence } from '../../dist/server/acceptance-evidence.js';
import {
  checkVerifierCase,
  validateVerifierPlan,
  verifierCaseEvidence,
} from '../../dist/server/wsl-verifier.js';

const specHash = 'a'.repeat(64);
const acceptanceItems = [
  { id: 'A1', requirementIds: ['R1'] },
  { id: 'A2', requirementIds: ['R2'] },
];
const caseDefinition = {
  id: 'C1',
  acceptanceIds: ['A1'],
  requirementIds: ['R1'],
  runtime: 'node',
  entry: 'main.mjs',
  args: [],
  stdin: 'input\n',
  expectedExitCode: 0,
  expectedStdout: 'OK\n',
};
const rawPlan = caseValue => ({
  schema: 'dream-maker.cli-verifier.v1',
  specHash,
  cases: [caseValue],
});

test('R11 plan binds cases to confirmed acceptance items without changing old plans', () => {
  const current = validateVerifierPlan(rawPlan(caseDefinition), specHash, ['R1'], [acceptanceItems[0]]);
  assert.deepEqual(current.cases[0].acceptanceIds, ['A1']);
  assert.deepEqual(verifierCaseEvidence(current.cases[0]).expected.acceptanceIds, ['A1']);
  assert.deepEqual(checkVerifierCase(current.cases[0], { exitCode: 0, stdout: 'OK\n', stderr: '' }).acceptanceIds, ['A1']);

  const { acceptanceIds: _omitted, ...legacyCase } = caseDefinition;
  const legacy = validateVerifierPlan(
    rawPlan(legacyCase),
    specHash,
    ['R1'],
    [acceptanceItems[0]],
  );
  assert.equal(Object.hasOwn(legacy.cases[0], 'acceptanceIds'), false);
  assert.equal(Object.hasOwn(verifierCaseEvidence(legacy.cases[0]).expected, 'acceptanceIds'), false);
  assert.equal(Object.hasOwn(checkVerifierCase(legacy.cases[0], { exitCode: 0, stdout: 'OK\n', stderr: '' }), 'acceptanceIds'), false);
});

test('R11 rejects unknown, duplicate, or under-covered acceptance mappings', () => {
  for (const acceptanceIds of [['UNKNOWN'], ['A1', 'A1'], []]) {
    assert.throws(
      () => validateVerifierPlan(rawPlan({ ...caseDefinition, acceptanceIds }), specHash, ['R1', 'R2'], acceptanceItems),
      { code: 'TRUSTED_VERIFIER_ACCEPTANCE_INVALID' },
    );
  }
  assert.throws(
    () => validateVerifierPlan(
      rawPlan({ ...caseDefinition, acceptanceIds: ['A2'] }),
      specHash,
      ['R1', 'R2'],
      acceptanceItems,
    ),
    { code: 'TRUSTED_VERIFIER_ACCEPTANCE_INVALID' },
  );
});

test('R11 projects explicit executable evidence while keeping manual acceptance NOT_RUN', () => {
  const plan = validateVerifierPlan(rawPlan(caseDefinition), specHash, ['R1'], [acceptanceItems[0]]);
  const evidence = buildAcceptanceEvidence({
    spec: {
      hash: specHash,
      requirements: [{ id: 'R1' }, { id: 'R2' }],
      acceptanceItems: [
        {
          id: 'A1',
          requirementIds: ['R1'],
          criterion: 'The command prints OK.',
          method: 'manual',
          source: 'USER_CONFIRMED',
          evidenceStatus: 'NOT_RUN',
        },
        {
          id: 'A2',
          requirementIds: ['R2'],
          criterion: 'A person checks the remaining visual detail.',
          method: 'manual',
          source: 'USER_CONFIRMED',
          evidenceStatus: 'NOT_RUN',
        },
      ],
    },
    plan,
    observed: [{ id: 'C1', acceptanceIds: ['A1'], requirementIds: ['R1'], ok: true, status: 'EXECUTED' }],
    evidenceId: 'rec_offline',
    planHash: 'b'.repeat(64),
    sourceHash: 'c'.repeat(64),
  });

  assert.equal(evidence.schema, 'dream-maker.acceptance-evidence.v1');
  assert.deepEqual(
    evidence.items.map(item => ({
      id: item.id,
      executableEvidenceStatus: item.executableEvidenceStatus,
      manualAcceptanceStatus: item.manualAcceptanceStatus,
      caseIds: item.caseIds,
    })),
    [
      { id: 'A1', executableEvidenceStatus: 'PASS', manualAcceptanceStatus: 'NOT_RUN', caseIds: ['C1'] },
      { id: 'A2', executableEvidenceStatus: 'NOT_RUN', manualAcceptanceStatus: 'NOT_RUN', caseIds: [] },
    ],
  );
  assert.deepEqual(evidence.coverage, {
    acceptanceItems: 2,
    withExecutableEvidence: 1,
    withoutExecutableEvidence: 1,
    passedExecutableEvidence: 1,
    failedExecutableEvidence: 0,
  });
  assert.equal(evidence.items[0].cases[0].ok, true);
});

test('R11 marks a failed mapped case FAIL and never upgrades a timeout', () => {
  const failing = { ...caseDefinition };
  const plan = validateVerifierPlan(rawPlan(failing), specHash, ['R1'], [acceptanceItems[0]]);
  const evidence = buildAcceptanceEvidence({
    spec: {
      hash: specHash,
      requirements: [{ id: 'R1' }, { id: 'R2' }],
      acceptanceItems: [{
        id: 'A1',
        requirementIds: ['R1'],
        criterion: 'The command prints OK.',
        method: 'manual',
        source: 'USER_CONFIRMED',
        evidenceStatus: 'NOT_RUN',
      }],
    },
    plan,
    observed: [{ id: 'C1', acceptanceIds: ['A1'], requirementIds: ['R1'], ok: true, status: 'TIMED_OUT' }],
    evidenceId: 'rec_offline',
    planHash: 'b'.repeat(64),
    sourceHash: 'c'.repeat(64),
  });
  assert.equal(evidence.items[0].executableEvidenceStatus, 'FAIL');
  assert.equal(evidence.items[0].manualAcceptanceStatus, 'NOT_RUN');
});
