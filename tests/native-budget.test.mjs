// OFFLINE ledger safety tests, not provider invoices or Live request evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { harness } from './helpers.mjs';
import { NativeBudget } from '../dist/server/native-budget.js';

const authority = { scopeId: 'OFFLINE_BUDGET_SCOPE', authorizationHash: 'OFFLINE_AUTHORITY_NOT_LIVE', totalMicros: 50000000, probeMicros: 5000000, warningMicros: 40000000, maxInFlight: 1, maxRepairs: 2 };
const quote = () => ({ provider: 'deepseek-official', model: 'deepseek-flash', currency: 'CNY', source: 'OFFLINE_PRICE_FIXTURE', expiresAt: new Date(Date.now() + 60000).toISOString(), maxInputTokens: 1048576, inputMissMicrosPerMillion: 2000000, inputHitMicrosPerMillion: 40000, outputMicrosPerMillion: 8000000 });
function ledger(t) {
    const handles = [];
    t.after(() => handles.forEach(b => b.close()));
    const h = harness(t), path = resolve(h.dir, 'native-budget.sqlite');
    const open = () => { const b = new NativeBudget(path, authority, () => true); handles.push(b); return b; };
    return { budget: open(), path, open };
}

test('inner requests reserve conservative CNY amounts and reject concurrent dispatch', t => {
    const { budget } = ledger(t), first = budget.reserve('executor', quote(), 128);
    assert.equal(first.reservedMicros, 2098176);
    assert.equal(budget.summary().inFlight, 1);
    assert.throws(() => budget.reserve('executor', quote(), 128), { code: 'NATIVE_REQUEST_ALREADY_IN_FLIGHT' });
    budget.settle(first.id, { inputTokens: 1000, outputTokens: 50, cacheHitTokens: 0 }, 'COMPLETE');
    assert.equal(budget.summary().committedMicros, 2400);
    assert.equal(budget.summary().inFlight, 0);
});

test('read-only price preflight bounds the next request without creating a reservation',t=>{
 const {budget}=ledger(t),before=budget.summary();
 assert.equal(budget.preflight(quote(),128),2098176);
 assert.deepEqual(budget.summary(),before);assert.equal(budget.requests().length,0);
 assert.throws(()=>budget.preflight({...quote(),maxInputTokens:NaN},128),{code:'NATIVE_PRICE_UNKNOWN'});
});

test('reservation observer sees threshold crossing before dispatch and failed receipt stays charged unknown',t=>{
 let b;t.after(()=>b?.close());const h=harness(t),seen=[];
 const a={...authority,warningMicros:2000000};
 b=new NativeBudget(resolve(h.dir,'observer.sqlite'),a,()=>false,s=>{seen.push(s.warning);throw Error('OFFLINE_WARNING_FAILURE');});
 assert.throws(()=>b.reserve('executor',quote(),128),{code:'NATIVE_RESERVATION_OBSERVER_FAILED'});
 assert.deepEqual(seen,[true]);assert.equal(b.requests()[0].usageStatus,'UNKNOWN');assert.equal(b.summary().committedMicros,2098176);
});

test('unknown, failed and disconnected requests retain their reservation and consume the probe cap', t => {
    const { budget } = ledger(t);
    const first = budget.reserve('executor', quote(), 128);
    budget.settle(first.id, null, 'DISCONNECTED');
    const second = budget.reserve('executor', quote(), 128);
    budget.settle(second.id, null, 'FAILED');
    assert.equal(budget.summary().committedMicros, 4196352);
    assert.throws(() => budget.reserve('executor', quote(), 128), { code: 'PROBE_BUDGET_EXCEEDED' });
    assert.equal(budget.requests().every(r => r.usageStatus === 'UNKNOWN'), true);
});

