import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyKimiFailure, redactAuthMessage, assertNoBlameWithoutProof, attachHttpStatus, httpStatusOf, httpPathOf, layerForPath, kimiFailureError } from '../dist/server/kimi-auth-errors.js';

// C02: attribution. The pinned upstream authService.classifyFailure maps almost every failure to
// "denied", so these tests exist to make sure this project never turns that bucket into
// "the user refused". Everything here is offline and synthetic.

test('C02-1 a bare denied flow is NOT a proven refusal', () => {
    const v = classifyKimiFailure({ stage: 'DEVICE_POLL', flowStatus: 'denied' });
    assert.equal(v.class, 'OAUTH_FLOW_FAILED_UNKNOWN');
    assert.equal(v.requiresUserAction, false);
    assert.match(v.reason, /denied/);
});

test('C02-2 only an explicit access_denied is attributed to the user', () => {
    assert.equal(classifyKimiFailure({ flowStatus: 'denied', oauthErrorCode: 'access_denied' }).class, 'USER_DENIED_PROVEN');
    assert.equal(classifyKimiFailure({ message: 'authorization denied by user' }).class, 'USER_DENIED_PROVEN');
    assert.equal(classifyKimiFailure({ flowStatus: 'denied', httpStatus: 400 }).class, 'OAUTH_FLOW_FAILED_UNKNOWN');
});

test('C02-3 expired, cancelled and timed out flows are not authorisation verdicts', () => {
    assert.equal(classifyKimiFailure({ flowStatus: 'expired' }).class, 'DEVICE_CODE_EXPIRED');
    assert.equal(classifyKimiFailure({ message: 'device code timed out' }).class, 'DEVICE_CODE_EXPIRED');
    assert.equal(classifyKimiFailure({ flowStatus: 'cancelled' }).class, 'FLOW_CANCELLED');
    assert.equal(classifyKimiFailure({ message: 'request aborted' }).class, 'FLOW_CANCELLED');
});

test('C02-4 transient transport failures keep the credentials', () => {
    for (const httpStatus of [429, 502, 503, 504]) {
        const v = classifyKimiFailure({ stage: 'REFRESH', httpStatus });
        assert.equal(v.class, 'TEMPORARY_NETWORK_ERROR');
        assert.equal(v.stopCredentialUse, false);
        assert.equal(v.retryable, true);
    }
    const net = classifyKimiFailure({ message: 'fetch failed: ECONNRESET' });
    assert.equal(net.class, 'TEMPORARY_NETWORK_ERROR');
    assert.equal(net.requiresUserAction, false);
});

test('C02-5 policy and region refusals are recorded, not blamed', () => {
    const v = classifyKimiFailure({ stage: 'DEVICE_REQUEST', httpStatus: 403 });
    assert.equal(v.class, 'REGION_OR_POLICY_RESTRICTED');
    assert.equal(v.requiresUserAction, false);
    assert.match(v.reason, /403|策略/);
});

test('C02-6 persistence and rotation outcomes outrank other signals', () => {
    assert.equal(classifyKimiFailure({ stage: 'TOKEN_SAVE', persistFailed: true, httpStatus: 503 }).class, 'TOKEN_PERSIST_FAILED');
    const uncertain = classifyKimiFailure({ stage: 'REFRESH', rotationUncertain: true, flowStatus: 'denied' });
    assert.equal(uncertain.class, 'AUTH_COMMIT_UNCERTAIN');
    assert.equal(uncertain.stopCredentialUse, true);
    assert.equal(uncertain.retryable, false);
});

test('C02-7 an explicit 401 or revoked credential still asks for reauthorisation', () => {
    assert.equal(classifyKimiFailure({ stage: 'REFRESH', httpStatus: 401 }).class, 'REAUTH_REQUIRED');
    assert.equal(classifyKimiFailure({ message: 'token was revoked' }).class, 'REAUTH_REQUIRED');
    assert.equal(classifyKimiFailure({ stage: 'REFRESH', httpStatus: 401 }).requiresUserAction, true);
});

