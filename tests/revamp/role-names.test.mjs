// Role naming: the product name changed, the stored wire id did not.
//
// planner1 -> Seeker and planner2 -> Planner are display names only. The evidence files,
// the SQLite records and the config keys keep 'planner1' / 'planner2', because renaming the
// id would break every historical row. These tests pin both halves of that rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../dist/server/http.js';
import { Settings, defaults } from '../../dist/server/config.js';
import { Store } from '../../dist/server/store.js';
import { ROLES } from '../../dist/shared/types.js';
import { roleNames, roleDisplayNames } from '../../dist/web/contracts.js';
import { reviewSetup } from '../../dist/web/frontend-review-data.js';
import {
    ROLE_METADATA, ROLE_WIRE_IDS, acceptsAlias, isRoleWireId, normalizeRoleAliasKeys,
    normalizeRoleFields, normalizeRoleList, roleDisplayLabel, roleDisplayName, roleIconId,
    roleMetadata, roleProjection, roleZhLabel
} from '../../dist/shared/role-names.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const scratch = () => {
    const parent = resolve(root, '.runtime/test-temp');
    mkdirSync(parent, { recursive: true });
    return mkdtempSync(resolve(parent, 'role-names-'));
};

test('the wire ids are exactly the historical four, in the historical order', () => {
    assert.deepEqual([...ROLE_WIRE_IDS], ['planner1', 'planner2', 'executor', 'reviewer']);
    // The shared Role type is the same tuple, not a copy that could drift.
    assert.deepEqual([...ROLES], [...ROLE_WIRE_IDS]);
    for (const role of ROLE_WIRE_IDS) assert.equal(isRoleWireId(role), true, role);
    assert.equal(isRoleWireId('seeker'), false, 'a display name is never a storage id');
    assert.equal(isRoleWireId('Planner'), false);
});

test('the display names are the renamed product names, and no display name is a wire id', () => {
    assert.equal(roleMetadata('planner1').displayName, 'Seeker');
    assert.equal(roleMetadata('planner2').displayName, 'Planner');
    assert.equal(roleMetadata('executor').displayName, 'Executor');
    assert.equal(roleMetadata('reviewer').displayName, 'Reviewer');
    for (const role of ROLE_WIRE_IDS) {
        const metadata = ROLE_METADATA[role];
        assert.notEqual(metadata.displayName, role, role + ' must not display its wire id');
        assert.equal(/\d/.test(metadata.displayName), false, metadata.displayName + ' must not carry a 1/2 suffix');
        assert.equal(metadata.zhLabel.length > 0, true);
        assert.equal(metadata.iconId.length > 0, true);
    }
    // The Chinese labels are not part of the rename.
    assert.deepEqual({ ...roleNames }, { planner1: '需求澄清', planner2: '工程规划', executor: '执行制作', reviewer: '独立审查' });
    assert.deepEqual({ ...roleDisplayNames }, { planner1: 'Seeker', planner2: 'Planner', executor: 'Executor', reviewer: 'Reviewer' });
});

test('each role carries exactly three DF visual identifiers', () => {
    const badges = new Set();
    for (const role of ROLE_WIRE_IDS) {
        const visuals = ROLE_METADATA[role].dreamflow;
        assert.deepEqual(Object.keys(visuals).sort(), ['badge', 'lane', 'tone']);
        for (const value of Object.values(visuals)) assert.equal(typeof value === 'string' && value.length > 0, true, role);
        assert.equal(badges.has(visuals.badge), false, 'badges are unique: ' + visuals.badge);
        badges.add(visuals.badge);
        // Tone is the CSS class suffix 'is-<tone>' and matches the icon id.
        assert.equal(visuals.tone, ROLE_METADATA[role].iconId);
    }
    assert.deepEqual(ROLE_WIRE_IDS.map(role => ROLE_METADATA[role].dreamflow.lane), ['00', '01', '02', '03']);
    assert.deepEqual(ROLE_WIRE_IDS.map(role => ROLE_METADATA[role].dreamflow.badge), ['SK', 'PL', 'EX', 'RV']);
});

test('metadata is frozen so a page cannot rename a role at runtime', () => {
    assert.equal(Object.isFrozen(ROLE_METADATA), true);
    assert.equal(Object.isFrozen(ROLE_METADATA.planner1), true);
    assert.equal(Object.isFrozen(ROLE_METADATA.planner1.dreamflow), true);
    assert.equal(Object.isFrozen(ROLE_METADATA.planner1.aliases), true);
    assert.throws(() => { ROLE_METADATA.planner1.displayName = 'Planner'; }, TypeError);
});