test('settlement is idempotent but rejects a conflicting duplicate result', t => {
    const { budget } = ledger(t), request = budget.reserve('executor', quote(), 128);
    const usage = { inputTokens: 100, outputTokens: 10, cacheHitTokens: 50 };
    budget.settle(request.id, usage, 'COMPLETE');
    const committed = budget.summary().committedMicros;
    budget.settle(request.id, usage, 'COMPLETE');
    assert.equal(budget.summary().committedMicros, committed);
    assert.throws(() => budget.settle(request.id, { ...usage, outputTokens: 11 }, 'COMPLETE'), { code: 'BUDGET_SETTLEMENT_CONFLICT' });
});

test('restart converts unresolved in-flight work to unknown without freeing its cost', t => {
    const { budget, open } = ledger(t), request = budget.reserve('executor', quote(), 128);
    budget.close();
    const restored = open();
    assert.equal(restored.summary().inFlight, 0);
    assert.equal(restored.summary().committedMicros, request.reservedMicros);
    assert.equal(restored.requests()[0].outcome, 'RESTART_UNKNOWN');
});

test('a caller-controlled REAL_MODEL_RESPONSE label cannot promote the production ledger', t => {
    let budget;
    t.after(() => budget?.close());
    const h = harness(t);
    budget = new NativeBudget(resolve(h.dir, 'untrusted.sqlite'), authority);
    const labels = Object.fromEntries(['planner1','planner2','executor','reviewer'].map(role => [role, { evidenceId: 'caller-label', model: 'unverified', source: 'REAL_MODEL_RESPONSE' }]));
    assert.throws(() => budget.advance(labels), { code: 'PROBE_EVIDENCE_UNVERIFIED' });
});

test('a second active controller cannot recover a live reservation', t => {
    const { budget, path } = ledger(t);
    budget.reserve('executor', quote(), 128);
    assert.throws(() => new NativeBudget(path, authority), { code: 'BUDGET_CONTROLLER_ACTIVE' });
    assert.equal(budget.summary().inFlight, 1);
});

test('malformed usage remains worst-case and repair count is persistent', t => {
    const { budget, open } = ledger(t), r = budget.reserve('executor', quote(), 128);
    budget.settle(r.id, { inputTokens: 1, cacheHitTokens: 2, outputTokens: 1 }, 'INVALID_USAGE');
    assert.equal(budget.summary().committedMicros, r.reservedMicros);
    budget.repair('run_a'); budget.repair('run_a'); budget.close();
    const restored = open();
    // The ledger survives close(), and the ceiling is per run: history cannot pre-consume a fresh run.
    assert.throws(() => restored.repair('run_a'), { code: 'NATIVE_REPAIR_LIMIT_EXCEEDED' });
    restored.repair('run_b');
    // A run that was never bound is refused instead of reaching SQLite as `undefined`.
    assert.throws(() => restored.repair(), { code: 'NATIVE_REPAIR_RUN_UNBOUND' });
});
test('mutating the caller authority cannot widen the approved probe cap',t=>{
    let budget;
    t.after(()=>budget?.close());
    const h=harness(t), a={...authority};
    budget=new NativeBudget(resolve(h.dir,'immutable-authority.sqlite'),a);
    a.probeMicros=50000000;
    for(let i=0;i<2;i++){const r=budget.reserve('executor',quote(),128);budget.settle(r.id,null,'DISCONNECTED');}
    assert.throws(()=>budget.reserve('executor',quote(),128),{code:'PROBE_BUDGET_EXCEEDED'});
});

test('unknown or expired prices and widened authority refuse new dispatch', t => {
    const { budget, path } = ledger(t);
    assert.throws(() => budget.reserve('executor', { ...quote(), expiresAt: '2000-01-01T00:00:00Z' }, 128), { code: 'NATIVE_PRICE_EXPIRED' });
    assert.throws(() => budget.reserve('executor', { ...quote(), outputMicrosPerMillion: null }, 128), { code: 'NATIVE_PRICE_UNKNOWN' });
    assert.throws(() => new NativeBudget(path, { ...authority, totalMicros: 51000000 }), { code: 'BUDGET_AUTHORITY_EXCEEDED' });
});