test('C02-8 an unrecognised failure is UNKNOWN, never a refusal', () => {
    const v = classifyKimiFailure({ stage: 'UNKNOWN', message: 'something odd happened' });
    assert.equal(v.class, 'OAUTH_FLOW_FAILED_UNKNOWN');
    assert.equal(v.requiresUserAction, false);
    assert.equal(v.layer, 'L3_OAUTH');
});

test('C02-9 redaction removes device codes, urls, tokens and long opaque strings', () => {
    const raw = 'failed at https://www.kimi.com/code/authorize_device?user_code=ABCD-1234 token sk-abcdef1234567890 and 0123456789abcdef0123456789abcdef';
    const out = redactAuthMessage(raw);
    assert.equal(/https?:/.test(out), false);
    assert.equal(out.includes('ABCD-1234'), false);
    assert.equal(out.includes('sk-abcdef1234567890'), false);
    assert.equal(out.includes('0123456789abcdef0123456789abcdef'), false);
    assert.ok(out.length <= 181);
});

test('C02-10 the blame guard refuses a user-action verdict without proof', () => {
    const honest = classifyKimiFailure({ flowStatus: 'denied' });
    assert.doesNotThrow(() => assertNoBlameWithoutProof(honest, 'denied'));
    const bogus = { class: 'USER_DENIED_PROVEN', layer: 'L3_OAUTH', retryable: false, requiresUserAction: true, stopCredentialUse: true, reason: 'x' };
    assert.doesNotThrow(() => assertNoBlameWithoutProof(bogus, 'denied'));
    const liar = { ...honest, requiresUserAction: true };
    assert.throws(() => assertNoBlameWithoutProof(liar, 'denied'), { code: 'KIMI_AUTH_BLAME_WITHOUT_PROOF' });
});
test('C02-11 paths survive redaction; opaque secrets do not', () => {
    // A traceback is useless if the file path disappears into a placeholder.
    const withPath = redactAuthMessage('File "/tmp/dm-bridge-smoke/connect.py", line 11, in <module>');
    assert.match(withPath, /\/tmp\/dm-bridge-smoke\/connect\.py/);
    const windows = redactAuthMessage('C:/Users/Hp/AppData/Local/dream-maker/sqlite.db failed');
    assert.match(windows, /dream-maker\/sqlite\.db/);
    // A long opaque token with no separator is still removed.
    const secret = redactAuthMessage('value 0123456789abcdef0123456789abcdef');
    assert.equal(secret.includes('0123456789abcdef0123456789abcdef'), false);
    assert.match(secret, /<opaque>/);
});
// ---------------------------------------------------------------------------------------------------
// Four-layer separation. The runtime used to discard the HTTP status at the fetch boundary, so a 401
// on a model turn or on the local management bearer looked exactly like a revoked OAuth grant and
// could surface as "please log in again". These cases pin the honest mapping.
// ---------------------------------------------------------------------------------------------------

test('C02-12 a 401 on the model turn is not proof that the account needs a new login', () => {
    const v = classifyKimiFailure({ stage: 'UNKNOWN', httpStatus: 401, layer: 'L4_TURN' });
    assert.equal(v.class, 'OAUTH_FLOW_FAILED_UNKNOWN');
    assert.equal(v.layer, 'L4_TURN');
    assert.equal(v.requiresUserAction, false);
    assert.equal(v.stopCredentialUse, false);
    assert.equal(v.retryable, true);
});

test('C02-13 the same 401 becomes REAUTH_REQUIRED only after a real refresh attempt', () => {
    const v = classifyKimiFailure({ stage: 'UNKNOWN', httpStatus: 401, layer: 'L4_TURN', refreshAttempted: true });
    assert.equal(v.class, 'REAUTH_REQUIRED');
    assert.equal(v.requiresUserAction, true);
    assert.equal(v.stopCredentialUse, true);
});

