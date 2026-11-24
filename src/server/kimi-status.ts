import type { KimiAdmission, KimiAdmissionSnapshot } from './kimi-admission.js';
import { expiresAtMs, type KimiCredentialAuthority, type BarrierState, type StoredCredentialState } from './kimi-credential-authority.js';

/**
 * Read-only Kimi status for the UI and for operators.
 *
 * Two rules:
 *  1. it never returns a token — not the access token, not the refresh token, not a prefix of one.
 *     The only credential facts exposed are the state name, the generation and whether it is usable;
 *  2. "authenticated" and "may run inference" are separate answers. A restored, unexpired credential
 *     still does not permit reasoning while Extra Usage is unproven.
 */
export interface KimiCredentialSummary {
    barrier: BarrierState;
    state: 'MISSING' | 'OK' | 'REVOKED' | 'CORRUPT';
    generation: number | null;
    /** Only for CORRUPT: a fixed reason code, never a message from the store. */
    reason: string | null;
    /** Present only for OK: when the token expires, so the UI can show "needs refresh soon". */
    expiresAt: number | null;
    /** Present only for OK: when the record was written (retires older observed failures). */
    savedAtMs: number | null;
}

export interface KimiStatus {
    admission: KimiAdmissionSnapshot | null;
    credentials: KimiCredentialSummary | null;
    /** True only when both the Extra Usage evidence AND the durable credential allow a send. */
    inferenceAllowed: boolean;
    note: string;
    /**
     * The last classified auth failure observed at runtime, if any. It exists because the durable
     * record can still read OK after the server refused us; without it the UI would keep claiming the
     * account works. Never contains a token or a raw provider message.
     */
    lastAuthFailure: { class: string; layer: string; code: string; atMs: number } | null;
}

function summarizeCredentials(state: StoredCredentialState, barrier: BarrierState): KimiCredentialSummary {
    switch (state.status) {
        case 'OK':
            return { barrier, state: 'OK', generation: state.generation, reason: null, expiresAt: expiresAtMs(state.token), savedAtMs: state.savedAtMs };
        case 'REVOKED':
            return { barrier, state: 'REVOKED', generation: state.generation, reason: null, expiresAt: null, savedAtMs: null };
        case 'CORRUPT':
            return { barrier, state: 'CORRUPT', generation: null, reason: state.reason, expiresAt: null, savedAtMs: null };
        default:
            return { barrier, state: 'MISSING', generation: null, reason: null, expiresAt: null, savedAtMs: null };
    }
}

export function kimiStatus(input: {
    admission?: Pick<KimiAdmission, 'snapshot'> | undefined;
    credentials?: Pick<KimiCredentialAuthority, 'barrier' | 'current'> | undefined;
    lastAuthFailure?: { class: string; layer: string; code: string; atMs: number } | null;
    now?: number;
}): KimiStatus {
    const now = input.now ?? Date.now();
    const admission = input.admission ? input.admission.snapshot(now) : null;
    const credentials = input.credentials
        ? summarizeCredentials(input.credentials.current(), input.credentials.barrier())
        : null;
    // The barrier is part of the permission, not a separate display field: a credential that has not
    // finished RESTORE must never read as "allowed", even if the state it shows is OK.
    const credentialOk = credentials !== null
        && credentials.state === 'OK'
        && credentials.generation !== null
        && credentials.barrier === 'READY';
    const credentialBlocked = credentials !== null && (credentials.state === 'CORRUPT' || credentials.state === 'REVOKED');
    const inferenceAllowed = admission?.allowsSend === true && credentialOk && !credentialBlocked;
    let note = 'OK';
    if (admission === null) note = 'NO_ADMISSION_AUTHORITY';
    else if (admission.allowsSend !== true) note = admission.reason;
    else if (credentials === null) note = 'NO_CREDENTIAL_AUTHORITY';
    else if (credentials.state === 'CORRUPT') note = 'KIMI_STORED_STATE_CORRUPT';
    else if (credentials.state === 'REVOKED') note = 'KIMI_CREDENTIAL_REVOKED';
    else if (credentials.state === 'MISSING') note = 'KIMI_CREDENTIALS_MISSING';
    else if (credentials.barrier !== 'READY') note = 'KIMI_RESTORE_NOT_READY';
    // A proven rejection on the authorisation layer outranks "OK": the credential may still be on
    // disk, but the server already refused it. Anything less certain keeps its own class and does not
    // change the wording — an unproven failure must never read as a verdict.
    // A failure observed BEFORE the current record was written is superseded by that newer login:
    // it must not keep the status red while the owner has already re-authorised.
    const observed = input.lastAuthFailure ?? null;
    const lastAuthFailure = observed !== null && credentials?.savedAtMs != null && observed.atMs < credentials.savedAtMs ? null : observed;
    if (note === 'OK' && lastAuthFailure !== null && lastAuthFailure.class === 'REAUTH_REQUIRED' && lastAuthFailure.layer === 'L3_OAUTH')
        note = 'KIMI_GRANT_REJECTED_AT_RUNTIME';
    return { admission, credentials, inferenceAllowed, note, lastAuthFailure };
}