test('aliases normalize to the stable wire id: seeker -> planner1, planner -> planner2', () => {
    const cases = [
        ['seeker', 'planner1'], ['Seeker', 'planner1'], ['  SEEKER  ', 'planner1'], ['seeker1', 'planner1'], ['p1', 'planner1'],
        ['planner1', 'planner1'], ['Planner 1', 'planner1'], ['planner_1', 'planner1'], ['planner-1', 'planner1'],
        ['需求澄清', 'planner1'],
        ['planner', 'planner2'], ['Planner', 'planner2'], ['PLANNER ', 'planner2'], ['p2', 'planner2'],
        ['planner2', 'planner2'], ['Planner 2', 'planner2'], ['planner_2', 'planner2'], ['planner-2', 'planner2'],
        ['工程规划', 'planner2'],
        ['executor', 'executor'], ['Executor', 'executor'], ['exec', 'executor'], ['执行制作', 'executor'],
        ['reviewer', 'reviewer'], ['REVIEWER', 'reviewer'], ['review', 'reviewer'], ['独立审查', 'reviewer']
    ];
    for (const [input, expected] of cases) assert.equal(acceptsAlias(input), expected, JSON.stringify(input));
    // 'planner' is the CURRENT name of planner2, and must not be read as planner1.
    assert.equal(acceptsAlias('planner'), 'planner2');
    assert.notEqual(acceptsAlias('planner'), 'planner1');
});

test('an unknown or malformed role name is rejected instead of guessed', () => {
    for (const input of [undefined, null, '', '   ', 42, true, {}, [], ['seeker'], 'seeker2', 'planner3', 'role', 'unknown', 'planner11', 'x'.repeat(200)]) {
        assert.equal(acceptsAlias(input), null, JSON.stringify(input));
    }
    assert.equal(acceptsAlias('seeker\u0000'), null);
});

test('display helpers resolve a wire id or an alias, and stay null when unknown', () => {
    assert.equal(roleDisplayName('planner1'), 'Seeker');
    assert.equal(roleDisplayName('seeker'), 'Seeker');
    assert.equal(roleDisplayName('bogus'), null);
    assert.equal(roleZhLabel('planner2'), '工程规划');
    assert.equal(roleZhLabel('planner'), '工程规划');
    assert.equal(roleZhLabel('bogus'), null);
    assert.equal(roleIconId('planner1'), 'seeker');
    assert.equal(roleIconId('planner2'), 'planner');
    assert.equal(roleIconId('bogus'), null);
    assert.equal(roleDisplayLabel('planner1'), 'Seeker · 需求澄清');
    assert.deepEqual(roleProjection('planner2'), { role: 'planner2', displayName: 'Planner', zhLabel: '工程规划' });
});

test('normalizeRoleList resolves every entry, collapses duplicates and rejects the rest', () => {
    assert.deepEqual(normalizeRoleList(['seeker', 'planner']), ['planner1', 'planner2']);
    assert.deepEqual(normalizeRoleList(['Seeker', 'planner1']), ['planner1']);
    assert.deepEqual(normalizeRoleList(['executor', 'reviewer']), ['executor', 'reviewer']);
    assert.deepEqual(normalizeRoleList([]), []);
    assert.equal(normalizeRoleList(['planner1', 'nope']), null);
    assert.equal(normalizeRoleList('seeker'), null);
    assert.equal(normalizeRoleList(undefined), null);
});

test('normalizeRoleAliasKeys keeps wire ids when both spellings arrive', () => {
    assert.deepEqual(normalizeRoleAliasKeys({ seeker: 'off', executor: 'inherit' }), { planner1: 'off', executor: 'inherit' });
    // The stable id wins over its alias regardless of key order.
    assert.deepEqual(normalizeRoleAliasKeys({ planner: 'off', planner2: 'inherit' }), { planner2: 'inherit' });
    assert.deepEqual(normalizeRoleAliasKeys({ planner2: 'inherit', planner: 'off' }), { planner2: 'inherit' });
    // Keys that are not roles are dropped, exactly like the previous ignore-unknown behaviour.
    assert.deepEqual(normalizeRoleAliasKeys({ bogus: 'off' }), {});
    assert.equal(normalizeRoleAliasKeys('seeker'), null);
    assert.equal(normalizeRoleAliasKeys([]), null);
});

test('normalizeRoleFields renames exactly the role-named body field', () => {
    assert.deepEqual(normalizeRoleFields({ seeker: { model: 'm' } }), { seeker: { model: 'm' }, planner1: { model: 'm' } });
    // A stable field is never overwritten by its alias.
    assert.deepEqual(normalizeRoleFields({ planner1: { model: 'wire' }, seeker: { model: 'alias' } }), { planner1: { model: 'wire' }, seeker: { model: 'alias' } });
    // Unrelated keys keep their names: only a whole role name is a role field.
    assert.deepEqual(normalizeRoleFields({ seekerNotes: 'x', roleName: 'seeker', confirmed: true }), { seekerNotes: 'x', roleName: 'seeker', confirmed: true });
    assert.deepEqual(normalizeRoleFields(null), {});
});