test('C02-14 a rejected local management bearer stays on L2 and does not blame the account', () => {
    const v = classifyKimiFailure({ stage: 'UNKNOWN', httpStatus: 401, layer: 'L2_MANAGEMENT_AUTH' });
    assert.equal(v.class, 'OAUTH_FLOW_FAILED_UNKNOWN');
    assert.equal(v.layer, 'L2_MANAGEMENT_AUTH');
    assert.equal(v.requiresUserAction, false);
    // The pre-existing L3 behaviour must not change: a rejected grant is still a reauth.
    const l3 = classifyKimiFailure({ stage: 'REFRESH', httpStatus: 401 });
    assert.equal(l3.class, 'REAUTH_REQUIRED');
    assert.equal(l3.requiresUserAction, true);
});

test('C02-15 the carried HTTP status is invisible to every existing caller', () => {
    const body = attachHttpStatus({ code: 0, data: { ok: true } }, 401, '/api/v1/sessions');
    assert.equal(httpStatusOf(body), 401);
    assert.equal(httpPathOf(body), '/api/v1/sessions');
    // Byte-identical payload: JSON, key enumeration and deep equality cannot see the symbol.
    assert.equal(JSON.stringify(body), '{"code":0,"data":{"ok":true}}');
    assert.deepEqual(Object.keys(body), ['code', 'data']);
    assert.deepEqual(body, { code: 0, data: { ok: true } });
    assert.equal(httpStatusOf({ code: 0 }), undefined);
});

test('C02-16 paths map to the layer they actually belong to', () => {
    for (const p of ['/api/v1/sessions', '/api/v1/sessions/session_x/prompts', '/api/v1/sessions/session_x/transcript?page_size=1'])
        assert.equal(layerForPath(p), 'L4_TURN', p);
    assert.equal(layerForPath('/api/v1/oauth/userinfo'), 'L3_OAUTH');
    for (const p of ['/api/v1/auth', '/api/v1/models', '/api/v1/sessions_x'.replace('sessions_x', 'health')])
        assert.equal(layerForPath(p), 'L2_MANAGEMENT_AUTH', p);
});

test('C02-17 every class maps to one stable error code and keeps its layer visible', () => {
    const expected = {
        AUTH_COMMIT_UNCERTAIN: ['KIMI_AUTH_COMMIT_UNCERTAIN', 409],
        TOKEN_PERSIST_FAILED: ['KIMI_TOKEN_PERSIST_FAILED', 409],
        USER_DENIED_PROVEN: ['KIMI_AUTH_USER_DENIED', 403],
        OAUTH_FLOW_FAILED_UNKNOWN: ['KIMI_AUTH_UNKNOWN', 502],
        DEVICE_CODE_EXPIRED: ['KIMI_AUTH_DEVICE_EXPIRED', 409],
        FLOW_CANCELLED: ['KIMI_AUTH_CANCELLED', 409],
        TEMPORARY_NETWORK_ERROR: ['KIMI_AUTH_TRANSIENT', 503],
        REGION_OR_POLICY_RESTRICTED: ['KIMI_AUTH_REGION', 403],
        REAUTH_REQUIRED: ['KIMI_REAUTH_REQUIRED', 401]
    };
    for (const [cls, [code, status]] of Object.entries(expected)) {
        const err = kimiFailureError({ class: cls, layer: 'L4_TURN', retryable: false, requiresUserAction: false, stopCredentialUse: false, reason: 'r' });
        assert.equal(err.code, code, cls);
        assert.equal(err.status, status, cls);
        assert.match(err.message, /^\[L4_TURN\] /, cls);
    }
});
// C02 timeout hygiene: "the socket was slow" and "the device code expired" are different facts, and
// only the second one belongs to the device flow. Confusing them sends the reader back to a login.
test('C02-18 a timeout outside the device flow is transient, not an expired device code', () => {
    for (const input of [
        { layer: 'L4_TURN', stage: 'UNKNOWN', message: 'turn timed out after 120000ms' },
        { layer: 'L3_OAUTH', stage: 'REFRESH', message: 'request timed out' },
        { layer: 'L2_MANAGEMENT_AUTH', stage: 'UNKNOWN', message: 'timeout' }
    ]) {
        const v = classifyKimiFailure(input);
        assert.equal(v.class, 'TEMPORARY_NETWORK_ERROR', JSON.stringify(input));
        assert.equal(v.requiresUserAction, false);
        assert.equal(v.stopCredentialUse, false, 'a slow socket never invalidates a credential');
        assert.equal(v.layer, input.layer);
    }
});