test('probe transition requires all four real-call references and total cap warns at forty', t => {
    const { budget } = ledger(t);
    assert.throws(() => budget.advance({}), { code: 'PROBE_EVIDENCE_INCOMPLETE' });
    budget.advance(Object.fromEntries(['planner1','planner2','executor','reviewer'].map(role => [role, { evidenceId: 'OFFLINE_' + role, model: 'OFFLINE', source: 'REAL_MODEL_RESPONSE' }])));
    for (let i = 0; i < 20; i++) {
        const r = budget.reserve('executor', quote(), 128);
        budget.settle(r.id, null, 'DISCONNECTED');
    }
    assert.equal(budget.summary().warning, true);
    for (let i = 0; i < 3; i++) {
        const r = budget.reserve('executor', quote(), 128);
        budget.settle(r.id, null, 'DISCONNECTED');
    }
    assert.throws(() => budget.reserve('executor', quote(), 128), { code: 'TOTAL_MODEL_BUDGET_EXCEEDED' });
});

test('engineering-only qualification excludes P1 without granting full DM evidence or changing charges',t=>{
 let b,dm;t.after(()=>{dm?.close();b?.close();});
 const h=harness(t),path=resolve(h.dir,'engineering-qualification.sqlite'),refs=Object.fromEntries(['planner2','executor','reviewer'].map(role=>[role,{evidenceId:'OFFLINE_'+role,model:'OFFLINE',source:'REAL_MODEL_RESPONSE'}]));
 b=new NativeBudget(path,authority,()=>true,undefined,'ENGINEERING_ONLY');
 b.advance(refs);assert.equal(b.summary().phase,'REPRESENTATIVE');
 assert.throws(()=>b.reserve('planner1',quote(),128),{code:'NATIVE_ROLE_NOT_IN_PRODUCT'});
 const request=b.reserve('executor',quote(),128);b.settle(request.id,{inputTokens:100,outputTokens:10,cacheHitTokens:0},'COMPLETE');
 const before=b.summary().committedMicros;b.close();
 dm=new NativeBudget(path,authority,()=>true);
 assert.equal(dm.summary().committedMicros,before);assert.equal(dm.requests().length,1);
 assert.throws(()=>dm.preflight(quote(),128),{code:'PROBE_EVIDENCE_UNVERIFIED'});
});
test('a pending probe cannot lend its repair exemption to ordinary builds or other roles',t=>{
 let b,dm;t.after(()=>{dm?.close();b?.close();});
 const h=harness(t),path=resolve(h.dir,'probe-capabilities.sqlite');
 const refs=Object.fromEntries(['planner2','executor','reviewer'].map(role=>[role,{evidenceId:'OFFLINE_'+role,model:'OFFLINE',source:'REAL_MODEL_RESPONSE'}]));
 b=new NativeBudget(path,authority,()=>true,undefined,'ENGINEERING_ONLY');b.advance(refs);b.close();
 dm=new NativeBudget(path,authority,()=>true);
 const subscriptionProbe=dm.beginEvidenceRepair('planner2');
 assert.throws(()=>dm.preflight(quote(),128),{code:'PROBE_EVIDENCE_UNVERIFIED'});
 assert.throws(()=>dm.reserve('executor',quote(),128),{code:'PROBE_EVIDENCE_UNVERIFIED'});
 assert.throws(()=>dm.reserve('executor',quote(),128,subscriptionProbe),{code:'NATIVE_PROBE_PERMIT_ROLE_MISMATCH'});
 const executorProbe=dm.beginEvidenceRepair('executor');
 assert.ok(dm.preflight(quote(),128,executorProbe)>0);
 assert.throws(()=>dm.preflight(quote(),128,{}),{code:'NATIVE_PROBE_PERMIT_INVALID'});
 const request=dm.reserve('executor',quote(),128,executorProbe);dm.settle(request.id,null,'OFFLINE_FAILURE');
 dm.endEvidenceRepair(executorProbe);dm.endEvidenceRepair(subscriptionProbe);
 assert.throws(()=>dm.reserve('executor',quote(),128,executorProbe),{code:'NATIVE_PROBE_PERMIT_INVALID'});
 assert.equal(dm.requests().length,1);
});
test('representative phase cannot spend after its verified probe references become stale',t=>{
 let budget,valid=true;
 t.after(()=>budget?.close());
 const h=harness(t),path=resolve(h.dir,'stale-proof-ledger.sqlite');
 budget=new NativeBudget(path,authority,()=>valid);
 const refs=Object.fromEntries(['planner1','planner2','executor','reviewer'].map(role=>[role,{evidenceId:'OFFLINE_'+role,model:'OFFLINE',source:'REAL_MODEL_RESPONSE'}]));
 budget.advance(refs);const request=budget.reserve('executor',quote(),128);
 budget.settle(request.id,{inputTokens:10,outputTokens:2,cacheHitTokens:0},'COMPLETE');
 const before=budget.summary();valid=false;
 assert.throws(()=>budget.reserve('executor',quote(),128),{code:'PROBE_EVIDENCE_UNVERIFIED'});assert.deepEqual(budget.summary(),before);
 budget.close();budget=new NativeBudget(path,authority,()=>false);
 assert.throws(()=>budget.preflight(quote(),128),{code:'PROBE_EVIDENCE_UNVERIFIED'});
 assert.equal(budget.summary().phase,'REPRESENTATIVE');assert.equal(budget.summary().committedMicros,before.committedMicros);
});

