#!/usr/bin/env node
// Verify that the existing Clash for Windows route really reaches the declared exit country,
// using the same code path as POST /api/clash/verify: one selector lease, one explicit CONNECT
// probe, one compare-then-restore. It never edits the shared Clash config, never starts or stops
// Clash, and never widens the route to an undeclared direct connection.
//
// Usage: node scripts/clash-sg-verify.mjs [--country SG] [--json]
// Exit: 0 only on PROBE_NODE_CHAIN_AND_EGRESS_OBSERVED + nodeChainMatched + restored + no recovery.
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { defaults } from '../dist/server/config.js';
import { ClashService } from '../dist/server/clash-service.js';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i < 0 ? null : (args[i + 1] ?? ''); };
const country = (flag('--country') ?? 'SG').toUpperCase();
const json = args.includes('--json');
const sha = value => createHash('sha256').update(value).digest('hex');
const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
const configPath = resolve(home, '.config', 'clash', 'config.yaml');
const stateDirectory = resolve(process.env.DM_DATA_DIR ?? resolve('.runtime'), 'clash-route-evidence');
mkdirSync(stateDirectory, { recursive: true });

// Name matching is deliberately conservative: the operator's node label is free text.
const ALIAS = { SG: /(新加坡|singapore)/i, JP: /(日本|japan|tokyo)/i, US: /(美国|united states|los angeles|seattle)/i, HK: /(香港|hong kong)/i };
const matcher = ALIAS[country];
if (!matcher) { console.error('UNSUPPORTED_COUNTRY	' + country); process.exit(2); }

const config = structuredClone(defaults);
config.clash = { enabled: true, configPath, selector: '', node: '', expectedMode: 'rule' };
const service = new ClashService(() => config, stateDirectory);
const seen = await service.inspect();
// Never probe through the GLOBAL group unless it is the only one holding the node: that group is the
// operator's own traffic switch, and a diagnostic that moves it is a side effect it must not have.
const ordered = [...seen.selectors].sort((a, b) => (a.name === 'GLOBAL' ? 1 : 0) - (b.name === 'GLOBAL' ? 1 : 0));
let pick = null;
for (const selector of ordered) {
    const member = selector.members.find(name => matcher.test(name));
    if (member) { pick = { selector: selector.name, node: member }; break; }
}
if (!pick) { console.error('NO_' + country + '_NODE'); process.exit(2); }
config.clash.selector = pick.selector;
config.clash.node = pick.node;

const before = await service.inspect();
let result = null, failure = null;
try { result = await service.verify(); }
catch (error) { failure = { code: error?.code ?? 'UNCLASSIFIED', message: String(error?.message ?? error).slice(0, 300) }; }
const after = await service.inspect();
const selectionOf = status => status.selectors.map(s => [s.name, s.now]);
const restoredSelection = JSON.stringify(selectionOf(before)) === JSON.stringify(selectionOf(after));
const pass = Boolean(result && result.evidence === 'PROBE_NODE_CHAIN_AND_EGRESS_OBSERVED' && result.nodeChainMatched === true && result.restored === true)
    && after.recoveryRequired === false && (result?.country ?? '').toUpperCase() === country;

// Evidence keeps the exit country and a hash of the exit IP; the raw IP and the operator's node
// label never leave this process.
const evidence = {
    schema: 'dream-maker.sg-network-route.evidence.v1',
    observedAt: new Date().toISOString(),
    platform: { os: process.platform, node: process.version, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    controller: before.controller ?? null,
    declared: { selectorSha256: sha(pick.selector), nodeSha256: sha(pick.node), expectedMode: 'rule', candidateCount: seen.selectors.length },
    probe: result ?? null,
    failure,
    selectionUnchanged: restoredSelection,
    recoveryRequired: after.recoveryRequired,
    expectedCountry: country,
    verdict: pass ? 'SG_NETWORK_ROUTE_PASS' : 'SG_NETWORK_ROUTE_NOT_VERIFIED',
    nonClaims: { modelCalls: 0, paidCalls: 0, fourRoleLive: 'NOT_VERIFIED', openaiEligibility: 'separate report' }
};
if (json) console.log(JSON.stringify(evidence, null, 2));
else {
    console.log('CONTROLLER\t' + JSON.stringify(before.controller ?? null));
    console.log('DECLARED\t' + JSON.stringify(evidence.declared));
    console.log('PROBE\t' + JSON.stringify(result));
    console.log('SELECTION_UNCHANGED\t' + restoredSelection + '\tRECOVERY_REQUIRED\t' + after.recoveryRequired);
    if (failure) console.log('FAILURE\t' + JSON.stringify(failure));
    console.log(evidence.verdict + '\t' + country);
}
process.exit(pass ? 0 : 1);
