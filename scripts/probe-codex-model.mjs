// Real subscription-backed minimal responses only. This is not source/sandbox acceptance.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep, dirname } from 'node:path';
import { RpcPeer } from '../dist/server/providers/rpc.js';
import { childEnv, within } from '../dist/server/security.js';

const [cliEntry, home, output] = process.argv.slice(2), controller = resolve('..', 'work/controller');
if (!cliEntry || !home || !output) throw Error('EXPLICIT_CLI_HOME_OUTPUT_REQUIRED');
within(controller, relative(controller, home).split(sep).join('/'));
const model = 'gpt-6-sol', workspace = resolve('.runtime/codex-model-probe');
mkdirSync(workspace, { recursive: true });
const peer = new RpcPeer(process.execPath, [cliEntry, 'app-server'], { cwd: workspace, env: childEnv({ CODEX_HOME: home }) }, 15000);
const report = { schema: 'dream-maker.codex-model-probe.v1', recordedAt: new Date().toISOString(), cliEntry, home, model, provider: 'openai', authentication: 'CHATGPT_SUBSCRIPTION', evidenceClass: 'REAL_MINIMAL_MODEL_RESPONSES_NOT_PROJECT_ACCEPTANCE', paidApiFallback: false, sandboxCanary: 'NOT_RUN', results: [] };
let threadId = '', turnId = '', complete, reject, timer, response = '', usage = null, tools = 0;
try {
    await peer.request('initialize', { clientInfo: { name: 'dream_maker_model_probe', version: '0.1.0' } });
    peer.notify('initialized', {});
    const account = await peer.request('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt') throw Error('DEDICATED_CHATGPT_LOGIN_REQUIRED');
    const models = await peer.request('model/list', { limit: 100, includeHidden: true });
    if (!models.data.some(m => m.model === model)) throw Error('PREVIOUSLY_USED_MODEL_UNAVAILABLE');
    peer.onFailure = e => reject?.(e);
    peer.onNotification = (method, p) => {
        if (p.threadId && p.threadId !== threadId) return;
        if (method === 'item/started' && p.item && !['agentMessage', 'reasoning', 'userMessage'].includes(p.item.type)) {
            tools++;
            if (threadId && turnId) void peer.request('turn/interrupt', { threadId, turnId }).catch(() => {});
            reject?.(Error('UNEXPECTED_TOOL_REQUEST'));
        }
        if (method === 'item/completed' && p.item?.type === 'agentMessage') response = p.item.text;
        if (method === 'thread/tokenUsage/updated') usage = p.tokenUsage?.total ?? null;
        if (method === 'turn/completed') p.turn?.status === 'completed' ? complete?.() : reject?.(Error('MODEL_TURN_NOT_COMPLETED'));
    };
    for (const role of ['planner2', 'reviewer']) {
        const quota = await peer.request('account/rateLimits/read', {});
        if (quota.ordinaryUsageAllowed !== true || quota.rateLimits?.spendControlReached !== false ||
            quota.rateLimits?.credits?.hasCredits !== false || quota.rateLimits?.credits?.unlimited !== false)
            throw Error('INCLUDED_USAGE_OR_NO_PAID_CREDITS_UNPROVEN');
        response = ''; usage = null; tools = 0;
        const started = await peer.request('thread/start', { model, modelProvider: 'openai', cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', serviceTier: 'default', serviceName: 'dream_maker_model_probe', baseInstructions: 'This is one minimal connectivity check. Do not inspect files, run commands, use tools, or delegate. Reply with exactly DM_OK.', config: { features: { shell_tool: false }, web_search: 'disabled' } });
        threadId = started.thread?.id;
        if (!threadId || started.model !== model || started.modelProvider !== 'openai') throw Error('ACTUAL_MODEL_ROUTE_MISMATCH');
        const done = new Promise((yes, no) => { complete = yes; reject = no; });
        done.catch(() => {});
        timer = setTimeout(() => reject(Error('MINIMAL_MODEL_TIMEOUT')), 60000);
        const turn = await peer.request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with exactly DM_OK. Do not use tools.' }], model, effort: 'low', serviceTierForTurn: 'default', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
        turnId = turn.turn?.id;
        await done;
        clearTimeout(timer);
        if (response.trim() !== 'DM_OK' || tools) throw Error('MINIMAL_RESPONSE_INVALID');
        report.results.push({ role, status: 'PASS', actualModel: started.model, modelProvider: started.modelProvider, threadId, turnId, response, toolsObserved: tools, usage, includedUsageBefore: true });
    }
} catch (e) { report.results.push({ status: 'FAIL', code: e.code ?? e.message }); process.exitCode = 1; }
finally {
    clearTimeout(timer);
    if (threadId && turnId) await peer.request('turn/interrupt', { threadId, turnId }, 1000).catch(() => {});
    await peer.close();
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ results: report.results, evidenceClass: report.evidenceClass }));