for (const kind of ['input','output']) test(`valid ${kind} usage above its bound persists a dispatch halt across restart`,t=>{
 const {budget,open}=ledger(t),price=quote(),r=budget.reserve('executor',price,128);
 const usage={inputTokens:kind==='input'?price.maxInputTokens+1:1,outputTokens:kind==='output'?400000:1,cacheHitTokens:0};
 budget.settle(r.id,usage,'COMPLETE');
 const record=budget.requests()[0];
 assert.deepEqual(record.usage,usage);assert.equal(record.limitExceeded,true);
 assert.ok(record.chargedMicros>=r.reservedMicros);
 if(kind==='output')assert.ok(record.chargedMicros>r.reservedMicros);
 assert.throws(()=>budget.reserve('executor',quote(),128),{code:'NATIVE_USAGE_BOUND_EXCEEDED'});
 const before=budget.summary();budget.settle(r.id,usage,'COMPLETE');assert.deepEqual(budget.summary(),before);
 budget.close();const restored=open();
 assert.throws(()=>restored.preflight(quote(),128),{code:'NATIVE_USAGE_BOUND_EXCEEDED'});
 assert.deepEqual(restored.requests()[0],record);
 assert.throws(()=>restored.advance({}),{code:'NATIVE_USAGE_BOUND_EXCEEDED'});
});

test('reported breach with unrepresentable cost still settles and persists a halt',t=>{
 const {budget,open}=ledger(t),r=budget.reserve('executor',quote(),128);
 const usage={inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:Number.MAX_SAFE_INTEGER,cacheHitTokens:0};
 budget.settle(r.id,usage,'COMPLETE');
 assert.equal(budget.summary().inFlight,0);assert.deepEqual(budget.requests()[0].usage,usage);
 assert.equal(budget.requests()[0].limitExceeded,true);assert.equal(budget.requests()[0].usageStatus,'UNKNOWN');
 assert.equal(budget.requests()[0].chargedMicros,r.reservedMicros);
 budget.close();const restored=open();
 assert.throws(()=>restored.reserve('executor',quote(),128),{code:'NATIVE_USAGE_BOUND_EXCEEDED'});
});
// ---------------------------------------------------------------------------------------------------
// Owner-authorized uncapped Live testing (HA-005). The point of this mode: a historical CNY ceiling
// stops refusing necessary official-model requests, WITHOUT deleting the ledger, writing Infinity,
// or dropping serial dispatch, price validity, usage bounds and the repair ceiling.
// ---------------------------------------------------------------------------------------------------
const uncappedApproval = { approvedAt: '2026-10-18T22:06:00.000Z', approvedBy: 'USER', statement: 'User approved necessary official DeepSeek inference without a cumulative CNY ceiling for this project.', evidenceRef: 'docs/continuation/HUMAN_ACTIONS.json#HA-005', supersedes: ['totalMicros<=50000000', 'probeMicros<=5000000', 'warningMicros<=40000000'] };
const uncappedAuthority = { ...authority, mode: 'UNCAPPED', uncappedApproval };

