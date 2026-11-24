import { DomainError } from './security.js';

/**
 * Controller-side Laya decisions. Native hidden hooks require their own real audit.
 *
 * The rule this encodes (from the task contract): an initialisation probe with zero requests is NOT
 * proof that Laya was off for the run, and neither is the UI switch alone. Proof means every role
 * dispatch produced an OFF decision. A Demo turn or this summary alone cannot attest native hooks.
 *
 * Pure bookkeeping so it can be tested without a model call, a bridge or a browser.
 */
export interface LayaTurnRecord {
    role: string;
    mode: string;
    adoption: string;
    /** Advice supplied to a completed identity-verified role, not a claim of model causality. */
    applied?:boolean;
    runMode?:'demo'|'live';
}

export interface LayaObservationSummary {
    turns: number;
    byRole: Record<string, number>;
    byMode: Record<string, number>;
    byAdoption: Record<string, number>;
    /** Historical field name: advice supplied to a completed role; not causal model influence. */
    influencedTurns: number;
    receivedAdviceTurns:number;
    evidenceClass:'CONTROLLER_DECISIONS_NOT_NATIVE_HOOKS';
    /** The only claim worth making: every observed turn was off and uninfluenced. */
    fullyOff: boolean;
    reason: string;
}

export interface LayaObserver {
    record(turn: LayaTurnRecord): void;
    summary(): LayaObservationSummary;
}

export function createLayaObserver(): LayaObserver {
    const turns: LayaTurnRecord[] = [];
    return {
        record(turn) {
            if (!turn || typeof turn.role !== 'string' || turn.role.length === 0) return;
            turns.push({ role: turn.role, mode: String(turn.mode ?? ''), adoption: String(turn.adoption ?? ''),applied:turn.applied===true&&turn.runMode==='live',runMode:turn.runMode });
        },
        summary() {
            const byRole: Record<string, number> = {}, byMode: Record<string, number> = {}, byAdoption: Record<string, number> = {};
            let influencedTurns = 0,receivedAdviceTurns=0;
            for (const turn of turns) {
                byRole[turn.role] = (byRole[turn.role] ?? 0) + 1;
                byMode[turn.mode] = (byMode[turn.mode] ?? 0) + 1;
                byAdoption[turn.adoption] = (byAdoption[turn.adoption] ?? 0) + 1;
                if (turn.adoption==='advisory'){receivedAdviceTurns++;if(turn.applied===true)influencedTurns++;}
            }
            const modes = Object.keys(byMode);
            const allOff = modes.length > 0 && modes.every(m => m === 'off');
            let reason = 'OK';
            let fullyOff = false;
            if (turns.length === 0) reason = 'NO_TURNS_OBSERVED';
            else if (!allOff) reason = 'MODE_NOT_OFF';
            else if (influencedTurns > 0||receivedAdviceTurns>0) reason = 'INFLUENCED_TURNS_PRESENT';
            else { fullyOff = true; }
            return { turns: turns.length, byRole, byMode, byAdoption, influencedTurns,receivedAdviceTurns,evidenceClass:'CONTROLLER_DECISIONS_NOT_NATIVE_HOOKS', fullyOff, reason };
        }
    };
}

/** Only a summary that observed real, uninfluenced turns in off mode may be reported as "Laya OFF". */
export function assertLayaOffForAllTurns(summary: LayaObservationSummary): void {
    if (summary.fullyOff) return;
    const detail = summary.reason === 'NO_TURNS_OBSERVED'
        ? '没有任何真实回合被观测；初始化/零请求不能证明 Laya 处于关闭。'
        : summary.reason === 'MODE_NOT_OFF'
            ? '观测到非 off 模式的回合；不能声称 Laya 全程关闭。'
            : '观测到 Laya 影响过回合；不能声称 Laya 全程关闭。';
    throw new DomainError('LAYA_OFF_NOT_PROVEN', 409, detail);
}
