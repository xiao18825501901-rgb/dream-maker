import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';

const SCHEMA = 'dream-maker.server-lock.v1';

export interface ServerLockRecord {
    schema: typeof SCHEMA;
    pid: number;
    processIdentity: string;
    acquiredAt: string;
    host: string;
    dataDir: string;
    nonce: string;
}

interface AcquireOptions {
    pid?: number;
    identity?: string;
    identityProvider?: (pid: number) => string | null;
    now?: Date;
    nonce?: string;
    host?: string;
    dataDir?: string;
}

export interface AcquiredServerLock {
    path: string;
    record: ServerLockRecord;
    release(): boolean;
}

export class ServerLockError extends Error {
    constructor(
        public readonly code:
            | 'SERVER_LOCK_ACTIVE'
            | 'SERVER_LOCK_LEGACY'
            | 'SERVER_LOCK_INVALID'
            | 'SERVER_LOCK_ACQUISITION_BUSY'
            | 'SERVER_LOCK_IDENTITY_UNAVAILABLE'
            | 'SERVER_LOCK_WRITE_FAILED',
        message: string,
        public readonly ownerPid?: number,
    ) {
        super(message);
        this.name = 'ServerLockError';
    }
}

function isValidRecord(value: unknown): value is ServerLockRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value as Partial<ServerLockRecord>;
    return record.schema === SCHEMA
        && Number.isSafeInteger(record.pid)
        && Number(record.pid) > 0
        && typeof record.processIdentity === 'string'
        && record.processIdentity.length > 0
        && typeof record.acquiredAt === 'string'
        && Number.isFinite(Date.parse(record.acquiredAt))
        && typeof record.host === 'string'
        && record.host.length > 0
        && typeof record.dataDir === 'string'
        && typeof record.nonce === 'string'
        && record.nonce.length >= 16;
}

function readExisting(path: string): ServerLockRecord | null {
    if (!existsSync(path))
        return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        throw new ServerLockError('SERVER_LOCK_INVALID', 'The existing server.lock is not valid JSON; ownership cannot be established.');
    }
    if (isValidRecord(parsed))
        return parsed;
    if (parsed && typeof parsed === 'object' && 'pid' in parsed)
        throw new ServerLockError('SERVER_LOCK_LEGACY', 'The existing server.lock lacks a process identity; it will not be removed automatically.');
    throw new ServerLockError('SERVER_LOCK_INVALID', 'The existing server.lock does not match the current lock schema.');
}

/** The one OS query behind the identity probe, injectable so a test can prove the
 *  bounded retry and the per-process cache without spawning PowerShell. */
