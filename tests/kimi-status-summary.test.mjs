import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeKimiStatus, summarizeBridgeDurability } from '../dist/web/kimi-status-summary.js';
import { summarizeNativeReadiness, explainNativeReason } from '../dist/web/native-readiness-summary.js';

// A07: the wording contract. The point is which cases must NOT tell the owner to log in again.

const extraOk = { state: 'OFF', allowsSend: true, reason: 'OK' };
const cred = over => ({ barrier: 'READY', state: 'OK', generation: 3, reason: null, expiresAt: 1_700_000_000_000, ...over });

test('A07-W1 unproven Extra Usage is reported as a gate, never as a login problem', () => {
    const s = summarizeKimiStatus({ admission: { state: 'UNKNOWN', allowsSend: false, reason: 'KIMI_EXTRA_USAGE_UNKNOWN' }, credentials: cred({}), inferenceAllowed: false });
    assert.equal(s.needsLogin, false);
    assert.match(s.headline, /Extra Usage/);
    assert.equal(/登录/.test(s.headline), false, 'headline must not ask for a login');
});

test('A07-W2 an expired evidence and an enabled wallet are different sentences', () => {
    const expired = summarizeKimiStatus({ admission: { state: 'OFF', allowsSend: false, reason: 'KIMI_EXTRA_USAGE_EVIDENCE_EXPIRED' }, credentials: cred({}), inferenceAllowed: false });
    const enabled = summarizeKimiStatus({ admission: { state: 'ON', allowsSend: false, reason: 'ACCOUNT_REPORTS_ENABLED' }, credentials: cred({}), inferenceAllowed: false });
    assert.match(expired.headline, /过期/);
    assert.match(enabled.headline, /已开启/);
    assert.equal(enabled.level, 'error');
    assert.equal(expired.needsLogin, false);
});

test('A07-W3 a damaged store says "do not log in, do not clear"', () => {
    const s = summarizeKimiStatus({ admission: extraOk, credentials: cred({ state: 'CORRUPT', reason: 'DECRYPT_FAILED' }), inferenceAllowed: false });
    assert.equal(s.needsLogin, false);
    assert.match(s.detail, /不要清空/);
});

test('A07-W4 only MISSING and REVOKED may ask for a human authorisation', () => {
    const missing = summarizeKimiStatus({ admission: extraOk, credentials: cred({ state: 'MISSING' }), inferenceAllowed: false });
    const revoked = summarizeKimiStatus({ admission: extraOk, credentials: cred({ state: 'REVOKED' }), inferenceAllowed: false });
    assert.equal(missing.needsLogin, true);
    assert.equal(revoked.needsLogin, true);
});

test('A07-W5 a pending restore is an ordering fact, not an account fact', () => {
    const s = summarizeKimiStatus({ admission: extraOk, credentials: cred({ barrier: 'PENDING' }), inferenceAllowed: false });
    assert.equal(s.needsLogin, false);
    assert.match(s.detail, /不是登录失效/);
});