test('C02-19 a device-code expiry stays inside the device flow', () => {
    assert.equal(classifyKimiFailure({ stage: 'DEVICE_POLL', flowStatus: 'expired' }).class, 'DEVICE_CODE_EXPIRED');
    assert.equal(classifyKimiFailure({ stage: 'DEVICE_REQUEST', message: 'timed out waiting for device code' }).class, 'DEVICE_CODE_EXPIRED');
    assert.equal(classifyKimiFailure({ message: 'device code timed out' }).class, 'DEVICE_CODE_EXPIRED');
    // A bare timeout with no device-flow context must not land here any more.
    assert.notEqual(classifyKimiFailure({ stage: 'UNKNOWN', message: 'timeout' }).class, 'DEVICE_CODE_EXPIRED');
});
// C02 blame hygiene: the deny *text* is not the deny *fact*. Outside the authorisation flow the same
// words must never become "the owner refused", because that is a demand only a human can satisfy.
test('C02-20 deny text observed outside the OAuth flow never blames the owner', () => {
    const turn = classifyKimiFailure({ layer: 'L4_TURN', httpStatus: 403, message: 'access_denied' });
    assert.equal(turn.class, 'REGION_OR_POLICY_RESTRICTED');
    assert.equal(turn.requiresUserAction, false);
    const management = classifyKimiFailure({ layer: 'L2_MANAGEMENT_AUTH', httpStatus: 403, message: 'access_denied' });
    assert.equal(management.requiresUserAction, false);
    const noStatus = classifyKimiFailure({ layer: 'L4_TURN', message: 'access_denied' });
    assert.notEqual(noStatus.class, 'USER_DENIED_PROVEN');
    assert.equal(noStatus.requiresUserAction, false);
    // Inside the flow it is still a real refusal.
    const flow = classifyKimiFailure({ layer: 'L3_OAUTH', stage: 'DEVICE_POLL', oauthErrorCode: 'access_denied' });
    assert.equal(flow.class, 'USER_DENIED_PROVEN');
    assert.equal(flow.requiresUserAction, true);
});

test('C02-21 the blame guard also refuses a proven refusal observed on the wrong layer', () => {
    const wrongLayer = { class: 'USER_DENIED_PROVEN', layer: 'L4_TURN', retryable: false, requiresUserAction: true, stopCredentialUse: true, reason: 'x' };
    assert.throws(() => assertNoBlameWithoutProof(wrongLayer, undefined), { code: 'KIMI_AUTH_BLAME_WITHOUT_PROOF' });
    const okLayer = { ...wrongLayer, layer: 'L3_OAUTH' };
    assert.doesNotThrow(() => assertNoBlameWithoutProof(okLayer, undefined));
});
test('C02-22 a rejection delivered only as message text gets the same layer rule as a 401', () => {
    for (const input of [
        { layer: 'L4_TURN', message: 'unauthorized' },
        { layer: 'L4_TURN', message: 'token was revoked' },
        { layer: 'L2_MANAGEMENT_AUTH', message: 'unauthorized' },
        { layer: 'L1_LOCAL_SESSION', message: 'unauthorized' }
    ]) {
        const v = classifyKimiFailure(input);
        assert.equal(v.class, 'OAUTH_FLOW_FAILED_UNKNOWN', JSON.stringify(input));
        assert.equal(v.requiresUserAction, false);
        assert.equal(v.stopCredentialUse, false);
        assert.equal(v.layer, input.layer);
    }
    // Inside the grant the same words stay a real reauth, and so does a post-refresh rejection.
    assert.equal(classifyKimiFailure({ layer: 'L3_OAUTH', message: 'token was revoked' }).class, 'REAUTH_REQUIRED');
    assert.equal(classifyKimiFailure({ layer: 'L4_TURN', message: 'unauthorized', refreshAttempted: true }).class, 'REAUTH_REQUIRED');
    assert.equal(classifyKimiFailure({ message: 'token was revoked' }).class, 'REAUTH_REQUIRED');
});
