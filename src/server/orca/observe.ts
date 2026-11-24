import { DomainError } from '../security.js';
import { normalizeWorkerState, type WorkerLifecycle } from './adapter.js';
import { ORCA_COMMANDS, parseWorkerRead, parseWorkerRows, runOrca, type OrcaExec } from './cli.js';

/**
 * A09: one bounded observation pass over a run's workers.
 *
 * This is deliberately a *reader*: it lists workers, optionally pulls a bounded number of log pages,
 * and returns a normalised snapshot. It never dispatches, approves, stops or releases anything, and a
 * transport failure becomes a reported code rather than an exception the caller might retry blindly.
 *
 * Loop safety (the traps from the audited contract):
 *  - pages are bounded per pass, so a chatty worker cannot make one poll run forever;
 *  - a changed log source stops the pass instead of splicing two streams;
 *  - `worker_done` stays REPORT_PENDING_VERIFICATION — the Engine, not this module, decides anything.
 */
export interface WorkerObservationSummary {
    dispatchId: string;
    lifecycle: WorkerLifecycle;
    rawStatus: string;
}

export interface ObservationPass {
    ok: boolean;
    workers: WorkerObservationSummary[];
    pagesRead: number;
    /** Set when the pass stopped early; the pass never silently continues past these. */
    stopped?: 'CURSOR_SOURCE_CHANGED' | 'PAGE_LIMIT';
    errorCode?: string;
}

export function createOrcaWorkerObserver(input: {
    exec: OrcaExec;
    binary: string;
    runId: string;
    maxPages?: number;
    timeoutMs?: number;
}): { poll(): Promise<ObservationPass> } {
    const maxPages = input.maxPages ?? 3;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20)
        throw new DomainError('ORCA_PAGE_LIMIT_INVALID', 409, '分页上限必须在 1..20。');
    return {
        async poll() {
            try {
                const listJson = await runOrca({
                    binary: input.binary,
                    subcommand: ORCA_COMMANDS.workerList,
                    ids: { '--run': input.runId },
                    exec: input.exec,
                    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
                });
                const rows = parseWorkerRows(listJson);
                const workers = rows.map(row => ({ dispatchId: row.dispatchId, lifecycle: row.lifecycle, rawStatus: row.rawStatus }));

                // Read a bounded number of pages across the workers of this run, with one cursor per
                // source: the loop stops the moment the source changes.
                let pagesRead = 0;
                let cursor: { source: string; value: string } | undefined;
                for (const row of rows) {
                    if (pagesRead >= maxPages) return { ok: true, workers, pagesRead, stopped: 'PAGE_LIMIT' };
                    const readJson = await runOrca({
                        binary: input.binary,
                        subcommand: ORCA_COMMANDS.workerRead,
                        ids: { '--dispatch': row.dispatchId },
                        exec: input.exec,
                        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
                    });
                    const read = parseWorkerRead(readJson);
                    if (cursor !== undefined && read.cursor.source !== cursor.source)
                        return { ok: true, workers, pagesRead, stopped: 'CURSOR_SOURCE_CHANGED' };
                    cursor = read.cursor;
                    pagesRead += 1;
                }
                return { ok: true, workers, pagesRead };
            }
            catch (error) {
                // Observation failures are reported, never thrown into a caller that might retry blindly.
                return { ok: false, workers: [], pagesRead: 0, errorCode: (error as { code?: string }).code ?? 'ORCA_OBSERVE_FAILED' };
            }
        }
    };
}

export { normalizeWorkerState };
