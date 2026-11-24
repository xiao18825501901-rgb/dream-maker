import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowsCredentialEncryption } from '../dist/server/siwc/windows-credential-encryption.js';

// DPAPI namespace separation, verified with the REAL CurrentUser DPAPI on this Windows machine:
// a ciphertext written under the Kimi label must not be decryptable under the SIWC label, and vice
// versa. An injected fake runner cannot prove this, because with a fake the label changes nothing.

const KIMI = 'dream-maker-kimi-dpapi-v1';
const SIWC = 'dream-maker-siwc-dpapi-v1';

test('real DPAPI round-trips under each namespace', async t => {
    const kimi = createWindowsCredentialEncryption({ entropy: KIMI });
    const siwc = createWindowsCredentialEncryption({ entropy: SIWC });
    if (!(await kimi.isAvailable()) || !(await siwc.isAvailable())) {
        t.skip('DPAPI unavailable on this platform');
        return;
    }
    const cipher = await kimi.encrypt('SYNTHETIC_KIMI_TOKEN');
    assert.equal(await kimi.decrypt(cipher), 'SYNTHETIC_KIMI_TOKEN');
    const cipher2 = await siwc.encrypt('SYNTHETIC_SIWC_TOKEN');
    assert.equal(await siwc.decrypt(cipher2), 'SYNTHETIC_SIWC_TOKEN');
});

test('a Kimi ciphertext is not readable under the SIWC namespace', async t => {
    const kimi = createWindowsCredentialEncryption({ entropy: KIMI });
    const siwc = createWindowsCredentialEncryption({ entropy: SIWC });
    if (!(await kimi.isAvailable())) {
        t.skip('DPAPI unavailable on this platform');
        return;
    }
    const cipher = await kimi.encrypt('SYNTHETIC_KIMI_TOKEN');
    await assert.rejects(siwc.decrypt(cipher), /DPAPI_FAILURE|DPAPI_UNAVAILABLE/, 'cross-namespace decrypt must fail');
});

test('the default label stays the SIWC namespace', async t => {
    const fallback = createWindowsCredentialEncryption({});
    const explicit = createWindowsCredentialEncryption({ entropy: SIWC });
    if (!(await fallback.isAvailable())) {
        t.skip('DPAPI unavailable on this platform');
        return;
    }
    // Same label means interchangeable ciphertexts: the default is byte-compatible with the SIWC one.
    const cipher = await fallback.encrypt('SYNTHETIC_DEFAULT_TOKEN');
    assert.equal(await explicit.decrypt(cipher), 'SYNTHETIC_DEFAULT_TOKEN');
});
