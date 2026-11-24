// Real SDK start/initialize/close only: no session/prompt/tool or paid model request.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { childEnv, within } from '../dist/server/security.js';
import { readJson } from './lib/local-inventory.mjs';

const [scopePath, output] = process.argv.slice(2);
if (!scopePath || !output || !isAbsolute(output)) throw Error('EXPLICIT_SCOPE_AND_ABSOLUTE_OUTPUT_REQUIRED');
const c = readJson(scopePath);
for (const key of ['sdkEntry', 'dshBin', 'dshHome', 'workspace']) {
    if (typeof c[key] !== 'string' || !isAbsolute(c[key])) throw Error('ABSOLUTE_DSH_PATH_REQUIRED');
}
for (const path of [c.dshHome, c.workspace])
    within(resolve('.runtime'), relative(resolve('.runtime'), path).split(sep).join('/'));
if (typeof c.model !== 'string' || !c.model || c.profile !== 'sdk') throw Error('EXPLICIT_MODEL_AND_STOCK_SDK_PROFILE_REQUIRED');
mkdirSync(c.dshHome, { recursive: true });
mkdirSync(c.workspace, { recursive: true });
const report = { schema: 'dream-maker.dsh-local-probe.v1', recordedAt: new Date().toISOString(), sdkEntry: c.sdkEntry, dshBin: c.dshBin, dshHome: c.dshHome, workspace: c.workspace, evidenceClass: 'REAL_SDK_INITIALIZE_NO_MODEL_TURN', requestedModel: c.model, modelRouteVerified: false, modelTurnsRequested: 0, toolExecutionsRequested: 0, layaOffHiddenHooks: 'NOT_RUN', status: 'NOT_RUN', ownedClose: 'NOT_RUN' };
let client;
try {
    const { HarnessClient } = await import(pathToFileURL(c.sdkEntry).href);
    if (typeof HarnessClient !== 'function') throw Error('SDK_EXPORT_MISMATCH');
    client = new HarnessClient({ dshBin: c.dshBin, dshHome: c.dshHome, profile: 'sdk', patches: [], processCwd: c.workspace, env: childEnv({ SHENLIN_LAYA_ENABLED: 'false' }), initializeTimeoutMs: 15000, requestTimeoutMs: 15000, shutdownTimeoutMs: 1000 });
    client.start();
    const initialized = await client.initialize({ cwd: c.workspace, provider: 'deepseek-official', model: c.model, maxTokens: 128 });
    report.serverInfo = initialized.serverInfo;
    report.status = initialized.serverInfo?.name === 'deepseek-harness-sdk-runtime' ? 'PASS' : 'FAIL';
    if (report.status !== 'PASS') process.exitCode = 1;
} catch (e) {
    report.status = 'FAIL';
    report.errorCode = e.code ?? e.name ?? 'SDK_INITIALIZE_ERROR';
    process.exitCode = 1;
} finally {
    try { if (client) { await client.close(); report.ownedClose = 'SDK_CLOSE_RESOLVED_NOT_JOB_OBJECT_PROOF'; } else report.ownedClose = 'NOT_STARTED'; }
    catch { report.ownedClose = 'FAIL'; process.exitCode = 1; }
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ status: report.status, serverInfo: report.serverInfo, errorCode: report.errorCode, modelRouteVerified: report.modelRouteVerified, modelTurnsRequested: 0, ownedClose: report.ownedClose }));
