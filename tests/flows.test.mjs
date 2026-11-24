import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLOWS, FLOW_ROLES, FLOW_DEFINITIONS, resolveFlow, flowCatalog, flowForRunMode } from '../dist/server/flows.js';
import { defaults, Settings } from '../dist/server/config.js';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// A config with Laya off is the shipped default; each test narrows the one field it is about.
const cfg = (laya = {}) => {
    const c = structuredClone(defaults);
    c.laya = { ...c.laya, ...laya };
    return c;
};

test('there are exactly two flows and they own planner2/executor/reviewer, never planner1', () => {
    assert.deepEqual([...FLOWS], ['classic', 'custom']);
    assert.deepEqual([...FLOW_ROLES], ['planner2', 'executor', 'reviewer']);
    for (const name of FLOWS) {
        const def = FLOW_DEFINITIONS[name];
        assert.equal(def.name, name);
        assert.deepEqual([...def.roles], [...FLOW_ROLES]);
        assert.equal(def.roles.includes('planner1'), false, name + ' must not absorb the planner1 interview');
    }
    assert.equal(FLOW_DEFINITIONS.dreamflow.layaCoupled, false);
    assert.equal(FLOW_DEFINITIONS['dreamflow-laya'].layaCoupled, true);
});

test('dreamflow stays Laya OFF even when the config turns Laya on', () => {
    const on = resolveFlow('dreamflow', cfg({ mode: 'advisory' }), { live: true });
    assert.equal(on.layaMode, 'off');
    assert.deepEqual(on.layaRoles, { planner2: 'off', executor: 'off', reviewer: 'off' });
    assert.equal(on.blockedBy, '');
    assert.equal(on.liveAllowed, true);
});

test('dreamflow-laya is refused when the layer is off, instead of silently running without it', () => {
    const r = resolveFlow('dreamflow-laya', cfg({ mode: 'off' }));
    assert.equal(r.blockedBy, 'LAYA_DISABLED');
    assert.equal(r.liveAllowed, false);
    assert.match(r.reason, /config\.laya\.mode 是 off/);
});

test('dreamflow-laya is refused when every execution role opted out of Laya', () => {
    const r = resolveFlow('dreamflow-laya', cfg({ mode: 'shadow', roles: { planner1: 'inherit', planner2: 'off', executor: 'off', reviewer: 'off' } }));
    assert.equal(r.blockedBy, 'LAYA_DISABLED');
    assert.equal(r.liveAllowed, false);
    assert.match(r.reason, /全部在 laya\.roles 里选了 off/);
});

test('dreamflow-laya cannot claim Live without a controller-owned qualification', () => {
    const r = resolveFlow('dreamflow-laya', cfg({ mode: 'shadow' }));
    assert.equal(r.layaMode, 'shadow');
    assert.deepEqual(r.layaRoles, { planner2: 'inherit', executor: 'inherit', reviewer: 'inherit' });
    assert.equal(r.blockedBy, 'NATIVE_LAYA_QUALIFICATION_REQUIRED');
    assert.equal(r.liveAllowed, false);
    assert.match(r.reason, /真实/);
});

test('a matching controller qualification opens Live for a Laya advisory flow', () => {
    const r = resolveFlow('dreamflow-laya', cfg({ mode: 'advisory' }), { layaQualification: () => ({ qualified: true }) });
    assert.equal(r.blockedBy, '');
    assert.equal(r.liveAllowed, true);
    assert.equal(r.layaMode, 'advisory');
});

test('a throwing or false qualification probe never opens Live', () => {
    for (const probe of [() => ({ qualified: false }), () => { throw new Error('x'); }, () => true, () => 'qualified']) {
        const r = resolveFlow('dreamflow-laya', cfg({ mode: 'advisory' }), { layaQualification: probe });
        assert.equal(r.blockedBy, 'NATIVE_LAYA_QUALIFICATION_REQUIRED');
        assert.equal(r.liveAllowed, false);
    }
});

test('the enhanced flow cannot silently omit one of the three engineering roles', () => {
    const r = resolveFlow('dreamflow-laya', cfg({ mode: 'advisory', roles: { planner1: 'inherit', planner2: 'inherit', executor: 'off', reviewer: 'inherit' } }), { live: false });
    assert.equal(r.blockedBy, 'LAYA_ROLES_INCOMPLETE');
    assert.equal(r.liveAllowed, false);
    assert.equal(r.layaMode, 'advisory');
    assert.match(r.reason, /三个角色/);
});
test('all three enabled roles can use the non-native assistance path without claiming native acceptance',()=>{
 const r=resolveFlow('dreamflow-laya',cfg({mode:'advisory'}),{live:false});assert.equal(r.blockedBy,'');assert.equal(r.liveAllowed,true);assert.match(r.reason,/planner2\/executor\/reviewer/);
});

test('an unknown flow name is rejected by code, not by returning a half-resolved flow', () => {
    assert.throws(() => resolveFlow('dreamflow-max', cfg()), (e) => e.code === 'FLOW_UNKNOWN' && e.status === 400);
});

test('resolving a flow never mutates the config it was given', () => {
    const config = cfg({ mode: 'shadow', roles: { planner1: 'inherit', planner2: 'off', executor: 'inherit', reviewer: 'inherit' } });
    const before = JSON.stringify(config);
    resolveFlow('dreamflow', config);
    resolveFlow('dreamflow-laya', config, { live: false });
    assert.equal(JSON.stringify(config), before);
});

test('flowCatalog lists both flows resolved against one config, in a stable order', () => {
    const catalog = flowCatalog(cfg({ mode: 'off' }));
    assert.deepEqual(catalog.map(x => x.name), ['classic', 'custom']);
    assert.deepEqual(catalog.map(x => x.liveAllowed), [true, false]);
});

test('a run mode is mapped to the flow that could actually produce it', () => {
    const off = cfg({ mode: 'off' }), on = cfg({ mode: 'advisory' });
    assert.equal(flowForRunMode('live', off), 'classic');
    assert.equal(flowForRunMode('demo', off), 'classic');
    // A Live run can only have come from the Laya-OFF flow, even with Laya enabled in the config.
    assert.equal(flowForRunMode('live', on), 'classic');
    assert.equal(flowForRunMode('demo', on), 'classic');
});

test('the settings payload carries both flows, so the browser never re-implements the rule', () => {
    const payload = new Settings(resolve(tmpdir(), 'dm-flows-absent-' + Date.now() + '.json')).public();
    assert.deepEqual(payload.flows.map(f => f.name), ['classic', 'custom']);
    assert.equal(payload.flows[0].liveAllowed, true);
    // The shipped default config has Laya off, so the coupled flow must say so instead of pretending.
    assert.equal(payload.flows[1].blockedBy, 'CUSTOM_MAGPIE_SECURITY_REQUIRED');
    assert.equal(payload.flows[1].liveAllowed, false);
});