test('HA005-U1 an uncapped scope needs a real dated owner statement, not a bare flag', t => {
    const h = harness(t), path = resolve(h.dir, 'uncapped-missing.sqlite');
    for (const broken of [
        { ...authority, mode: 'UNCAPPED' },
        { ...authority, mode: 'UNCAPPED', uncappedApproval: { ...uncappedApproval, approvedBy: 'SYSTEM' } },
        { ...authority, mode: 'UNCAPPED', uncappedApproval: { ...uncappedApproval, approvedAt: 'not-a-date' } },
        { ...authority, mode: 'UNCAPPED', uncappedApproval: { ...uncappedApproval, statement: '   ' } },
        { ...authority, mode: 'UNCAPPED', uncappedApproval: { ...uncappedApproval, evidenceRef: '' } }
    ])
        assert.throws(() => new NativeBudget(path, broken, () => true), { code: 'BUDGET_UNCAPPED_REQUIRES_OWNER_APPROVAL' });
    // Serial dispatch and the repair ceiling are safety properties, not money: they still apply.
    assert.throws(() => new NativeBudget(path, { ...uncappedAuthority, maxInFlight: 2 }, () => true), { code: 'BUDGET_AUTHORITY_EXCEEDED' });
    assert.throws(() => new NativeBudget(path, { ...uncappedAuthority, maxRepairs: 3 }, () => true), { code: 'BUDGET_AUTHORITY_EXCEEDED' });
});

/** Open an uncapped ledger and guarantee it is closed before the harness wipes its temp dir. */
function uncappedLedger(t, name, auth = uncappedAuthority) {
    const h = harness(t), path = resolve(h.dir, name);
    const open = new NativeBudget(path, auth, () => true);
    let closed = false;
    const close = () => { if (!closed) { closed = true; open.close(); } };
    t.after(close);
    return { budget: open, path, close };
}
const spendOnce = (budget, tokens = { inputTokens: 900000, outputTokens: 8000, cacheHitTokens: 0 }) => {
    const r = budget.reserve('executor', quote(), 8192);
    budget.settle(r.id, tokens, 'OK');
    return r;
};

test('HA005-U2 a request that exceeds the historical ceiling is reserved, not refused', t => {
    const { budget, close } = uncappedLedger(t, 'uncapped-spend.sqlite');
    let rounds = 0;
    while (budget.summary().committedMicros <= 50000000 && rounds < 200) { spendOnce(budget); rounds += 1; }
    const before = budget.summary();
    assert.ok(before.committedMicros > 50000000, 'historical ceiling already exceeded: ' + before.committedMicros + ' after ' + rounds + ' rounds');
    assert.equal(before.mode, 'UNCAPPED');
    const r = budget.reserve('executor', quote(), 8192);
    assert.ok(r.reservedMicros > 0);
    budget.settle(r.id, { inputTokens: 10, outputTokens: 10, cacheHitTokens: 0 }, 'OK');
    assert.ok(budget.summary().committedMicros > before.committedMicros, 'the new spend is recorded, not free');
    close();
});

test('HA005-U3 the capped policy still refuses its own ceilings', t => {
    const { budget, close } = uncappedLedger(t, 'capped-spend.sqlite', authority);
    assert.equal(budget.summary().mode, 'CAPPED');
    spendOnce(budget);
    spendOnce(budget);
    // probeMicros is 5 CNY here and one reservation is ~2.16 CNY, so the third must be refused.
    assert.throws(() => budget.reserve('executor', quote(), 8192), { code: 'PROBE_BUDGET_EXCEEDED' });
    close();
});

