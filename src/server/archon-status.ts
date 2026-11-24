import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export type ArchonStatus = 'ARCHON_NATIVE_BOUND' | 'ARCHON_NATIVE_UNVERIFIED';
export interface ArchonBindingStatus {
    status: ArchonStatus;
    /** Why it is bound, or the first reason it is not. Always a concrete fact, never a label alone. */
    reason: string;
    hostScript?: { path: string; sha256: string | null; bound: boolean };
    hostModule?: { path: string; sha256: string | null; bound: boolean };
    audit?: { status: string; expiresAt: string; expired: boolean };
}
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
/**
 * Is the native Archon binding actually installed, or not?
 *
 * The diagnostics surface and scripts/doctor.mjs used to answer with a hardcoded string
 * 'ARCHON_NATIVE_UNVERIFIED' written when nothing native was wired. By 2026-10-30 every Live run went
 * through Archon (vendor/archon/dsh-node-host.mjs -> NodeHostHarness -> the DSH SDK) and two deliveries had
 * been produced, so the doctor was reporting a failure that had not been true for days. This answers from
 * the binding itself: the host script and host module named by the operator template must exist, their bytes
 * must match what the native audit recorded, and the audit must be LIVE_READY and unexpired.
 */
export function archonBindingStatus(operatorPath: string, auditPath: string): ArchonBindingStatus {
    const unverified = (reason: string, detail: Omit<ArchonBindingStatus, 'status' | 'reason'> = {}): ArchonBindingStatus => ({ status: 'ARCHON_NATIVE_UNVERIFIED', reason, ...detail });
    if (!existsSync(operatorPath)) return unverified('operator binding absent: ' + operatorPath);
    let operator: { template?: { path?: string } };
    try { operator = JSON.parse(readFileSync(operatorPath, 'utf8')); } catch { return unverified('operator binding unreadable'); }
    const templatePath = operator.template?.path;
    if (typeof templatePath !== 'string' || !existsSync(templatePath)) return unverified('template path missing or unreadable');
    let template: { hostScript?: string; hostModule?: string };
    try { template = JSON.parse(readFileSync(templatePath, 'utf8')); } catch { return unverified('template unreadable'); }
    if (!existsSync(auditPath)) return unverified('native audit absent');
    let audit: { status?: string; expiresAt?: string; evidenceFiles?: { path?: string; sha256?: string }[] };
    try { audit = JSON.parse(readFileSync(auditPath, 'utf8')); } catch { return unverified('native audit unreadable'); }
    const recorded = (path: string) => (audit.evidenceFiles ?? []).find(f => f?.path === path)?.sha256 ?? null;
    const inspect = (path: string | undefined) => {
        if (typeof path !== 'string' || !existsSync(path)) return undefined;
        const actual = sha256(readFileSync(path));
        return { path, sha256: actual, bound: recorded(path) === actual };
    };
    const hostScript = inspect(template.hostScript), hostModule = inspect(template.hostModule);
    const expiresAt = String(audit.expiresAt ?? '');
    const expired = !(Date.parse(expiresAt) > Date.now());
    const detail = { hostScript, hostModule, audit: { status: String(audit.status ?? ''), expiresAt, expired } };
    if (!hostScript) return unverified('template names no readable host script', detail);
    if (!hostModule) return unverified('template names no readable host module', detail);
    if (!hostScript.bound) return unverified('host script is not the file the audit recorded', detail);
    if (!hostModule.bound) return unverified('host module is not the file the audit recorded', detail);
    if (String(audit.status ?? '') !== 'LIVE_READY') return unverified('native audit is not LIVE_READY', detail);
    if (expired) return unverified('native audit expired at ' + expiresAt, detail);
    return { status: 'ARCHON_NATIVE_BOUND', reason: 'host script and module match the LIVE_READY audit', ...detail };
}
