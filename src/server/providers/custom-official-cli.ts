import {mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {basename, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {capture} from '../process.js';
import {readComponentJson} from '../release/local-component.js';
import {childEnv, DomainError, hash, object} from '../security.js';
import {verifiedClaudeCommand, launchClaudeSupervisor, validOfficialCliModelId, type ClaudeCommandRef, type ClaudeSupervisorResult} from './claude-supervisor.js';
import {startOfficialCliMessagesTransport} from './custom-official-cli-messages-transport.js';
import {startOfficialCliTransport} from './custom-official-cli-transport.js';

export interface CustomOfficialCliInput {
    runtime: 'claude' | 'opencode' | 'cline';
    role: 'planner2' | 'reviewer';
    commandRef: ClaudeCommandRef;
    controllerRoot: string;
    gatewayUrl: string;
    gatewayToken: string;
    model: string;
    prompt: string;
    signal: AbortSignal;
    timeoutMs: number;
    maxOutputTokens?: number;
    assertCurrent(): void;
    receipts(): readonly unknown[];
    /** Declared wire of the frozen route. Absent keeps the shipped chat bridge and config. */
    wire?: OfficialCliWire;
}
type OfficialCliWire = 'chat-completions' | 'anthropic-messages';
const deny = (): never => {throw new DomainError('CUSTOM_OFFICIAL_CLI_UNVERIFIED', 409);};
const provider = 'openai-compatible';
// Cline names its native Anthropic transport after that provider id, so it is also the client.
const messagesProvider = 'anthropic';
const disabledTools = ('read_files search_codebase run_commands fetch_web_content ask_question spawn_agent team_spawn_teammate team_shutdown_teammate team_status team_task team_run_task team_cancel_run team_list_runs team_await_runs team_send_message team_broadcast team_read_mailbox team_mission_log team_cleanup team_create_outcome team_attach_outcome_fragment team_review_outcome_fragment team_finalize_outcome team_list_outcomes').split(' ');

function checkCurrent(input: CustomOfficialCliInput) {
    input.signal.throwIfAborted();
    const result: unknown = input.assertCurrent();
    if (result instanceof Promise) void result.catch(() => {});
    if (result !== undefined) deny();
}

export function bindOfficialCliReceipt(input: CustomOfficialCliInput, sessionId: string, text: string, responseId?: string): ClaudeSupervisorResult {
    checkCurrent(input);
    const receipts = input.receipts();
    if (receipts.length !== 1) return deny();
    const row = object(receipts[0]);
    if (!sessionId || !text.trim() || typeof row.id !== 'string' || !row.id || row.outcome !== 'COMPLETE' || row.completionObserved !== true || row.responseModelMatched !== true ||
        row.requestedModel !== input.model || row.observedModel !== input.model || typeof row.responseId !== 'string' || !row.responseId ||
        (responseId !== undefined && row.responseId !== responseId) || !['stop','end_turn'].includes(String(row.finishReason)) ||
        typeof row.responseSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.responseSha256) || row.outputTextHash !== hash(text.trim())) return deny();
    const usage = row.usage == null ? {} : object(row.usage);
    const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
    return {text, model: input.model, sessionId, requestId: row.id, inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens), costUsd: null};
}

function events(stdout: string) {
    return stdout.trim().split(/\r?\n/).map(line => object(JSON.parse(line)));
}

// Native IDs are opaque. Bind the repeated fields across frames and use a filename-safe
// subset when reading a Cline manifest. Do not infer identity from timestamps or prefixes.
function nativeId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 160 &&
        /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9._-]/.test(value) && !value.endsWith('.');
}

export function openCodeResult(stdout: string) {
    const rows = events(stdout);
    const sessionId = rows[0]?.sessionID;
    if (!nativeId(sessionId) || rows.length < 3 || rows[0].type !== 'step_start' || rows.at(-1)?.type !== 'step_finish') return deny();
    const messageID = object(rows[0].part).messageID;
    if (!nativeId(messageID)) return deny();
    let text = '';
    for (const [index,row] of rows.entries()) {
        const part = object(row.part);
        if (row.sessionID !== sessionId || part.sessionID !== sessionId || part.messageID !== messageID) return deny();
        if (index === 0 && part.type === 'step-start') continue;
        if (index === rows.length-1 && part.type === 'step-finish' && part.reason === 'stop') continue;
        if (row.type !== 'text' || part.type !== 'text' || typeof part.text !== 'string') return deny();
        text += part.text;
    }
    return {sessionId, text};
}

