import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVerifierPlan, checkVerifierCase } from '../dist/server/wsl-verifier.js';

const specHash = 'a'.repeat(64);
const required = ['R001'];
const base = { id: 'C1', requirementIds: ['R001'], runtime: 'node', entry: 'main.mjs', args: ['help'], stdin: '', expectedExitCode: 0 };
const plan = (...cases) => ({ schema: 'dream-maker.cli-verifier.v1', specHash, cases });

test('a case may assert a prefix when the spec only fixes the line prefix', () => {
    const parsed = validateVerifierPlan(plan({ ...base, expectedStdoutPrefix: 'USAGE' }), specHash, required);
    assert.equal(parsed.cases[0].expectedStdoutPrefix, 'USAGE');
    assert.equal(checkVerifierCase(parsed.cases[0], { exitCode: 0, stdout: 'USAGE node main.mjs add|tick\n', stderr: '' }).ok, true);
    assert.equal(checkVerifierCase(parsed.cases[0], { exitCode: 0, stdout: 'usage only\n', stderr: '' }).ok, false);
});

test('exactly one of expectedStdout / expectedStdoutPrefix is required', () => {
    assert.throws(() => validateVerifierPlan(plan({ ...base }), specHash, required), /TRUSTED_VERIFIER_OUTPUT_INVALID/);
    assert.throws(() => validateVerifierPlan(plan({ ...base, expectedStdout: 'x', expectedStdoutPrefix: 'x' }), specHash, required), /TRUSTED_VERIFIER_OUTPUT_INVALID/);
    const exact = validateVerifierPlan(plan({ ...base, expectedStdout: 'LIST 0\n' }), specHash, required);
    assert.equal(checkVerifierCase(exact.cases[0], { exitCode: 0, stdout: 'LIST 0\n', stderr: '' }).ok, true);
});

// The plan used to declare setup COMMANDS. They can never work: the sandbox runs every command against a
// staged copy, discards its writes and proves the tree unchanged. State has to arrive as fixtures the
// verifier itself writes, and the cases that depended on state were failing on empty input.
test('a case carries its state as fixtures written into its own copy', () => {
    const parsed = validateVerifierPlan(plan({
        ...base,
        args: ['streak', 'water', '--file', 'sample.json', '--today', '2026-01-03'],
        expectedStdout: 'STREAK water 3\n',
        fixtures: { 'sample.json': '{"items":{"water":["2026-01-01"]}}' }
    }), specHash, required);
    assert.deepEqual(Object.keys(parsed.cases[0].fixtures), ['sample.json']);
    assert.equal(parsed.cases[0].fixtures['sample.json'], '{"items":{"water":["2026-01-01"]}}');
});

test('fixture paths are held to the entry rule and stay bounded', () => {
    const withFixture = fixtures => validateVerifierPlan(plan({ ...base, expectedStdout: 'x', fixtures }), specHash, required);
    assert.throws(() => withFixture({ '../escape.json': 'x' }), /TRUSTED_VERIFIER_FIXTURE_INVALID/);
    assert.throws(() => withFixture({ 'node_modules/dep.json': 'x' }), /TRUSTED_VERIFIER_FIXTURE_INVALID/);
    assert.throws(() => withFixture({ 'main.mjs': 'x' }), /TRUSTED_VERIFIER_FIXTURE_INVALID/);
    assert.throws(() => withFixture(Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(n => [n + '.json', '{}']))), /TRUSTED_VERIFIER_FIXTURE_INVALID/);
    assert.throws(() => withFixture({ 'big.json': 'x'.repeat(8193) }), /TRUSTED_VERIFIER_FIXTURE_INVALID/);
    assert.throws(() => withFixture({ 'a.json': 1 }), /TRUSTED_VERIFIER_FIXTURE_INVALID/);
});

// Exit 3 with empty stdout is exactly what a program that answers every command with exit 3 produces.
// The spec puts the failure signal on stderr ('任何失败向 stderr 打印一行 ERROR <code> 并 exit 3'), so a
// failure case has to assert that line or it grades nothing.
test('a failure case can assert the diagnostic, and silence fails it', () => {
    const parsed = validateVerifierPlan(plan({ ...base, expectedExitCode: 3, expectedStdout: '', expectedStderrPrefix: 'ERROR ' }), specHash, required);
    assert.equal(checkVerifierCase(parsed.cases[0], { exitCode: 3, stdout: '', stderr: 'ERROR NO_DATA\n' }).ok, true);
    const silent = checkVerifierCase(parsed.cases[0], { exitCode: 3, stdout: '', stderr: '' });
    assert.equal(silent.ok, false);
    assert.equal(silent.diagnosticMatched, false);
    assert.equal(checkVerifierCase(parsed.cases[0], { exitCode: 3, stdout: '', stderr: 'boom\n' }).ok, false);
});