test('inbound aliases never reach the persisted config: it still stores planner1 / planner2', t => {
    const dir = scratch();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = resolve(dir, 'config.json');
    writeFileSync(path, JSON.stringify(structuredClone(defaults)));
    const settings = new Settings(path);
    assert.equal(settings.value.laya.roles.planner1, 'inherit');
    // The existing contract requires all four keys once a role map is present; two of them
    // arrive under their product names here and must land on the wire-id keys.
    settings.updateUI({ laya: { mode: 'off', roles: { seeker: 'off', planner: 'off', executor: 'inherit', reviewer: 'inherit' } } });
    assert.equal(settings.value.laya.roles.planner1, 'off', 'seeker was written to the stable planner1 key');
    assert.equal(settings.value.laya.roles.planner2, 'off', 'planner was written to the stable planner2 key');
    assert.equal(settings.value.laya.roles.executor, 'inherit');
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(persisted.laya.roles.planner1, 'off');
    assert.equal(persisted.laya.roles.planner2, 'off');
    assert.equal(Object.hasOwn(persisted.laya.roles, 'seeker'), false, 'no display name is persisted');
    assert.equal(Object.hasOwn(persisted.laya.roles, 'planner'), false);
});

test('historical evidence keeps its planner1 / planner2 rows and still reads them back', t => {
    const store = new Store(':memory:');
    t.after(() => store.close());
    const recordId = store.record('Planner1ProbeLifecycle', null, null, { stage: 'COMPLETED', role: 'planner1', at: '2026-01-01T00:00:00.000Z' });
    store.record('NativeProbeReceipt', null, null, { role: 'planner2', valid: true });
    const rows = store.db.prepare("SELECT kind, data FROM records WHERE kind IN ('Planner1ProbeLifecycle','NativeProbeReceipt') ORDER BY rowid").all();
    assert.equal(rows.length, 2);
    assert.equal(typeof recordId, 'string');
    const legacy = JSON.parse(rows[0].data);
    assert.equal(legacy.role, 'planner1', 'an old row is stored and read with the wire id');
    assert.equal(acceptsAlias(legacy.role), 'planner1');
    assert.equal(JSON.parse(rows[1].data).role, 'planner2');
    // A new write also keeps the wire id: the rename is display-only.
    store.record('RoleAliasProbe', null, null, { role: acceptsAlias('seeker') });
    const written = store.db.prepare("SELECT data FROM records WHERE kind='RoleAliasProbe'").get();
    assert.equal(JSON.parse(written.data).role, 'planner1');
});

test('the browser module and the demo snapshot render Seeker / Planner, not the wire ids', () => {
    const setup = reviewSetup('dreamflow');
    assert.deepEqual(setup.roles.map(role => role.displayName), ['Seeker', 'Planner', 'Executor', 'Reviewer']);
    assert.deepEqual(setup.roles.map(role => role.role), ['planner1', 'planner2', 'executor', 'reviewer']);
    for (const role of setup.roles) assert.equal(role.title.includes(role.displayName), false, 'the Chinese title is not the product name');
});

async function dreamflowServer(t) {
    const data = scratch();
    const config = structuredClone(defaults);
    config.kimi.enabled = true;
    const configPath = resolve(data, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
    const app = await createApp({
        root, data, configPath, product: 'dreamflow', port: 0, demoDelayMs: 0,
        kimiBridgeSpawn: () => { throw Error('P1_MUST_NOT_START'); }
    });
    t.after(async () => { await app.close(); rmSync(data, { recursive: true, force: true }); });
    const login = await fetch(app.origin + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap: app.bootstrap }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { csrf } = await login.json();
    const call = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
        const response = await fetch(app.origin + '/api' + path, {
            method,
            headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': crypto.randomUUID() },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: response.status, body: await response.json() };
    };
    return { app, call, configPath };
}

test('POST /api/native/probes accepts the new role names and keeps the stable code', async t => {
    const { call } = await dreamflowServer(t);
    // planner1 is not available in DreamFlow. The alias resolves to planner1, so the same
    // stable code answers, and an unknown name is still a 400 instead of a silent default.
    for (const role of ['planner1', 'seeker', 'Seeker', '  SEEKER  ', 'planner_1']) {
        const response = await call('/native/probes', { roles: [role] });
        assert.equal(response.status, 409, role);
        assert.equal(response.body.error, 'USER_PLANNER_REQUIRED', role);
    }
    const rejected = await call('/native/probes', { roles: ['bogus'] });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, 'NATIVE_PROBE_ROLE_INVALID');
});

test('PUT /api/config reads a Seeker/Planner body and persists the wire ids', async t => {
    const { call, configPath } = await dreamflowServer(t);
    // A body field named with the product name is the planner1 block.
    const blocked = await call('/config', { seeker: { model: 'someone-else' } }, 'PUT');
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'USER_PLANNER_REQUIRED');
    const written = await call('/config', { laya: { mode: 'off', roles: { seeker: 'off', planner: 'off', executor: 'inherit', reviewer: 'inherit' } } }, 'PUT');
    assert.equal(written.status, 200);
    const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(persisted.laya.roles.planner1, 'off');
    assert.equal(persisted.laya.roles.planner2, 'off');
    assert.equal(Object.hasOwn(persisted.laya.roles, 'seeker'), false);
    assert.equal(Object.hasOwn(persisted.laya.roles, 'planner'), false);
});