function clineResult(stdout: string, model: string, data: string, cwd: string, marker: string, expectedProvider: string) {
    const rows = events(stdout), start = rows[0], end = rows.at(-1);
    if (start.type !== 'run_start' || start.modelId !== model || start.providerId !== expectedProvider || start.mode !== 'plan' ||
        !end || end.type !== 'run_result' || end.finishReason !== 'completed' || end.iterations !== 1 || object(end.model).id !== model || object(end.model).provider !== expectedProvider || typeof end.text !== 'string') return deny();
    const hooks = rows.filter(r => r.type === 'hook_event');
    if (hooks.length !== 2 || hooks[0].hookEventName !== 'agent_start' || hooks[1].hookEventName !== 'agent_end' ||
        typeof hooks[0].taskId !== 'string' || !hooks[0].taskId || hooks[0].taskId !== hooks[1].taskId || !hooks[0].agentId || hooks[0].agentId !== hooks[1].agentId || hooks.some(h => h.parentAgentId !== null)) return deny();
    const middle = rows.slice(1,-1).filter(r => r.type !== 'hook_event').map(row => {
        if (row.type !== 'agent_event') return deny();
        return object(row.event);
    });
    const allowed = ['iteration_start','content_start','content_delta','content_end','usage','iteration_end','done'];
    if (middle.some(e => !allowed.includes(String(e.type))) || middle.filter(e => e.type === 'iteration_end' && e.hadToolCalls === false && e.toolCallCount === 0).length !== 1 || middle.at(-1)?.type !== 'done' || middle.at(-1)?.text !== end.text) return deny();
    const sessionId = clineSessionId(data, model, cwd, marker, expectedProvider);
    return {sessionId, text:end.text};
}

export function clineSessionId(data: string, model: string, cwd: string, marker: string, expectedProvider: string = provider): string {
    const sessions = join(data,'sessions'), entries = readdirSync(sessions,{withFileTypes:true});
    if (entries.some(entry => entry.isSymbolicLink())) return deny();
    const dirs = entries.filter(entry => entry.isDirectory());
    if (dirs.length !== 1 || !nativeId(dirs[0].name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|$)/i.test(dirs[0].name)) return deny();
    const sessionId = dirs[0].name;
    const manifest = join(sessions,sessionId,sessionId+'.json');
    const info = object(readComponentJson(manifest,65536));
    if (info.session_id !== sessionId || info.source !== 'cli' || info.status !== 'completed' || info.exit_code !== 0 || info.interactive !== false ||
        info.provider !== expectedProvider || info.model !== model || typeof info.cwd !== 'string' || resolve(info.cwd) !== cwd || typeof info.workspace_root !== 'string' || resolve(info.workspace_root) !== cwd || typeof info.prompt !== 'string' || info.prompt.trim() !== marker) return deny();
    return sessionId;
}

/** Native client configuration for one read-only turn. Chat keeps the shipped shape exactly. */
export function officialCliOpenCodeConfig(wire: OfficialCliWire, model: string, baseUrl: string, token: string, maxOutputTokens: number) {
    const npm = wire === 'anthropic-messages' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible';
    return {enabled_providers:['dm'],provider:{dm:{npm,name:'dm',options:{baseURL:baseUrl,apiKey:token},models:{[model]:{name:model,limit:{context:32000,output:maxOutputTokens}}}}},model:'dm/'+model,small_model:'dm/'+model,permission:{'*':'deny'},agent:{title:{disable:true},summary:{disable:true}},share:'disabled',autoupdate:false};
}

/** Native Messages needs Cline's anthropic provider; chat keeps the openai-compatible one. */
export function officialCliClineProvider(wire: OfficialCliWire): string {
    return wire === 'anthropic-messages' ? messagesProvider : provider;
}

export function officialCliClineProviders(wire: OfficialCliWire, model: string, baseUrl: string, token: string, maxOutputTokens: number) {
    const selected = officialCliClineProvider(wire);
    return {version:1,lastUsedProvider:selected,providers:{[selected]:{settings:{provider:selected,model,apiKey:token,baseUrl,protocol:wire==='anthropic-messages'?'anthropic':'openai-chat',client:selected,maxTokens:maxOutputTokens,catalog:{loadLatestOnInit:false,includeClineCloudModels:false,loadPrivateOnAuth:false}},updatedAt:new Date().toISOString(),tokenSource:'manual'}}};
}

