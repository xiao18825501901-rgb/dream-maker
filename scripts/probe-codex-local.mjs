// Real installed app-server handshake. No thread or model turn, login, or credential copy.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep, dirname, isAbsolute } from 'node:path';
import { RpcPeer } from '../dist/server/providers/rpc.js';
import { childEnv, within } from '../dist/server/security.js';

const [cliEntry, home, output, mode] = process.argv.slice(2);
if (![cliEntry, home, output].every(p => typeof p === 'string' && isAbsolute(p))) throw Error('EXPLICIT_ABSOLUTE_CLI_HOME_OUTPUT_REQUIRED');
const controller = resolve('..', 'work/controller');
within(controller, relative(controller, home).split(sep).join('/'));
mkdirSync(home, { recursive: true });
const peer = new RpcPeer(process.execPath, [cliEntry, 'app-server'], { cwd: process.cwd(), env: childEnv({ CODEX_HOME: home }) }, 15000);
const report = { schema: 'dream-maker.codex-local-probe.v1', recordedAt: new Date().toISOString(), cliEntry, home, evidenceClass: 'REAL_LOCAL_PROTOCOL_NO_MODEL_TURN', modelTurnsRequested: 0, nativeCanary: 'NOT_RUN', layaOffAccessCounter: 'NOT_RUN', results: [] };
try {
    const initialized = await peer.request('initialize', { clientInfo: { name: 'dream_maker_probe', version: '0.1.0' } });
    report.results.push({ method: 'initialize', status: 'PASS', userAgent: initialized.userAgent ?? null });
    peer.notify('initialized', {});
    const account = await peer.request('account/read', { refreshToken: false });
    report.results.push({ method: 'account/read', status: 'PASS', accountPresent: account.account != null, authenticationRequired: account.requiresOpenaiAuth ?? null });
    const config = await peer.request('config/read', { includeLayers: false });
    report.results.push({ method: 'config/read', status: 'PASS', sandboxMode: config.config?.sandbox_mode ?? null, configuredMcpServers: Object.keys(config.config?.mcp_servers ?? {}) });
    if (mode === '--sandbox-metadata') {
        const sandbox = await peer.request('windowsSandbox/readiness', {});
        report.results.push({ method: 'windowsSandbox/readiness', status: 'PASS', readiness: sandbox.status });
    }
    if (mode === '--model-metadata') {
        const models = await peer.request('model/list', { limit: 100, includeHidden: true });
        report.results.push({ method: 'model/list', status: 'PASS', models: models.data.map(m => ({ id: m.id, model: m.model, hidden: m.hidden, defaultReasoningEffort: m.defaultReasoningEffort })), more: models.nextCursor != null });
        const limits = await peer.request('account/rateLimits/read', {});
        const bucket = b => ({ limitId: b.limitId, normalModelSlug: b.normalModelSlug, primary: b.primary, secondary: b.secondary, planType: b.planType, spendControlReached: b.spendControlReached, rateLimitReachedType: b.rateLimitReachedType, hasCredits: b.credits?.hasCredits ?? null, unlimitedCredits: b.credits?.unlimited ?? null });
        report.results.push({ method: 'account/rateLimits/read', status: 'PASS', ordinaryUsageAllowed: limits.ordinaryUsageAllowed, rateLimits: bucket(limits.rateLimits), buckets: Object.values(limits.rateLimitsByLimitId ?? {}).map(bucket) });
    }
} catch (e) {
    report.results.push({ status: 'FAIL', code: e.code ?? 'LOCAL_PROBE_ERROR' });
    process.exitCode = 1;
} finally {
    await peer.close();
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ results: report.results, modelTurnsRequested: report.modelTurnsRequested, nativeCanary: report.nativeCanary }));