export const windowsIdentityProbe = {
    run(pid: number): string {
        const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [string]$p.StartTime.ToUniversalTime().Ticks`;
        return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            encoding: 'utf8',
            windowsHide: true,
            // Measured on the owner's machine: a warm query is ~2.6s, but under load a
            // cold Windows PowerShell start reached 18.9s, and 39.9s during the run that
            // failed. 5s killed correct dispatches. The controller's own pid is cached, so
            // this ceiling is paid at most once per process; child probes stay best-effort.
            timeout: 20000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    },
};

// A process's start ticks never change while it runs, so a resolved identity is
// reusable. Only this controller's own pid is cached: it cannot be reused while the
// process runs, whereas caching a child pid could hand back a stale identity after
// the OS reuses that number. The controller asks for its own identity on every job
// launch; without this cache each launch paid a fresh (and occasionally cold) start.
const identityCache = new Map<number, string>();
export function resetProcessIdentityCache(): void { identityCache.clear(); }

/** Stable process identity: Windows start ticks or Linux boot id plus start ticks.
 *
 *  A cold PowerShell start on the owner's machine measured 39.9s / 14.9s after
 *  contention against the hard 5s query ceiling, which blocked a paid dispatch with
 *  `spawnSync powershell.exe ETIMEDOUT`. The query is read-only and its answer is
 *  immutable for a live process, so a transient timeout gets exactly one retry before
 *  the failure is reported as unknown. */
export function probeProcessIdentity(pid: number): string | null {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error('Invalid process id');
    try {
        process.kill(pid, 0);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH')
            return null;
        throw error;
    }

    if (process.platform === 'win32') {
        const cacheable = pid === process.pid;
        const cached = cacheable ? identityCache.get(pid) : undefined;
        if (cached) return cached;
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const ticks = windowsIdentityProbe.run(pid).trim();
                if (!/^\d+$/.test(ticks))
                    throw new Error('Process start identity was not numeric');
                const identity = `win32:${ticks}`;
                if (cacheable) identityCache.set(pid, identity);
                return identity;
            } catch (error) {
                lastError = error;
                // Only a transient query timeout is retried; a denied query or a
                // numeric-shape failure is a real answer and must surface unchanged.
                if ((error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') throw error;
            }
        }
        throw lastError;
    }

    if (process.platform === 'linux') {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const afterName = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        const startTicks = afterName[19];
        const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
        if (!/^\d+$/.test(startTicks ?? '') || !bootId)
            throw new Error('Linux process start identity is unavailable');
        return `linux:${bootId}:${startTicks}`;
    }

    throw new Error(`Unsupported process platform: ${process.platform}`);
}

function archiveStale(path: string, prior: ServerLockRecord, now: Date): void {
    const suffix = `${now.toISOString().replace(/[:.]/g, '-')}-${prior.nonce.slice(0, 8)}`;
    renameSync(path, resolve(dirname(path), `server.lock.stale-${suffix}`));
}

export function acquireServerLock(path: string, options: AcquireOptions = {}): AcquiredServerLock {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const pid = options.pid ?? process.pid;
    const identityProvider = options.identityProvider ?? probeProcessIdentity;
    let identity = options.identity;
    if (!identity) {
        try {
            identity = identityProvider(pid) ?? undefined;
        } catch (error) {
            throw new ServerLockError(
                'SERVER_LOCK_IDENTITY_UNAVAILABLE',
                `Cannot verify the current process identity: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    if (!identity)
        throw new ServerLockError('SERVER_LOCK_IDENTITY_UNAVAILABLE', 'Cannot acquire server.lock without a stable process identity.');

    const guard = `${path}.acquire`;
    try {
        mkdirSync(guard, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new ServerLockError(
                'SERVER_LOCK_ACQUISITION_BUSY',
                `Another process is evaluating ${path}; inspect ${guard} before retrying.`,
            );
        }
        throw new ServerLockError(
            'SERVER_LOCK_WRITE_FAILED',
            `Cannot create the server.lock acquisition guard: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    try {
        const now = options.now ?? new Date();
        const prior = readExisting(path);
        if (prior) {
            let priorIdentity: string | null = prior.processIdentity;
            if (prior.pid !== pid) {
                try {
                    priorIdentity = identityProvider(prior.pid);
                } catch (error) {
                    throw new ServerLockError(
                        'SERVER_LOCK_IDENTITY_UNAVAILABLE',
                        `Cannot verify the existing lock owner: ${error instanceof Error ? error.message : String(error)}`,
                        prior.pid,
                    );
                }
            }
            if (prior.pid === pid ? prior.processIdentity === identity : priorIdentity === prior.processIdentity) {
                throw new ServerLockError(
                    'SERVER_LOCK_ACTIVE',
                    `Another Dream Maker process owns this data directory (pid ${prior.pid}, start identity ${prior.processIdentity}).`,
                    prior.pid,
                );
            }
            archiveStale(path, prior, now);
        }

        const record: ServerLockRecord = {
            schema: SCHEMA,
            pid,
            processIdentity: identity,
            acquiredAt: now.toISOString(),
            host: options.host ?? hostname(),
            dataDir: options.dataDir ?? dirname(path),
            nonce: options.nonce ?? randomUUID(),
        };
        try {
            writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        } catch (error) {
            throw new ServerLockError(
                'SERVER_LOCK_WRITE_FAILED',
                `Cannot create server.lock: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        return {
            path,
            record,
            release: () => releaseServerLock(path, record.nonce, record.pid, record.processIdentity),
        };
    } finally {
        rmdirSync(guard);
    }
}

export function releaseServerLock(
    path: string,
    nonce: string,
    pid = process.pid,
    processIdentity?: string,
): boolean {
    if (!existsSync(path))
        return false;
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return false;
    }
    if (!isValidRecord(parsed)
        || parsed.nonce !== nonce
        || parsed.pid !== pid
        || (processIdentity !== undefined && parsed.processIdentity !== processIdentity))
        return false;
    unlinkSync(path);
    return true;
}
