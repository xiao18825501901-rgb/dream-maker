import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createKimiTokenStore } from '../dist/server/kimi-token-store.js';

// Offline tests with a synthetic encryption: this proves the file format, the atomic write, the
// name rules and the "any problem means no token" contract. It does NOT prove DPAPI itself, which
// is covered separately against the real Windows DPAPI.

const fakeEncryption = () => ({
    id: 'synthetic',
    isAvailable: async () => true,
    encrypt: async (text) => { const b = Buffer.from(text, 'utf8'); for (let i = 0; i < b.length; i++) b[i] ^= 0x33; return new Uint8Array(b); },
    decrypt: async (bytes) => { const b = Buffer.from(bytes); for (let i = 0; i < b.length; i++) b[i] ^= 0x33; return b.toString('utf8'); }
});

function rig(t) {
    const dir = mkdtempSync(resolve(tmpdir(), 'dm-kimi-token-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return { dir, store: createKimiTokenStore({ dir, encryption: fakeEncryption() }) };
}

test('K03-T1 a saved token round-trips and never appears in plaintext on disk', async t => {
    const { dir, store } = rig(t);
    await store.save('managed-kimi-code', { access_token: 'SYNTHETIC_ACCESS_TOKEN', refresh_token: 'SYNTHETIC_REFRESH' });
    const loaded = await store.load('managed-kimi-code');
    assert.equal(loaded.access_token, 'SYNTHETIC_ACCESS_TOKEN');
    const files = readdirSync(dir);
    assert.deepEqual(files, ['managed-kimi-code.dmkimi']);
    const bytes = readFileSync(resolve(dir, files[0]));
    assert.equal(bytes.toString('utf8').includes('SYNTHETIC_ACCESS_TOKEN'), false, 'plaintext must not be on disk');
    assert.deepEqual(await store.list(), ['managed-kimi-code']);
});

test('K03-T2 a missing file, a corrupted ciphertext and a corrupted payload all mean "no token"', async t => {
    const { dir, store } = rig(t);
    assert.equal(await store.load('absent'), undefined);
    writeFileSync(resolve(dir, 'broken.dmkimi'), Buffer.from([0, 1, 2, 3]));
    assert.equal(await store.load('broken'), undefined);
    // Valid XOR but not JSON after decryption.
    const notJson = Buffer.from('not json at all', 'utf8');
    for (let i = 0; i < notJson.length; i++) notJson[i] ^= 0x33;
    writeFileSync(resolve(dir, 'notjson.dmkimi'), notJson);
    assert.equal(await store.load('notjson'), undefined);
});

test('K03-T3 remove and list behave, and unsafe names are refused', async t => {
    const { store } = rig(t);
    await store.save('one', { a: 1 });
    await store.save('two', { b: 2 });
    assert.deepEqual((await store.list()).sort(), ['one', 'two']);
    await store.remove('one');
    assert.deepEqual(await store.list(), ['two']);
    await assert.rejects(store.save('../escape', { x: 1 }), /KIMI_TOKEN_NAME_INVALID/);
    await assert.rejects(store.save('.hidden', { x: 1 }), /KIMI_TOKEN_NAME_INVALID/);
    await assert.rejects(store.save('bad name', { x: 1 }), /KIMI_TOKEN_NAME_INVALID/);
});

test('K03-T4 saving twice leaves exactly one file and no temporary files', async t => {
    const { dir, store } = rig(t);
    await store.save('same', { v: 1 });
    await store.save('same', { v: 2 });
    assert.deepEqual(readdirSync(dir), ['same.dmkimi']);
    assert.equal((await store.load('same')).v, 2);
});