export async function runCustomOfficialCli(input: CustomOfficialCliInput): Promise<ClaudeSupervisorResult> {
    const maxOutputTokens = input.maxOutputTokens ?? 2048;
    if (!['planner2','reviewer'].includes(input.role) || !['claude','cline','opencode'].includes(input.runtime) || !isAbsolute(input.controllerRoot) ||
        !validOfficialCliModelId(input.model) || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}(?:\/v1)?\/?$/.test(input.gatewayUrl) ||
        !/^[\x21-\x7e]{8,512}$/.test(input.gatewayToken) || typeof input.prompt !== 'string' || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 2_000_000 ||
        !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 16000 || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 900000) return deny();
    const wire = input.wire ?? 'chat-completions';
    if (wire !== 'chat-completions' && wire !== 'anthropic-messages') return deny();
    checkCurrent(input);
    if (input.receipts().length || basename(input.commandRef.path).toLowerCase() !== input.runtime + '.exe') return deny();
    const command = verifiedClaudeCommand(input.commandRef);
    const origin = new URL(input.gatewayUrl).origin;
    if (input.runtime === 'claude') {
        const observation = await launchClaudeSupervisor({...input, command, gatewayUrl: origin, maxOutputTokens});
        return bindOfficialCliReceipt(input,observation.sessionId,observation.text);
    }
    // Project terminals supply a suite-local TEMP outside the checkout. Keep discovery away from project files.
    const temp = resolve(tmpdir()), rel = relative(input.controllerRoot,temp);
    if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)) return deny();
    const home = mkdtempSync(join(temp,'dm-official-'+input.role+'-'));
    const cwd = join(home,'workspace'), data = join(home,'data'), config = join(home,'config');
    let bridge: Awaited<ReturnType<typeof startOfficialCliTransport>> | Awaited<ReturnType<typeof startOfficialCliMessagesTransport>> | undefined;
    try {
        for (const dir of [cwd, data, config, join(home,'tmp')]) mkdirSync(dir);
        bridge = wire === 'anthropic-messages'
            ? await startOfficialCliMessagesTransport({...input, maxOutputTokens, gatewayUrl:origin+'/v1', assertCurrent:()=>checkCurrent(input)})
            : await startOfficialCliTransport({...input, maxOutputTokens, gatewayUrl:origin+'/v1', assertCurrent:()=>checkCurrent(input)});
        const env = childEnv({HOME:home, USERPROFILE:home, APPDATA:config, LOCALAPPDATA:data, XDG_CONFIG_HOME:config, XDG_DATA_HOME:data,
            XDG_CACHE_HOME:join(home,'cache'), XDG_STATE_HOME:join(home,'state'), TMPDIR:join(home,'tmp'), DO_NOT_TRACK:'1',
            HTTPS_PROXY:'http://127.0.0.1:1', HTTP_PROXY:'http://127.0.0.1:1', ALL_PROXY:'http://127.0.0.1:1', NO_PROXY:'127.0.0.1,localhost'});
        delete env.Path;
        env.PATH = join(process.env.SystemRoot ?? 'C:/Windows','System32');
        let args: string[];
        if (input.runtime === 'opencode') {
            const model = 'dm/'+input.model;
            Object.assign(env,{OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_AUTOINSTALL:'true',OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_PROJECT_CONFIG:'true',OPENCODE_DISABLE_CLAUDE_CODE:'true',OPENCODE_DISABLE_SHARE:'true',
                OPENCODE_CONFIG_CONTENT:JSON.stringify(officialCliOpenCodeConfig(wire,input.model,bridge.url,bridge.token,maxOutputTokens))});
            args = ['run','--pure','--format','json','--model',model,'--title','DreamFlow',bridge.marker];
        } else {
            Object.assign(env,{CLINE_SESSION_BACKEND_MODE:'local',CLINE_DIR:config,CLINE_DATA_DIR:data});
            const settings = join(data,'settings'); mkdirSync(settings);
            writeFileSync(join(settings,'providers.json'),JSON.stringify(officialCliClineProviders(wire,input.model,bridge.url,bridge.token,maxOutputTokens)),{mode:0o600});
            writeFileSync(join(settings,'global-settings.json'),JSON.stringify({telemetryOptOut:true,autoUpdateEnabled:false,disabledTools,tools:{web_search:{enabled:false}}}));
            args = ['--json','--verbose','--plan','--auto-approve','false','--retries','1','--compaction','off','--provider',officialCliClineProvider(wire),'--model',input.model,'--config',config,'--data-dir',data,'--cwd',cwd,bridge.marker];
        }
        checkCurrent(input);
        let cleaned = false;
        const result = await capture(command,args,{cwd,env,windowsJobRoot:input.controllerRoot,signal:input.signal,timeoutMs:input.timeoutMs,maxBytes:4194304,onCleanup:()=>{cleaned=true;}});
        if (!cleaned || result.code !== 0 || !bridge.responseId()) return deny();
        const observed = input.runtime === 'opencode' ? openCodeResult(result.stdout) : clineResult(result.stdout,input.model,data,cwd,bridge.marker,officialCliClineProvider(wire));
        return bindOfficialCliReceipt(input,observed.sessionId,observed.text,bridge.responseId());
    } finally {
        try { await bridge?.close(); } finally { rmSync(home,{recursive:true,force:true,maxRetries:3}); }
    }
}
