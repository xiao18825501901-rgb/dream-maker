import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Encryption } from './siwc/types.js';

/**
 * Kimi token store (K03-T continuation).
 *
 * Design notes that are not negotiable here:
 *  - tokens never exist on disk in plaintext: the file holds only DPAPI ciphertext produced with
 *    Kimi's own entropy namespace (`dream-maker-kimi-dpapi-v1`), so the SIWC feature cannot read it;
 *  - writes keep the upstream transaction shape: tmp file -> fsync -> rename, 0600, dir 0700;
 *  - any read problem (missing file, bad ciphertext, bad JSON, wrong namespace) resolves to
 *    "no token" instead of throwing, matching the upstream `FileTokenStorage` contract.
 */
export interface KimiTokenStore {
    save(name: string, token: Record<string, unknown>): Promise<void>;
    /** Compatibility shim: "no usable token" collapses missing and corrupt. Prefer loadRecord(). */
    load(name: string): Promise<Record<string, unknown> | undefined>;
    /**
     * C03: the honest read. A missing file, a corrupt ciphertext and a wrong namespace are DIFFERENT
     * states — collapsing them into undefined is exactly the bug that made a damaged store look like
     * a fresh login and turned a real failure into "please log in again".
     */
    loadRecord(name: string): Promise<{ status: 'MISSING' } | { status: 'OK'; record: Record<string, unknown> } | { status: 'CORRUPT'; reason: string }>;
    remove(name: string): Promise<void>;
    list(): Promise<string[]>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const SUFFIX = '.dmkimi';

export function createKimiTokenStore(options: { dir: string; encryption: Encryption }): KimiTokenStore {
    const { dir, encryption } = options;
    const pathFor = (name: string): string => {
        if (!NAME.test(name) || basename(name) !== name) throw new Error('KIMI_TOKEN_NAME_INVALID');
        return join(dir, name + SUFFIX);
    };
    const ensureDir = (): void => { mkdirSync(dir, { recursive: true, mode: 0o700 }); };
    return {
        async save(name, token) {
            ensureDir();
            const target = pathFor(name);
            const ciphertext = await encryption.encrypt(JSON.stringify(token));
            const tmp = target + '.tmp.' + process.pid + '.' + randomBytes(4).toString('hex');
            const fd = openSync(tmp, 'w', 0o600);
            try {
                const buf = Buffer.from(ciphertext);
                let written = 0;
                while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written);
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
            try {
                renameSync(tmp, target);
            }
            catch (error) {
                try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
                throw error;
            }
        },
        async load(name) {
            let raw: Buffer;
            try {
                raw = readFileSync(pathFor(name));
            }
            catch {
                return undefined;
            }
            try {
                const plain = await encryption.decrypt(new Uint8Array(raw));
                const parsed: unknown = JSON.parse(plain);
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
                return parsed as Record<string, unknown>;
            }
            catch {
                return undefined;
            }
        },
        async loadRecord(name) {
            let raw: Buffer;
            try {
                raw = readFileSync(pathFor(name));
            }
            catch (error) {
                const code = (error as { code?: string }).code;
                if (code === 'ENOENT') return { status: 'MISSING' };
                return { status: 'CORRUPT', reason: 'READ_FAILED' };
            }
            let plain: string;
            try {
                plain = await encryption.decrypt(new Uint8Array(raw));
            }
            catch {
                // Confidentiality intact, integrity not: this must never look like "never logged in".
                return { status: 'CORRUPT', reason: 'DECRYPT_FAILED' };
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(plain);
            }
            catch {
                return { status: 'CORRUPT', reason: 'NOT_JSON' };
            }
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'CORRUPT', reason: 'NOT_OBJECT' };
            return { status: 'OK', record: parsed as Record<string, unknown> };
        },
        async remove(name) {
            try { rmSync(pathFor(name), { force: true }); } catch { /* ignore */ }
        },
        async list() {
            try {
                return readdirSync(dir).filter(f => f.endsWith(SUFFIX)).map(f => f.slice(0, -SUFFIX.length));
            }
            catch {
                return [];
            }
        }
    };
}