test('A07-W6 only a fully permitted state reads as OK, and it still mentions the other gates', () => {
    const ok = summarizeKimiStatus({ admission: extraOk, credentials: cred({}), inferenceAllowed: true });
    assert.equal(ok.level, 'ok');
    assert.match(ok.detail, /预算/);
    const noPermit = summarizeKimiStatus({ admission: extraOk, credentials: cred({}), inferenceAllowed: false });
    assert.notEqual(noPermit.level, 'ok');
});
// C03/C04: the channel line. Durability is the point: an ACKed rotation is proof, a rotation newer
// than its ACK is the uncertain case, and neither is ever a login problem.
test('C04-S1 a rotation that was acknowledged reads as proof, not as a login issue', () => {
    const s = summarizeBridgeDurability({ topology: 'connector', running: true, error: null, frames: { frames: 4, counts: { HELLO: 1, RESTORE: 1, ROTATE: 1, COMMIT_ACK: 1 }, lastRotateGeneration: 6, lastAckGeneration: 6, lastErrorCode: null, closed: false } });
    assert.equal(s.level, 'ok');
    assert.match(s.headline, /已确认轮转 gen 6/);
    assert.equal(s.needsLogin, false);
});
test('C04-S2 a rotation newer than its ACK is the uncertain case and asks for reconciliation', () => {
    const s = summarizeBridgeDurability({ topology: 'connector', running: true, frames: { lastRotateGeneration: 7, lastAckGeneration: 6 } });
    assert.equal(s.level, 'warn');
    assert.match(s.headline, /gen 7/);
    assert.match(s.detail, /对账/);
    assert.equal(s.needsLogin, false);
});
test('C04-S3 an error code, a closed channel and a failed start stay distinct', () => {
    const err = summarizeBridgeDurability({ topology: 'connector', running: true, frames: { lastErrorCode: 'KIMI_TOKEN_PERSIST_FAILED' } });
    assert.equal(err.level, 'error');
    assert.match(err.headline, /KIMI_TOKEN_PERSIST_FAILED/);
    const closed = summarizeBridgeDurability({ topology: 'spawn', running: true, frames: { closed: true } });
    assert.equal(closed.level, 'warn');
    const failed = summarizeBridgeDurability({ topology: 'connector', running: false, error: 'KIMI_BRIDGE_DISTRO_INVALID' });
    assert.equal(failed.level, 'error');
    assert.match(failed.headline, /KIMI_BRIDGE_DISTRO_INVALID/);
    for (const s of [err, closed, failed]) assert.equal(s.needsLogin, false);
});
test('C04-S4 the default state is "off", which is not a login problem either', () => {
    for (const payload of [null, undefined, { topology: 'off' }, { topology: 'connector', running: false }]) {
        const s = summarizeBridgeDurability(payload);
        assert.notEqual(s.level, 'ok');
        assert.equal(s.needsLogin, false);
    }
});
// A08: "Live is blocked" must read as a concrete gap list, never as a login problem or a mystery.
test('A08-N1 every real readiness reason becomes a concrete gap, and none blames the account', () => {
    const live = summarizeNativeReadiness({
        ok: false,
        reasons: ['DSH_NATIVE_MODULE_MISSING', 'ISOLATED_CODEX_HOME_REQUIRED', 'CODEX_MODEL_REQUIRED', 'NATIVE_AUDIT_REQUIRED', 'NATIVE_OPERATOR_CONFIG_REQUIRED'],
        configurationHash: '9d49ad7d'
    });
    assert.equal(live.level, 'error');
    assert.match(live.headline, /缺 5 项/);
    assert.equal(live.needsLogin, false);
    assert.equal(live.blockers.length, 5);
    for (const b of live.blockers) assert.doesNotMatch(b, /未分类/, 'a reported reason must be explained, not passed through raw');
    assert.match(live.detail, /与 Kimi 账号登录无关/);
});
test('A08-N2 an unknown code stays visible instead of being hidden', () => {
    assert.match(explainNativeReason('SOMETHING_NEW'), /未分类原因：SOMETHING_NEW/);
    const s = summarizeNativeReadiness({ ok: false, reasons: ['SOMETHING_NEW'] });
    assert.match(s.detail, /SOMETHING_NEW/);
    assert.equal(s.needsLogin, false);
});
test('A08-N3 ready, unknown and every audit-detail code are distinguished', () => {
    const ready = summarizeNativeReadiness({ ok: true, reasons: [] });
    assert.equal(ready.level, 'ok');
    assert.equal(ready.blockers.length, 0);
    const unknown = summarizeNativeReadiness(null);
    assert.equal(unknown.level, 'warn');
    assert.equal(unknown.needsLogin, false);
    for (const code of ['NATIVE_AUDIT_NOT_READY', 'NATIVE_AUDIT_CONFIG_MISMATCH', 'NATIVE_AUDIT_EXPIRED', 'NATIVE_ISOLATION_UNVERIFIED', 'NATIVE_LAYA_OFF_UNVERIFIED', 'NATIVE_VERIFIER_NOT_IMPLEMENTED', 'NATIVE_EVIDENCE_MISMATCH', 'NATIVE_MODULE_CHANGED',
        'NATIVE_SANDBOX_EXECUTION_UNVERIFIED', 'NATIVE_OPERATOR_BINDING_NOT_AUDITED', 'NATIVE_TEMPLATE_LIMITS_INVALID', 'NATIVE_SCOPE_LIMITS_EXCEEDED', 'NATIVE_REAL_PROBES_REQUIRED', 'NATIVE_BINDING_CHANGED', 'TRUSTED_VERIFIER_PLAN_REQUIRED', 'NATIVE_LAYA_BASELINE_REQUIRED', 'PROBE_EVIDENCE_UNVERIFIED'])
        assert.doesNotMatch(explainNativeReason(code), /未分类/, code);
});
// The probe gate is the one readiness reason that names no cause by itself: it must name the roles.
test('A08-N4 the probe gate lists the roles that are missing and the one already proven', () => {
    const gate = { phase: 'PROBE', requests: 0, maxRequests: 30, roles: {
        planner1: { present: true, valid: true }, planner2: { present: false, valid: false },
        executor: { present: false, valid: false }, reviewer: { present: false, valid: false } } };
    const s = summarizeNativeReadiness({ ok: false, reasons: ['NATIVE_REAL_PROBES_REQUIRED'], probeGate: gate });
    assert.match(s.detail, /待补/);
    assert.match(s.detail, /Planner（独立 Codex 拆解）/);
    assert.match(s.detail, /Executor（DSH \+ DeepSeek 执行）/);
    assert.match(s.detail, /已有效：Seeker（Kimi 澄清）/);
    assert.ok(s.ownerActions.some(a => /native\/probes/.test(a)), 'the owner action must name the probe route');
    assert.equal(s.needsLogin, false);
    // A gate that could not be read must not invent roles.
    const blind = summarizeNativeReadiness({ ok: false, reasons: ['NATIVE_REAL_PROBES_REQUIRED'], probeGate: { error: 'NATIVE_PROBE_STATUS_UNAVAILABLE' } });
    assert.doesNotMatch(blind.detail, /待补|已有效/);
    assert.match(blind.detail, /四角色最小探测收据不齐/);
});
test('A08-N4b a spec with no registered verifier plan is explained and turned into an action', () => {
    // This code reached the owner as a doubled banner ("TRUSTED_VERIFIER_PLAN_REQUIRED · TRUSTED_VERIFIER_PLAN_REQUIRED")
    // because it had neither a sentence nor an owner action while every neighbouring code had both.
    const s = summarizeNativeReadiness({ ok: false, reasons: ['TRUSTED_VERIFIER_PLAN_REQUIRED'] });
    assert.doesNotMatch(s.blockers[0], /未分类/);
    assert.match(s.blockers[0], /可信验证器计划/);
    assert.ok(s.ownerActions.some(a => /specHash/.test(a)), 'the action must say the plan is matched by specHash');
    assert.equal(s.needsLogin, false);
});
test('A08-N5 codes the owner alone can clear are stated as actions, not as a Kimi login', () => {
    const s = summarizeNativeReadiness({ ok: false, reasons: ['DSH_KEY_MISSING', 'CODEX_SUBSCRIPTION_ACCOUNT_REQUIRED'] });
    assert.equal(s.needsLogin, false, 'neither gap is a Kimi account problem');
    assert.equal(s.ownerActions.length, 2);
    assert.ok(s.ownerActions.some(a => /DEEPSEEK_API_KEY/.test(a)));
    assert.ok(s.ownerActions.some(a => /codex login/.test(a)));
    assert.match(s.detail, /与 Kimi 账号登录无关/);
});
test('C02-S11 the summary shows a proven runtime rejection and merely mentions an unproven one', () => {
    const admission = { state: 'OFF', allowsSend: true, reason: 'OK' };
    const credentials = { barrier: 'READY', state: 'OK', generation: 3, reason: null, expiresAt: null };
    const rejected = summarizeKimiStatus({ admission, credentials, inferenceAllowed: true, note: 'KIMI_GRANT_REJECTED_AT_RUNTIME', lastAuthFailure: { class: 'REAUTH_REQUIRED', layer: 'L3_OAUTH', code: 'KIMI_REAUTH_REQUIRED', atMs: 1 } });
    assert.equal(rejected.level, 'error');
    assert.equal(rejected.needsLogin, true);
    assert.match(rejected.headline, /L3/);
    const unproven = summarizeKimiStatus({ admission, credentials, inferenceAllowed: true, note: 'OK', lastAuthFailure: { class: 'OAUTH_FLOW_FAILED_UNKNOWN', layer: 'L4_TURN', code: 'KIMI_AUTH_UNKNOWN', atMs: 1 } });
    assert.equal(unproven.level, 'ok');
    assert.equal(unproven.needsLogin, false);
    assert.match(unproven.detail, /OAUTH_FLOW_FAILED_UNKNOWN/);
    const clean = summarizeKimiStatus({ admission, credentials, inferenceAllowed: true, note: 'OK' });
    assert.equal(clean.detail.includes('最近一次认证失败'), false);
});
test('C05-S9 an unreadable store is not reported as damage and never as a login', () => {
    const admission = { state: 'OFF', allowsSend: true, reason: 'OK' };
    const unreadable = summarizeKimiStatus({ admission, credentials: { barrier: 'FAILED', state: 'CORRUPT', generation: null, reason: 'READ_FAILED', expiresAt: null }, inferenceAllowed: false });
    assert.equal(unreadable.level, 'warn');
    assert.match(unreadable.headline, /无法读取/);
    assert.match(unreadable.detail, /不是"未登录"/);
    assert.equal(unreadable.needsLogin, false);
    // Real damage keeps its own, stronger wording.
    const damaged = summarizeKimiStatus({ admission, credentials: { barrier: 'FAILED', state: 'CORRUPT', generation: null, reason: 'DECRYPT_FAILED', expiresAt: null }, inferenceAllowed: false });
    assert.equal(damaged.level, 'error');
    assert.match(damaged.headline, /损坏/);
    assert.equal(damaged.needsLogin, false);
});
test('C04-S5 a channel with no peer frame yet is described as such, without crying wolf', () => {
    // A healthy bridge stays silent until a rotation happens, so this is the normal post-startup state.
    const fresh = summarizeBridgeDurability({ topology: 'connector', running: true, error: null, frames: { frames: 2, counts: { HELLO: 1, RESTORE: 1 }, inbound: {}, established: false, lastRotateGeneration: null, lastAckGeneration: null, lastErrorCode: null, closed: false } });
    assert.equal(fresh.level, 'ok');
    assert.match(fresh.headline, /尚未收到对端帧/);
    assert.equal(fresh.needsLogin, false);
    // Once a frame came back but no rotation was confirmed, the wording says exactly that.
    const talking = summarizeBridgeDurability({ topology: 'connector', running: true, error: null, frames: { frames: 3, counts: { HELLO: 1, RESTORE: 1 }, inbound: { HELLO: 1 }, established: true, lastRotateGeneration: null, lastAckGeneration: null, lastErrorCode: null, closed: false } });
    assert.match(talking.headline, /尚无已确认轮转/);
    assert.notEqual(talking.headline, fresh.headline);
    // An acknowledged rotation implies inbound traffic, so it is never "no peer".
    const acked = summarizeBridgeDurability({ topology: 'connector', running: true, frames: { lastRotateGeneration: 2, lastAckGeneration: 2 }, lastErrorCode: null, closed: false });
    assert.equal(acked.level, 'ok');
    assert.match(acked.headline, /已确认轮转 gen 2/);
});
test('C04-S6 a connector that exited reports its exit status instead of vanishing', () => {
    // Observed: with a dead socket the connector exits rc=3 while "we started it once" stayed true.
    const exited = summarizeBridgeDurability({ topology: 'connector', running: false, error: 'KIMI_BRIDGE_EXITED:3', frames: { frames: 2, counts: { HELLO: 1, RESTORE: 1 }, inbound: {}, established: false, lastRotateGeneration: null, lastAckGeneration: null, lastErrorCode: null, closed: false } });
    assert.equal(exited.level, 'warn');
    assert.match(exited.headline, /通道进程已退出/);
    assert.match(exited.headline, /3/);
    assert.equal(exited.needsLogin, false);
    // Without an exit status the message stays generic rather than inventing a reason.
    const generic = summarizeBridgeDurability({ topology: 'connector', running: false, error: null, frames: null });
    assert.equal(generic.level, 'warn');
    assert.equal(generic.needsLogin, false);
});