test('an exact diagnostic is available for the two codes the owner confirmed', () => {
    const parsed = validateVerifierPlan(plan({ ...base, expectedExitCode: 3, expectedStdout: '', expectedStderr: 'ERROR UNKNOWN_COMMAND\n' }), specHash, required);
    assert.equal(checkVerifierCase(parsed.cases[0], { exitCode: 3, stdout: '', stderr: 'ERROR UNKNOWN_COMMAND\n' }).ok, true);
    assert.equal(checkVerifierCase(parsed.cases[0], { exitCode: 3, stdout: '', stderr: 'ERROR NO_DATA\n' }).ok, false);
    assert.throws(() => validateVerifierPlan(plan({ ...base, expectedStdout: 'x', expectedStderr: 'a', expectedStderrPrefix: 'a' }), specHash, required), /TRUSTED_VERIFIER_DIAGNOSTIC_INVALID/);
});

// R005 makes every date flag default to the machine's local day, so the correct output of an omitted flag is a
// real date but not a knowable literal: run_92f9a3910692ee861c1d shipped ERROR BAD_DATE there and only the
// reviewer caught it. A pattern is the honest assertion for that shape.
test('a case may assert the shape of a value the spec leaves to the clock', () => {
    const parsed = validateVerifierPlan(plan({ ...base, args: ['tick', 'water', '--file', 'now.json'], expectedStdoutMatch: '^TICKED water \\d{4}-\\d{2}-\\d{2}\\n$' }), specHash, required);
    assert.equal(checkVerifierCase(parsed.cases[0], { exitCode: 0, stdout: 'TICKED water 2026-10-30\n', stderr: '' }).ok, true);
    assert.equal(checkVerifierCase(parsed.cases[0], { exitCode: 0, stdout: 'TICKED water 2026-1-3\n', stderr: '' }).ok, false);
    assert.equal(checkVerifierCase(parsed.cases[0], { exitCode: 0, stdout: 'ERROR BAD_DATE\n', stderr: '' }).ok, false);
    assert.equal(checkVerifierCase(parsed.cases[0], { exitCode: 3, stdout: 'TICKED water 2026-10-30\n', stderr: '' }).ok, false);
});
test('the three stdout modes are mutually exclusive and a pattern must compile', () => {
    assert.throws(() => validateVerifierPlan(plan({ ...base, expectedStdout: 'x', expectedStdoutMatch: '^x$' }), specHash, required), /TRUSTED_VERIFIER_OUTPUT_INVALID/);
    assert.throws(() => validateVerifierPlan(plan({ ...base, expectedStdoutPrefix: 'x', expectedStdoutMatch: '^x$' }), specHash, required), /TRUSTED_VERIFIER_OUTPUT_INVALID/);
    assert.throws(() => validateVerifierPlan(plan({ ...base, expectedStdoutMatch: '(unclosed' }), specHash, required), /TRUSTED_VERIFIER_OUTPUT_INVALID/);
    assert.throws(() => validateVerifierPlan(plan({ ...base, expectedStdoutMatch: '^' + 'x'.repeat(300) + '$' }), specHash, required), /TRUSTED_VERIFIER_OUTPUT_INVALID/);
});

test('stderr is not asserted unless the case declares it', () => {
    const parsed = validateVerifierPlan(plan({ ...base, expectedStdout: 'ADDED tea\n' }), specHash, required);
    assert.equal(checkVerifierCase(parsed.cases[0], { exitCode: 0, stdout: 'ADDED tea\n', stderr: 'warning: something\n' }).ok, true);
});

test('an unexercised requirement is still refused', () => {
    assert.throws(() => validateVerifierPlan(plan({ ...base, expectedStdout: 'x' }), specHash, ['R001', 'R002']), /TRUSTED_VERIFIER_COVERAGE_MISSING/);
});