test('HA005-U4 the migration is one-way, same-scope and keeps the spend history', t => {
    const h = harness(t), path = resolve(h.dir, 'uncapped-migration.sqlite');
    const capped = new NativeBudget(path, authority, () => true);
    const r = capped.reserve('executor', quote(), 1024);
    capped.settle(r.id, { inputTokens: 1000, outputTokens: 500, cacheHitTokens: 0 }, 'OK');
    const committed = capped.summary().committedMicros;
    capped.close();
    // A different scope may not adopt this ledger.
    assert.throws(() => new NativeBudget(path, { ...uncappedAuthority, scopeId: 'ANOTHER_SCOPE' }, () => true), { code: 'BUDGET_AUTHORITY_EXCEEDED' });
    assert.throws(() => new NativeBudget(path, { ...uncappedAuthority, authorizationHash: 'OTHER_HASH' }, () => true), { code: 'BUDGET_AUTHORITY_EXCEEDED' });
    // The sanctioned migration: same scope, capped -> uncapped, with the owner statement.
    const upgraded = new NativeBudget(path, uncappedAuthority, () => true);
    assert.equal(upgraded.summary().mode, 'UNCAPPED');
    assert.equal(upgraded.summary().committedMicros, committed, 'spend history is preserved, not reset');
    const history = upgraded.db.prepare('SELECT fromMode,toMode,approval FROM authority_history').all();
    assert.equal(history.length, 1);
    assert.equal(history[0].fromMode, 'CAPPED');
    assert.equal(history[0].toMode, 'UNCAPPED');
    assert.match(String(history[0].approval), /HA-005/);
    upgraded.close();
    // Re-opening with the same uncapped authority is idempotent; going back to capped is refused.
    const again = new NativeBudget(path, uncappedAuthority, () => true);
    assert.equal(again.summary().committedMicros, committed);
    assert.throws(() => new NativeBudget(path, authority, () => true), { code: 'BUDGET_AUTHORITY_EXCEEDED' });
    again.close();
});
test('HA005-U5 a scope that never spent may be re-authorized, and the transition is recorded', t => {
    const h = harness(t), path = resolve(h.dir, 're-authorized.sqlite');
    const first = new NativeBudget(path, uncappedAuthority, () => true);
    // Nothing reserved, nothing proved: a corrected authorization document for the SAME scope is allowed.
    first.close();
    const corrected = { ...uncappedAuthority, authorizationHash: 'c'.repeat(64) };
    const second = new NativeBudget(path, corrected, () => true);
    assert.equal(second.summary().phase, 'PROBE');
    const history = second.db.prepare('SELECT fromMode,toMode,previous,next FROM authority_history').all();
    assert.equal(history.length, 1);
    assert.equal(history[0].toMode, 'UNCAPPED');
    assert.match(String(history[0].next), /c{64}/);
    second.close();
    // A different scope id is still refused even when nothing was spent.
    assert.throws(() => new NativeBudget(path, { ...uncappedAuthority, scopeId: 'OTHER', authorizationHash: 'd'.repeat(64) }, () => true), { code: 'BUDGET_AUTHORITY_EXCEEDED' });
});
test('HA005-U6 once a request exists the authorization identity is frozen against re-basing', t => {
    const h = harness(t), path = resolve(h.dir, 'frozen-identity.sqlite');
    const b = new NativeBudget(path, uncappedAuthority, () => true);
    const r = b.reserve('executor', quote(), 1024);
    b.settle(r.id, { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0 }, 'OK');
    const committed = b.summary().committedMicros;
    b.close();
    assert.throws(() => new NativeBudget(path, { ...uncappedAuthority, authorizationHash: 'e'.repeat(64) }, () => true), { code: 'BUDGET_AUTHORITY_EXCEEDED' });
    // The refusal left the ledger intact rather than half-migrated.
    const reopened = new NativeBudget(path, uncappedAuthority, () => true);
    assert.equal(reopened.summary().committedMicros, committed);
    assert.equal(reopened.db.prepare('SELECT count(*) n FROM authority_history').get().n, 0);
    reopened.close();
});
