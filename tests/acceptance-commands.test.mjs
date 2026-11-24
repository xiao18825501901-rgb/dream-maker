import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceCommands } from '../dist/server/acceptance-commands.js';

// The regression this pins: the plan spells a case as {runtime, entry, args}. Reading a "command" field
// that the plan never carries made every injected acceptance entry 'command: undefined', so the executor
// was never actually told the argv it would be graded on.
const plan = (cases) => ({ schema: 'dream-maker.cli-verifier.v1', specHash: 'a'.repeat(64), cases });
const c = (extra) => ({ id: 'C1', requirementIds: ['R001'], runtime: 'node', entry: 'main.mjs', args: ['help'], stdin: '', expectedExitCode: 0, expectedStdoutPrefix: 'USAGE', ...extra });

test('an acceptance case reaches the executor as real argv, not undefined', () => {
    const rows = acceptanceCommands(plan([c()]));
    assert.deepEqual(rows, [{ id: 'C1', command: ['main.mjs', 'help'] }]);
});

test('setup steps are handed over too, so the executor can build the asserted state', () => {
    const rows = acceptanceCommands(plan([c({
        id: 'C3',
        args: ['streak', 'water', '--file', 'sample.json', '--today', '2026-01-03'],
        expectedStdout: 'STREAK water 3\n',
        setup: [{ runtime: 'node', entry: 'main.mjs', args: ['add', '--name', 'water', '--file', 'sample.json'], stdin: '' }]
    })]));
    assert.deepEqual(rows, [{
        id: 'C3',
        command: ['main.mjs', 'streak', 'water', '--file', 'sample.json', '--today', '2026-01-03'],
        setup: [['main.mjs', 'add', '--name', 'water', '--file', 'sample.json']]
    }]);
});

test('expected output is never part of what the executor is shown', () => {
    const rows = acceptanceCommands(plan([c({ expectedStdout: 'ADDED tea\n', args: ['add', '--name', 'tea', '--file', 'work.json'] })]));
    assert.doesNotMatch(JSON.stringify(rows), /ADDED tea/);
    assert.doesNotMatch(JSON.stringify(rows), /USAGE/);
});

test('a malformed or absent plan degrades to null instead of inventing commands', () => {
    assert.equal(acceptanceCommands(null), null);
    assert.equal(acceptanceCommands(undefined), null);
    assert.equal(acceptanceCommands({}), null);
    assert.equal(acceptanceCommands({ cases: [] }), null);
    assert.equal(acceptanceCommands(plan([{ id: 'C9', entry: 'main.mjs' }])), null);
    assert.equal(acceptanceCommands(plan([{ id: 'C9', entry: 'main.mjs', args: [1] }])), null);
    assert.deepEqual(acceptanceCommands(plan([{ id: 'C9', entry: 'main.mjs' }, c()])), [{ id: 'C1', command: ['main.mjs', 'help'] }]);
});
