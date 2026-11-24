#!/usr/bin/env node
// Run the trusted CLI verifier for real, in the WSL acceptance sandbox, with no model involved.
//
// The audit checks that validateVerifierPlan accepts the exact spec hash and refuses a foreign one;
// that is a pure-function check. This script exercises the part the audit cannot: an actual sandbox
// execution, its command/stdout evidence, and the fact that a wrong implementation is REPORTED as a
// failure instead of being papered over. It writes only inside .runtime/verifier-smoke.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WslVerifier } from '../dist/server/wsl-verifier.js';
import { treeHash } from '../dist/server/workspace.js';
import { hash } from '../dist/server/security.js';

const root = resolve('.');
const base = resolve(root, '.runtime/verifier-smoke');
const stamp = Date.now().toString(36);
const registry = resolve(base, 'registry');
mkdirSync(registry, { recursive: true });
const report = { schema: 'dream-maker.native-verifier.run.v1', at: new Date().toISOString(), runs: [] };

const specHash = hash({ requirements: ['R001'], probe: stamp });
const spec = { hash: specHash, requirements: [{ id: 'R001', text: 'the CLI prints PASS and exits 0' }] };
const plan = {
  schema: 'dream-maker.cli-verifier.v1', specHash,
  cases: [{ id: 'C1', requirementIds: ['R001'], runtime: 'node', entry: 'main.mjs', args: [], stdin: '', expectedExitCode: 0, expectedStdout: 'PASS\n' }]
};
const planPath = resolve(registry, 'plan-' + stamp + '.json');
writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
const approval = { relativePath: 'plan-' + stamp + '.json', sha256: createHash('sha256').update(JSON.stringify(plan, null, 2) + '\n').digest('hex') };

function workspace(name, source) {
  const dir = resolve(base, name + '-' + stamp);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'main.mjs'), source);
  return dir;
}
const verifier = new WslVerifier(root, registry, spec => (spec === specHash ? approval : null));
const input = (dir) => ({ role: 'reviewer', workspace: dir, prompt: JSON.stringify({ spec }), model: 'verifier', runId: 'verifier_probe_' + stamp, specHash, laya: { role: 'reviewer', mode: 'off', adoption: 'off', label: null, reason: 'TRUSTED_VERIFIER', latencyMs: 0, inputHash: '', modelRevision: null, confidence: null, cached: false }, signal: new AbortController().signal });

let failed = 0;
for (const [name, source, expectOk] of [
  ['correct', "console.log('PASS');\n", true],
  ['wrong-output', "console.log('FAIL');\n", false],
  ['wrong-exit', "process.exitCode = 3;\n", false]
]) {
  const dir = workspace(name, source);
  const before = treeHash(dir);
  try {
    const result = await verifier.verify(input(dir), () => { });
    const evidence = JSON.parse(result.stdout);
    const c = evidence.cases[0];
    const clean = treeHash(dir) === before;
    const ok = (result.exitCode === 0) === expectOk && c.ok === expectOk && clean;
    if (!ok) failed += 1;
    report.runs.push({ name, expectation: expectOk ? 'PASS' : 'FAIL', exitCode: result.exitCode, caseOk: c.ok, actualExitCode: c.actualExitCode, outputMatched: c.outputMatched, status: c.status, workspaceUnchanged: clean, command: Array.isArray(c.command) ? c.command.slice(0, 3).join(' ') : null });
    console.log((ok ? 'OK   ' : 'BAD  ') + name + ' expected=' + (expectOk ? 'PASS' : 'FAIL') + ' verifierExit=' + result.exitCode + ' caseOk=' + c.ok + ' outputMatched=' + c.outputMatched + ' status=' + c.status + ' workspaceUnchanged=' + clean);
  }
  catch (error) {
    failed += 1;
    report.runs.push({ name, error: String(error && error.code || error).slice(0, 160) });
    console.log('BAD  ' + name + ' threw ' + String(error && error.code || error).slice(0, 120));
  }
}
// A foreign spec hash must never reach the sandbox.
try {
  await verifier.verify({ ...input(workspace('foreign', "console.log('PASS');\n")), specHash: 'f'.repeat(64) }, () => { });
  failed += 1;
  console.log('BAD  foreign spec hash was accepted');
}
catch (error) {
  console.log('OK   foreign spec hash refused: ' + String(error && error.code || error));
  report.runs.push({ name: 'foreign-spec', refusedWith: String(error && error.code || error) });
}
console.log(JSON.stringify(report));
process.exitCode = failed ? 1 : 0;
