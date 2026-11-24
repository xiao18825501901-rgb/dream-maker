import { DomainError } from './security.js';

/**
 * K07: map a Windows workspace onto a path the Linux side of the Codex transport can see.
 *
 * The copy itself (freezing the source tree into the distro) is a separate step that needs a running
 * distro; this module only decides *where* it lands and refuses anything ambiguous, so a Windows
 * path can never be handed to a Linux process by accident.
 */
export interface WslWorkspaceMapping {
    /** Absolute POSIX path inside the distro, e.g. /opt/dream-maker-controller/work/run-abc */
    linuxPath: string;
    /** Relative segment below the configured root, e.g. run-abc */
    relative: string;
}

const SAFE_SEGMENT = /^(?!\.$)(?!\.\.$)[A-Za-z0-9._-]+$/;

function assertSafeRoot(rawRoot: string): void {
    // Normalise a trailing slash before validating, so "/opt/x/" is accepted while "/opt//x" is not.
    const root = rawRoot.replace(/\/+$/, '');
    if (!root.startsWith('/') || root.length > 400)
        throw new DomainError('WSL_ROOT_INVALID', 409, 'WSL 根目录必须是绝对 POSIX 路径。');
    for (const segment of root.slice(1).split('/'))
        if (!SAFE_SEGMENT.test(segment))
            throw new DomainError('WSL_ROOT_INVALID', 409, 'WSL 根目录包含不安全片段。');
}

/**
 * A run id is used as the directory name, so it is validated as one safe segment instead of being
 * sanitised: silently rewriting an id would make the mapping disagree with the evidence log.
 */
export function mapWorkspaceToWsl(input: { wslRoot: string; runId: string }): WslWorkspaceMapping {
    assertSafeRoot(input.wslRoot);
    const normalizedRoot = input.wslRoot.replace(/\/+$/, '');
    const runId = input.runId ?? '';
    if (!SAFE_SEGMENT.test(runId) || runId.length > 80)
        throw new DomainError('WSL_RUN_ID_INVALID', 409, '运行 id 必须是单个安全路径片段。');
    return { linuxPath: normalizedRoot + '/' + runId, relative: runId };
}
