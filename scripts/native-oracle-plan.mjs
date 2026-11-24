#!/usr/bin/env node
// Derive a trusted CLI verifier plan from a frozen spec - and REFUSE when the spec does not decide
// enough to write one. The refusal lists exactly which decisions are missing, so 'no oracle yet'
// becomes a concrete request instead of a vague gap. It never invents expected output.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
const root = resolve('.');
const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
const projectId = flag('project');
// --spec-text checks a PROPOSED spec before it exists in the store. A plan built that way cannot be
// registered: its specHash is not a real project spec, so native-oracles.mjs refuses it.
const specTextPath = flag('spec-text');
if (!projectId && !specTextPath) { console.log('usage: node scripts/native-oracle-plan.mjs --project <id> | --spec-text <file> [--spec-hash <h>] [--out plan.json]'); process.exit(2); }
let spec;
if (specTextPath) {
  const textModule = await import('node:fs');
  spec = { hash: flag('spec-hash') ?? 'PROPOSAL_ONLY_NOT_A_REAL_SPEC', requirements: [{ id: 'PROPOSAL', text: textModule.readFileSync(resolve(root, specTextPath), 'utf8') }] };
  console.log('PROPOSAL_MODE ' + specTextPath);
} else {
  const db = new DatabaseSync(resolve(root, '.runtime/dream-maker.sqlite'), { readOnly: true });
  const project = JSON.parse(String(db.prepare('SELECT data FROM projects WHERE id = ?').get(projectId)?.data ?? 'null'));
  if (!project || !project.specId) { console.log('REFUSED NO_APPROVED_SPEC'); process.exit(2); }
  spec = JSON.parse(String(db.prepare('SELECT data FROM specs WHERE id = ?').get(project.specId).data));
  db.close();
}
// Decisions may live in the requirement text OR in the owner-confirmed acceptance items (that is where
// a semantic revision stores them), so both are scanned.
const requirementText = (spec.requirements || []).map(r => String(r.text ?? '')).join(' ' + String.fromCharCode(10));
const acceptanceText = (spec.acceptanceItems || []).map(a => String(a.criterion ?? '')).join(' ' + String.fromCharCode(10));
const text = requirementText + String.fromCharCode(10) + acceptanceText;
const has = needle => text.includes(needle);
const decisions = [
  { name: 'entry: node main.mjs', ok: has('node main.mjs') },
  { name: 'subcommands add/tick/streak/list/help', ok: ['add', 'tick', 'streak', 'list', 'help'].every(has) },
  { name: 'success line ADDED <name>', ok: has('ADDED') },
  { name: 'success line TICKED <name> <date>', ok: has('TICKED') },
  { name: 'success line STREAK <name> <n>', ok: has('STREAK') },
  { name: 'success line LIST <count>', ok: has('LIST') },
  { name: 'help line USAGE', ok: has('USAGE') },
  { name: 'failure channel: stderr ERROR <code>', ok: has('ERROR') && has('stderr') },
  { name: 'failure exit code 3', ok: /exit\s*3|退出码\s*3/.test(text) },
  { name: 'date format YYYY-MM-DD', ok: has('YYYY-MM-DD') },
  { name: 'sample.json fixture for state injection', ok: has('sample.json') },
].concat(['NO_SUCH_ITEM', 'BAD_DATE', 'DUPLICATE_TICK', 'BAD_ARGS', 'UNKNOWN_COMMAND'].map(code => ({ name: 'error code ' + code, ok: has(code) })));
// ---- generic path ----
const genericCases = (() => {
  const entryMatch = text.match(/node\s+([A-Za-z0-9_./-]+\.(?:mjs|js))/);
  const failExitMatch = text.match(/(?:退出码|exit code|exit)\s*`?([1-9][0-9]?)/i);
  const errorChannel = /stderr|标准错误/.test(text);
  const errorToken = (text.match(/ERROR\s+<?[A-Za-z_]*>?/) || [])[0];
  const decisions = [
    { name: 'entry command naming a file', ok: Boolean(entryMatch) },
    { name: 'failure exit code', ok: Boolean(failExitMatch) },
    { name: 'failure channel stderr', ok: errorChannel },
    { name: 'failure line token (ERROR ...)', ok: Boolean(errorToken) },
  ];
  const statedStdout = /(打印|输出|输出行|stdout)[^。\n]{0,40}(ADDED|TICKED|LIST|TOTAL|OK|[A-Z]{2,})/.test(text) || /[A-Z]{3,}\s*<[^>]*>/.test(text);
  decisions.push({ name: 'stated stdout line (the verifier needs one per case)', ok: statedStdout });
  if (decisions.some(d => !d.ok)) return { decisions, cases: null };
  const entry = entryMatch[1].split('/').pop();
  const exitCode = Number(failExitMatch[1]);
  const prefix = String(errorToken).replace(/<[^>]*>/g, '').trim();
  const seenCmds = new Set();
  const pairMatches = [...text.matchAll(/([a-z][a-z0-9-]{0,15})\s*(?:打印|输出)\s*([A-Z][A-Z0-9_]{1,15})/g)]
    .filter(m => { if (seenCmds.has(m[1])) return false; seenCmds.add(m[1]); return true; })
    .slice(0, 12);
  console.log('GENERIC_DEDUP ' + pairMatches.length);
  const pair = pairMatches[0] || null;
  if (!pair) return { decisions: decisions.concat([{ name: 'stated success line to assert', ok: false }]), cases: null };
  const sub = pair[1];
  const token = pair[2];
  const cases = pairMatches.map((m, i) => ({
    id: 'G' + (i + 1) + '-' + m[1] + '-' + m[2].toLowerCase(),
    note: 'asserts the success line the spec states; exit 0 follows from the spec defining exit ' + failExitMatch[1] + ' only for failures',
    runtime: 'node',
    entry,
    args: [m[1]],
    stdin: '',
    expectedExitCode: 0,
    expectedStdoutPrefix: m[2],
  }));
  console.log('GENERIC_CASE_COUNT ' + cases.length);
  return { decisions, cases };
})();
let missing = 0;
for (const d of decisions) { if (!d.ok) missing += 1; console.log((d.ok ? 'PASS ' : 'MISSING ') + d.name); }
if (missing > 0 && (!genericCases.cases || genericCases.cases.length === 0)) {
  console.log('');
  console.log('REFUSED SPEC_DOES_NOT_DECIDE_ENOUGH (' + missing + ' missing): a plan written now would invent expected output.');
  console.log('spec ' + spec.hash);
  process.exit(1);
}
if (missing > 0) {
  console.log('GENERIC_PATH ' + JSON.stringify(genericCases.decisions));
  const genericAcceptanceIds = (spec.acceptanceItems || []).map(a => String(a.id));
const cases = genericCases.cases.map(one => ({
  ...one,
  requirementIds: (spec.requirements || []).map(r => String(r.id)),
  ...(genericAcceptanceIds.length === 1 ? { acceptanceIds: [genericAcceptanceIds[0]] } : {}),
}));
console.log('GENERIC_ACCEPTANCE ' + JSON.stringify({acceptanceItems: genericAcceptanceIds, bound: genericAcceptanceIds.length === 1}));
  const plan = { schema: 'dream-maker.cli-verifier.v1', specHash: spec.hash, cases };
  const body = JSON.stringify(plan, null, 2) + String.fromCharCode(10);
  const out = flag('out') ?? 'delivery/oracle-plan-' + spec.hash.slice(0, 12) + '.json';
  writeFileSync(resolve(root, out), body);
  console.log('PLAN_WRITTEN ' + out + ' cases=' + cases.length + ' planHash=' + createHash('sha256').update(body).digest('hex'));
  process.exit(0);
}

const entry = 'main.mjs';
// Each case names the owner-confirmed acceptance item it exercises, and requirement coverage is
// derived from that item. It used to be a hardcoded ['R001'] on every case: that produced a plan
// that only covered one requirement out of eleven, and nothing said so until the registrar refused
// it. An unknown acceptance id is now a refusal, not a silent fallback.
const acceptanceItems = (spec.acceptanceItems || []).map(item => ({ id: String(item.id), requirementIds: (item.requirementIds || []).map(String) }));
const requirementsOf = ids => {
  const covered = new Set();
  for (const id of ids) {
    const item = acceptanceItems.find(candidate => candidate.id === id);
    if (!item) {
      console.log('REFUSED PLAN_ACCEPTANCE_ITEM_UNKNOWN: ' + id + ' is not an acceptance item of spec ' + spec.hash);
      process.exit(1);
    }
    for (const requirement of item.requirementIds) covered.add(requirement);
  }
  return [...covered];
};
// A proposal-mode spec has no acceptance items at all, so it keeps the single-requirement attribution
// and stays explicitly non-registrable.
const proposalFallback = specTextPath ? [(spec.requirements || [])[0]?.id ?? 'PROPOSAL'] : null;
// State arrives in the DELIVERED file, not in a fixture the verifier invents: acceptance item A5
// (USER_CONFIRMED) requires the delivery itself to ship sample.json with exactly items.water =
// 2026-01-01/02/03, and pins it as the injection vehicle. An earlier version of this plan injected the
// same data as a fixture, which made the plan pass while the delivery shipped no sample.json at all —
// run_a0ec14050b0822eb9236 delivered main.mjs alone and still went green. The only fixture left is the
// empty-items file, because A6's 'LIST 0' needs a data file the spec does not otherwise supply.
const EMPTY = JSON.stringify({ items: {} });
// A3 (USER_CONFIRMED) fixes the code catalogue, so failure cases assert the line byte for byte. NO_DATA
// is pinned by R009. Asserting only 'exit 3' let a program that exits 3 on everything pass.
const code = 'ERROR ';
const CASES = [
  { id: 'C1-help', acceptanceIds: ['A1-entry'], runtime: 'node', entry, args: ['help'], stdin: '', expectedExitCode: 0, expectedStdoutPrefix: 'USAGE' },
  { id: 'C2-list-sample', acceptanceIds: ['A2-success-lines', 'A5-storage-and-fixture'], runtime: 'node', entry, args: ['list', '--file', 'sample.json'], stdin: '', expectedExitCode: 0, expectedStdout: 'LIST 1' + String.fromCharCode(10) + 'water' + String.fromCharCode(10) },
  { id: 'C3-streak-3', acceptanceIds: ['A2-success-lines', 'A4-date-and-streak'], runtime: 'node', entry, args: ['streak', 'water', '--file', 'sample.json', '--today', '2026-01-03'], stdin: '', expectedExitCode: 0, expectedStdout: 'STREAK water 3' + String.fromCharCode(10) },
  { id: 'C4-streak-gap-0', acceptanceIds: ['A4-date-and-streak'], runtime: 'node', entry, args: ['streak', 'water', '--file', 'sample.json', '--today', '2026-01-05'], stdin: '', expectedExitCode: 0, expectedStdout: 'STREAK water 0' + String.fromCharCode(10) },
  { id: 'C5-add-new', acceptanceIds: ['A2-success-lines', 'A6-names-and-edges'], runtime: 'node', entry, args: ['add', '--name', 'tea', '--file', 'work.json'], stdin: '', expectedExitCode: 0, expectedStdout: 'ADDED tea' + String.fromCharCode(10) },
  { id: 'C6-add-duplicate', acceptanceIds: ['A6-names-and-edges'], runtime: 'node', entry, args: ['add', '--name', 'water', '--file', 'sample.json'], stdin: '', expectedExitCode: 0, expectedStdout: 'ADDED water' + String.fromCharCode(10) },
  { id: 'C7-list-empty', acceptanceIds: ['A6-names-and-edges'], runtime: 'node', entry, args: ['list', '--file', 'empty.json'], stdin: '', expectedExitCode: 0, expectedStdout: 'LIST 0' + String.fromCharCode(10), fixtures: { 'empty.json': EMPTY } },
  { id: 'C8-unknown-item', acceptanceIds: ['A3-error-codes'], runtime: 'node', entry, args: ['streak', 'nope', '--file', 'sample.json', '--today', '2026-01-03'], stdin: '', expectedExitCode: 3, expectedStdout: '', expectedStderr: code + 'NO_SUCH_ITEM' + String.fromCharCode(10) },
  // The duplicate has to be ticked on the LATEST recorded date, not on an earlier one. 2026-01-02 is both an
  // existing record and an earlier-than-max tick, and the spec pins DUPLICATE_TICK for the first while never
  // saying whether "no backfill" outranks it: run_723e6d3bf0f7df625ce2 answered BAD_DATE there and was
  // blocked for it. 2026-01-03 is the max date, so the only applicable rule is the duplicate one.
  { id: 'C9-duplicate-tick', acceptanceIds: ['A3-error-codes'], runtime: 'node', entry, args: ['tick', 'water', '--file', 'sample.json', '--date', '2026-01-03'], stdin: '', expectedExitCode: 3, expectedStdout: '', expectedStderr: code + 'DUPLICATE_TICK' + String.fromCharCode(10) },
  { id: 'C10-bad-date', acceptanceIds: ['A3-error-codes'], runtime: 'node', entry, args: ['tick', 'water', '--file', 'sample.json', '--date', '2026-13-01'], stdin: '', expectedExitCode: 3, expectedStdout: '', expectedStderr: code + 'BAD_DATE' + String.fromCharCode(10) },
  { id: 'C11-future-date', acceptanceIds: ['A3-error-codes', 'A4-date-and-streak'], runtime: 'node', entry, args: ['tick', 'water', '--file', 'sample.json', '--date', '2999-01-01'], stdin: '', expectedExitCode: 3, expectedStdout: '', expectedStderr: code + 'BAD_DATE' + String.fromCharCode(10) },
  { id: 'C12-bad-args', acceptanceIds: ['A3-error-codes', 'A6-names-and-edges'], runtime: 'node', entry, args: ['add', '--name', 'x'.repeat(33), '--file', 'work.json'], stdin: '', expectedExitCode: 3, expectedStdout: '', expectedStderr: code + 'BAD_ARGS' + String.fromCharCode(10) },
  { id: 'C13-unknown-command', acceptanceIds: ['A3-error-codes'], runtime: 'node', entry, args: ['frobnicate', '--file', 'sample.json'], stdin: '', expectedExitCode: 3, expectedStdout: '', expectedStderr: code + 'UNKNOWN_COMMAND' + String.fromCharCode(10) },
  { id: 'C14-no-data', acceptanceIds: ['A3-error-codes', 'A5-storage-and-fixture'], runtime: 'node', entry, args: ['list', '--file', 'missing.json'], stdin: '', expectedExitCode: 3, expectedStdout: '', expectedStderr: code + 'NO_DATA' + String.fromCharCode(10) },
  // R005 (USER_CONFIRMED): every date flag defaults to the machine's local day when omitted. The output cannot
  // be pinned to a literal in a static plan, so these two cases assert the SHAPE: a real date came back and the
  // command exited 0, which is exactly what run_92f9a3910692ee861c1d's first attempt failed (ERROR BAD_DATE).
  { id: 'C15-tick-defaults-today', acceptanceIds: ['A3-error-codes', 'A4-date-and-streak'], runtime: 'node', entry, args: ['tick', 'water', '--file', 'now.json'], stdin: '', expectedExitCode: 0, expectedStdoutMatch: '^TICKED water \\d{4}-\\d{2}-\\d{2}\\n$', fixtures: { 'now.json': JSON.stringify({ items: { water: [] } }) } },
  { id: 'C16-streak-defaults-today', acceptanceIds: ['A3-error-codes', 'A4-date-and-streak'], runtime: 'node', entry, args: ['streak', 'water', '--file', 'now.json'], stdin: '', expectedExitCode: 0, expectedStdoutMatch: '^STREAK water \\d+\\n$', fixtures: { 'now.json': JSON.stringify({ items: { water: [] } }) } },
];
const remapAcceptance = (() => {
  if (specTextPath) return null;
  const ids = acceptanceItems.map(item => item.id);
  if (!ids.length) return null;
  const template = new Set(CASES.flatMap(one => one.acceptanceIds));
  if ([...template].some(id => ids.includes(id))) return null;
  if (ids.length !== 1) { console.log('REFUSED PLAN_ACCEPTANCE_UNMAPPABLE: spec has ' + ids.length + ' acceptance items and none match the template'); process.exit(1); }
  console.log('ACCEPTANCE_REMAPPED ' + JSON.stringify({ to: ids[0] }));
  return ids[0];
})();
const cases = CASES.map(({ acceptanceIds, ...rest }) => ({
  id: rest.id,
  requirementIds: proposalFallback ?? requirementsOf(remapAcceptance ? [remapAcceptance] : acceptanceIds),
  ...rest,
  ...(proposalFallback ? {} : { acceptanceIds: remapAcceptance ? [remapAcceptance] : acceptanceIds }),
}));
// A plan that leaves an approved requirement unexercised is refused here, where the readings are
// concrete, instead of at registration time where the message is only a code.
const required = (spec.requirements || []).map(requirement => String(requirement.id));
const coveredBy = new Set(cases.flatMap(one => one.requirementIds));
const uncovered = required.filter(requirement => !coveredBy.has(requirement));
if (uncovered.length > 0) {
  console.log('REFUSED PLAN_COVERAGE_INCOMPLETE (' + uncovered.length + '): ' + uncovered.join(','));
  console.log('Every approved requirement needs at least one case; add the missing acceptance items first.');
  process.exit(1);
}
const plan = { schema: 'dream-maker.cli-verifier.v1', specHash: spec.hash, cases };
const body = JSON.stringify(plan, null, 2) + String.fromCharCode(10);
const out = flag('out') ?? 'delivery/oracle-plan-' + spec.hash.slice(0, 12) + '.json';
writeFileSync(resolve(root, out), body);
console.log('PLAN_WRITTEN ' + out + ' cases=' + cases.length + ' planHash=' + createHash('sha256').update(body).digest('hex'));
if (specTextPath) {
  console.log('PROPOSAL_ONLY: this plan is derived from a proposed spec text, so it is not registrable.');
  console.log('After the owner approves the added decisions in a real spec, re-run with --project <id>, then:');
  console.log('  node scripts/native-oracles.mjs --plan ' + out + ' --project <id> --register');
} else {
  console.log('NEXT: node scripts/native-oracles.mjs --plan ' + out + ' --project ' + projectId + ' --register');
  console.log('      then node scripts/native-audit.mjs and let the owner approve via POST /api/projects/' + projectId + '/native-verifier/approve');
}
