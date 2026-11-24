// Read-only diagnostics; no model call, installation or configuration rewrite.
import { existsSync, readFileSync } from 'node:fs';
import { resolve, delimiter, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = { schema: 'dream-maker.doctor.v1', checkedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, sqlite: false }, changesMade: false, cloudCalls: 0 };
try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('select 1');
    db.close();
    output.runtime.sqlite = true;
}
catch (e) {
    output.runtime.error = String(e.message);
}
if (!process.argv.includes('--runtime-only')) {
    const { Settings } = await import('../dist/server/config.js'), { nativeReadiness } = await import('../dist/server/providers/dsh.js');
    try {
        const settings = new Settings(resolve(process.env.DM_CONFIG || resolve(root, 'config/local.json')));
        const c = settings.value;
        const locate = name => { if (isAbsolute(name))
            return existsSync(name) ? name : null; for (const dir of (process.env.PATH || process.env.Path || '').split(delimiter))
            for (const ext of process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']) {
                const file = resolve(dir, name + ext);
                if (existsSync(file))
                    return file;
            } return null; };
        output.configuration = { path: settings.path, exists: existsSync(settings.path), planner1Model: c.planner1.model || null, planner1KeyPresent: !!process.env[c.planner1.keyEnv], executorKeyPresent: !!process.env[c.dsh.keyEnv], codexCommandLocated: locate(c.codex.command), codexCommandInvoked: false, codexHomeExists: !!c.codex.home && existsSync(c.codex.home), dshModuleExists: !!c.dsh.modulePath && existsSync(c.dsh.modulePath), layaMode: c.laya.mode };
        output.native = nativeReadiness(c);
        // This used to be the constant 'ARCHON_NATIVE_UNVERIFIED', written when nothing native was wired. Every
        // Live run since goes through Archon, so the doctor was reporting a failure that had not been true for
        // days. The answer now comes from the binding: the template's host script and module must be the bytes
        // the native audit recorded, and that audit must be LIVE_READY and unexpired.
        const { archonBindingStatus } = await import('../dist/server/archon-status.js');
        const archon = archonBindingStatus(resolve(root, 'config/native-owner.local.json'), resolve(root, '.runtime/native-audit.json'));
        output.archon = archon.status;
        output.archonBinding = archon;
        if (process.argv.includes('--probe-laya')) {
            const { LayaBridge } = await import('../dist/server/laya.js');
            try {
                output.laya = await new LayaBridge(() => c).probe();
            }
            catch (e) {
                output.laya = { status: 'UNAVAILABLE', reason: String(e.code || e.message) };
            }
        }
        else
            output.laya = { status: 'NOT_PROBED', hint: 'Use --probe-laya only to explicitly read local /health and /info.' };
    }
    catch (e) {
        output.configuration = { error: String(e.code || e.message) };
    }
}
console.log(JSON.stringify(output, null, 2));
if (!output.runtime.sqlite)
    process.exitCode = 1;
