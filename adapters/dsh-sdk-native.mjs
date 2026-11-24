/** Source-verified reference binding. Requires user's installed SDK and audited isolated profile.
 * This does NOT install, rewrite, or migrate Shenlin. Live remains gated until local audit.
 * SDK README blob: 4757f2742cfafcbf3e16137ca0e1b585b63ecdb9
 * SDK types blob: 9e91eb103603ceef835708dacda9a60a10afb5db
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let active;
function options() { const c = JSON.parse(readFileSync(resolve(root, 'config/dsh-native.local.json'), 'utf8')); for (const k of ['sdkEntry', 'dshHome', 'dshBin'])
    if (typeof c[k] !== 'string' || !isAbsolute(c[k]))
        throw Error('ABSOLUTE_NATIVE_PATH_REQUIRED:' + k); return c; }
export async function capabilities() { return { binding: 'official-sdk-reference', verified: false, cancel: 'close-owned-runtime', usage: 'not-normalized', verifier: 'operator-module-required' }; }
export async function run(input, emit, signal) {
    const c = options(), { DeepSeekHarness } = await import(pathToFileURL(c.sdkEntry).href);
    if (typeof DeepSeekHarness !== 'function')
        throw Error('SDK_EXPORT_MISMATCH');
    const harness = new DeepSeekHarness({ dshBin: c.dshBin, profile: c.profile ?? 'sdk', patches: c.patches ?? [], dshHome: c.dshHome, processCwd: input.workspace, cwd: input.workspace, provider: 'deepseek-official', model: input.model, maxTokens: c.maxTokens ?? 8192, initializeTimeoutMs: 15000, requestTimeoutMs: 120000, shutdownTimeoutMs: 1000, env: { ...process.env } });
    active = harness;
    const abort = () => { void harness.close().catch(() => { }); };
    signal.addEventListener('abort', abort, { once: true });
    try {
        if (signal.aborted)
            throw Error('CANCELLED');
        const result = await harness.run(input.prompt, { onNotification: emit });
        if (signal.aborted)
            throw Error('CANCELLED');
        return { text: result.finalResponse, sessionId: result.sessionId };
    }
    finally {
        signal.removeEventListener('abort', abort);
        await harness.close();
        active = undefined;
    }
}
export async function verify(input, emit, signal) {
    const c = options();
    if (!c.verifierModule || !isAbsolute(c.verifierModule))
        throw Error('NATIVE_SANDBOX_VERIFIER_REQUIRED');
    const verifier = await import(pathToFileURL(c.verifierModule).href);
    // The operator's verifier must run in the SAME audited OS isolation, not raw host shell.
    if (typeof verifier.verify !== 'function')
        throw Error('VERIFIER_EXPORT_MISMATCH');
    return verifier.verify(input, emit, signal);
}
export async function close() { await active?.close(); }
