// Existing Archon host modules are imported, never copied. Live remains behind the controller audit.
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, sep, isAbsolute, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { childEnv, DomainError, hasSecret, hash, id, redact, within } from '../dist/server/security.js';
import { readJson } from '../scripts/lib/local-inventory.mjs';
import {assertNativeProfile,customProfileRoute,sdkProvider} from './dsh-native-profile.mjs';
import {dshTemplateBindingFiles} from '../dist/server/dsh-template-bindings.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function bound(path, audit) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new DomainError('ABSOLUTE_ARCHON_BINDING_REQUIRED');
    const expected = audit.evidenceFiles?.find(item => resolve(item.path) === resolve(path));
    if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new DomainError('ARCHON_BINDING_NOT_AUDITED');
    if (hash(readFileSync(path)) !== expected.sha256) throw new DomainError('ARCHON_BINDING_CHANGED');
}
function dispatchRoleBinding(value){
    const explicit=!!value&&(Object.hasOwn(value,'provider')||Object.hasOwn(value,'model'));
    if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==(explicit?5:3)||
        !['role','roleId','configurationHash'].every(k=>Object.hasOwn(value,k))||!['executor','planner2','reviewer'].includes(value.role)||
        typeof value.roleId!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value.roleId)||value.role!=='executor'&&value.roleId!==value.role||
        typeof value.configurationHash!=='string'||!/^[a-f0-9]{64}$/.test(value.configurationHash))throw new DomainError('NATIVE_DISPATCH_ROLE_INVALID',409);
    let route={};
    if(explicit){try{route=customProfileRoute(value.provider,value.model);}catch{throw new DomainError('NATIVE_DISPATCH_ROLE_INVALID',409);}}
    return{role:value.role,roleId:value.roleId,configurationHash:value.configurationHash,...route};
}

export function createArchonAdapter(c, audit, configurationPath) {
    let active, running = false;
    function bindings() {
        if (hasSecret(JSON.stringify(c))) throw new DomainError('SECRET_IN_NATIVE_CONFIG');
        if (!c.verifierModule) throw new DomainError('NATIVE_SANDBOX_VERIFIER_REQUIRED');
        for (const path of [c.dshHome, c.controlRoot]) {
            if (typeof path !== 'string' || !isAbsolute(path)) throw new DomainError('ABSOLUTE_ARCHON_BINDING_REQUIRED');
            within(resolve(root, '.runtime'), relative(resolve(root, '.runtime'), path).split(sep).join('/'));
        }
        if (c.profile !== 'sdk' || !Number.isSafeInteger(c.maxTokens) || c.maxTokens < 128 || c.maxTokens > 16000 || !Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 1800000)
            throw new DomainError('ARCHON_LAUNCH_LIMITS_INVALID');
        if (!Array.isArray(c.patches) || !Array.isArray(c.dependencyFiles)) throw new DomainError('ARCHON_BINDING_LIST_REQUIRED');
        const files = [...dshTemplateBindingFiles(c), ...(configurationPath ? [configurationPath] : [])];
        files.forEach(path => bound(path, audit));
    }
    const capabilities = async () => ({ binding: 'existing-archon-node-host-v1', owner: 'dream-maker-engine', verified: false, usage: 'UNKNOWN', verifier: 'audited-operator-module-required' });
    const close = async () => { await active?.close(); };
    function gatewayBinding(input) {
        const base=process.env.DM_MODEL_GATEWAY_URL,token=process.env.DM_MODEL_GATEWAY_TOKEN;
        const key=process.env[process.env.DM_DSH_KEY_ENV || 'DEEPSEEK_API_KEY'];
        if(!base||!token||!key)throw new DomainError('NATIVE_MODEL_GATEWAY_REQUIRED',409);
        try {
            const url=new URL(base);
            if(url.href!==base||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||
                url.username||url.password||url.search||url.hash||url.pathname!=='/v1'||token!==key||input.provider!==c.runBinding?.provider||input.model!==(c.runBinding?.model??'deepseek-flash'))
                throw Error('Invalid gateway scope');
        }catch{throw new DomainError('NATIVE_MODEL_GATEWAY_INVALID',409);}
        return {base,token};
    }
    function toolBinding(role){
        const url=process.env.DM_TOOL_PROXY_URL,token=process.env.DM_TOOL_PROXY_TOKEN,path=process.env.DM_DSH_TOOL_CLIENT_CONFIG,sha256=process.env.DM_DSH_TOOL_CLIENT_SHA256;
        if(!url||!token||!path||!sha256)throw new DomainError('NATIVE_TOOL_PROXY_REQUIRED',409);
        try{
            const target=new URL(url),bytes=readFileSync(path),config=JSON.parse(bytes);
            if((config.role??'executor')!==role)throw new DomainError('NATIVE_TOOL_ROLE_MISMATCH',409);
            if(target.href!==url||target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!target.port||target.pathname!=='/tools'||target.username||target.password||target.search||target.hash||
                !isAbsolute(path)||hash(bytes)!==sha256||config.schema!=='dream-maker.dsh-tool-client.v1'||config.toolUrl!==url||config.provider!==c.runBinding?.provider||config.model!==c.runBinding?.model)throw Error('Invalid tool binding');
        }catch(error){if(error instanceof DomainError&&error.code==='NATIVE_TOOL_ROLE_MISMATCH')throw error;throw new DomainError('NATIVE_TOOL_PROXY_BINDING_INVALID',409);}
        return {DM_TOOL_PROXY_URL:url,DM_TOOL_PROXY_TOKEN:token,DM_DSH_TOOL_CLIENT_CONFIG:path,DM_DSH_TOOL_CLIENT_SHA256:sha256};
    }
    function profileBinding(gateway,role){
        if(!c.profileManifestPath||!c.profileManifestSha256)throw new DomainError('NATIVE_FROZEN_PROFILE_REQUIRED',409);
        if(c.patches.length)throw new DomainError('NATIVE_PROFILE_OVERLAYS_DENIED',409);
        try{
            const profile=assertNativeProfile(c.profileManifestPath,c.profileManifestSha256);
            if(resolve(profile.home)!==resolve(c.dshHome)||profile.modelURL!==gateway.base||profile.model!==(c.runBinding?.model??'deepseek-flash')||profile.provider!==c.runBinding?.provider||profile.maxTokens!==c.maxTokens||c.reasoningEffort!=='off'||(profile.role??'executor')!==role)throw Error('Profile route mismatch');
        }catch{throw new DomainError('NATIVE_FROZEN_PROFILE_CHANGED',409);}
        return {DM_DSH_PROFILE_MANIFEST:c.profileManifestPath,DM_DSH_PROFILE_SHA256:c.profileManifestSha256,DSH_TELEMETRY_DISABLED:'1'};
    }
    async function run(input, emit, signal) {
        if(c.runBinding?.role!==undefined){
            const b=dispatchRoleBinding({role:c.runBinding.role,roleId:c.runBinding.roleId,configurationHash:c.runBinding.configurationHash,...(c.runBinding.provider!==undefined||c.runBinding.model!==undefined?{provider:c.runBinding.provider,model:c.runBinding.model}:{})});
            if(input.role!==b.role||b.role==='executor'&&input.executorRoleId!==b.roleId)throw new DomainError('NATIVE_DISPATCH_ROLE_MISMATCH',403);
        }else if(input.role!=='executor')throw new DomainError('ARCHON_EXECUTOR_ROLE_REQUIRED',403);
        if(c.runBinding&&(c.runBinding.runId!==input.runId||c.runBinding.specHash!==input.specHash))throw new DomainError('NATIVE_DISPATCH_SCOPE_MISMATCH',409);
        if (signal.aborted) throw new DomainError('RUN_CANCELLED', 409);
        if (running) throw new DomainError('ONE_ACTIVE_RUN_ONLY', 409);
        if (hasSecret(input.prompt)) throw new DomainError('SECRET_IN_NATIVE_PROMPT');
        bindings();
        const gateway=gatewayBinding(input);
        const toolEnv=toolBinding(input.role);
        const profileEnv=profileBinding(gateway,input.role);
        const nested=(a,b)=>{const r=relative(resolve(a),resolve(b));return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));};
        if([c.controlRoot,c.dshHome].some(path=>nested(path,input.workspace)||nested(input.workspace,path)))throw new DomainError('NATIVE_CONTROL_SOURCE_OVERLAP',409);
        running = true;
        let owned, failure = null, text = '';
        const abort = () => { void owned?.close().catch(() => {}); };
        try {
            const [{ NodeHostHarness }, { HostEventBridge }] = await Promise.all([import(pathToFileURL(c.hostModule).href), import(pathToFileURL(c.eventModule).href)]);
            if (typeof NodeHostHarness !== 'function' || typeof HostEventBridge !== 'function') throw new DomainError('ARCHON_HOST_EXPORT_MISMATCH');
            const sessionId = id('archon_session');
            const bridge = new HostEventBridge(sessionId, [gateway.token,toolEnv.DM_TOOL_PROXY_TOKEN]);
            mkdirSync(c.controlRoot, { recursive: true });
            owned = new NodeHostHarness({ nodeBin: process.execPath, hostScript: c.hostScript, configFile: resolve(c.controlRoot, id('dispatch') + '.json'), config: { cwd: c.controlRoot, dshHome: c.dshHome, sdkRoot: c.sdkRoot, dshBin: c.dshBin, profile: c.profile, patches: c.patches, provider: sdkProvider, model: input.model, reasoningEffort: c.reasoningEffort, maxTokens: c.maxTokens, timeoutMs: c.timeoutMs, dreamMakerRunId: input.runId, dreamMakerSpecHash: input.specHash }, env: childEnv({ DEEPSEEK_API_KEY: gateway.token, DEEPSEEK_BASE_URL: gateway.base, SHENLIN_LAYA_ENABLED: 'false',...toolEnv,...profileEnv }) });
            active = owned;
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) throw new DomainError('RUN_CANCELLED', 409);
            const result = await owned.run(input.prompt, { sessionId, onNotification(notification) {
                try {
                    for (const chunk of bridge.consume(notification)) if (chunk.type === 'assistant') text += chunk.content;
                    emit({ owner: 'dream-maker-engine', runId: input.runId, specHash: input.specHash, notification: JSON.parse(redact(notification)) });
                } catch { failure = new DomainError('ARCHON_HOST_EVENT_INVALID', 502); abort(); }
            } });
            if (signal.aborted) throw new DomainError('RUN_CANCELLED', 409);
            if (failure) throw failure;
            if (result.closed !== true) throw new DomainError('ARCHON_HOST_CLOSE_UNPROVEN', 502);
            // Completion is proven by the host's own evidence: the session closed, the bridge finished clean
            // and no tool is still open. A turn that only called tools and never wrote assistant prose is a
            // NORMAL turn (observed as ARCHON_HOST_COMPLETION_UNPROVEN on run_93ca76460622627de1ad at
            // done=3/9); demanding non-empty text made three runs die for a cosmetic reason. Empty text is
            // returned as-is — never synthesised — and the caller decides what a text-less turn means.
            if (!bridge.finish().ok || bridge.status().openTools) throw new DomainError('ARCHON_HOST_COMPLETION_UNPROVEN', 502);
            if (result.sessionId !== sessionId) throw new DomainError('ARCHON_SESSION_MISMATCH', 502);
            return { text: redact(text), sessionId };
        } finally {
            signal.removeEventListener('abort', abort);
            try { await owned?.close(); } finally { active = undefined; running = false; }
        }
    }
    async function verify(input, emit, signal) {
        bindings();
        if (Object.entries(process.env).some(([key, value]) => /(?:API_KEY|ACCESS_TOKEN|SECRET)$/.test(key) && value)) throw new DomainError('VERIFIER_PROVIDER_KEY_PRESENT');
        const verifier = await import(pathToFileURL(c.verifierModule).href);
        if (typeof verifier.verify !== 'function') throw new DomainError('VERIFIER_EXPORT_MISMATCH');
        return verifier.verify(input, emit, signal);
    }
    return { capabilities, run, verify, close };
}

export function dispatchConfiguration(projectRoot,path,expected,audit){
    const base=resolve(projectRoot,'.runtime/native-dispatches'),relativePath=relative(base,path).split(sep).join('/');
    if(!/^owned-[A-Za-z0-9]+\/dispatch-binding\.json$/.test(relativePath))throw new DomainError('NATIVE_DISPATCH_PATH_DENIED',409);
    const checked=within(base,relativePath),bytes=readFileSync(checked);
    if(hash(bytes)!==expected)throw new DomainError('NATIVE_DISPATCH_BINDING_CHANGED',409);
    const envelope=JSON.parse(bytes),launch=envelope.launch;
    const v2=envelope.schema==='dream-maker.archon-dispatch.v2',keys=['schema','runId','specHash','template','launch',...(v2?['roleBinding']:[])];
    if(!v2&&envelope.schema!=='dream-maker.archon-dispatch.v1'||Reflect.ownKeys(envelope).length!==keys.length||!keys.every(k=>Object.hasOwn(envelope,k))||!envelope.runId||!/^[a-f0-9]{64}$/.test(envelope.specHash)||!launch||
        Object.keys(launch).some(k=>!['dshHome','controlRoot','profileManifestPath','profileManifestSha256'].includes(k)))throw new DomainError('NATIVE_DISPATCH_BINDING_INVALID',409);
    const role=v2?dispatchRoleBinding(envelope.roleBinding):undefined;
    // The template must live inside the PROJECT, not inside config/ specifically: the operator binding
    // writes it under .runtime/native/, and requiring config/ made every dispatch die with PATH_DENIED
    // (relative() yields '../.runtime/...' which within() refuses). Containment still holds.
    const template=within(projectRoot,relative(projectRoot,envelope.template.path).split(sep).join('/'));
    bound(template,audit);
    if(hash(readFileSync(template))!==envelope.template.sha256)throw new DomainError('NATIVE_DISPATCH_TEMPLATE_CHANGED',409);
    return{...readJson(template),...launch,runBinding:{runId:envelope.runId,specHash:envelope.specHash,...role}};
}

let adapter;
function configured() {
    if (adapter) return adapter;
    const path = resolve(root, 'config/archon-dsh-native.local.json'), auditPath = process.env.DM_NATIVE_AUDIT_PATH;
    if (!auditPath) throw new DomainError('NATIVE_AUDIT_REQUIRED');
    const audit = readJson(auditPath);
    if (audit.status !== 'LIVE_READY') throw new DomainError('NATIVE_AUDIT_NOT_READY');
    adapter = process.env.DM_ARCHON_DISPATCH_PATH?
        createArchonAdapter(dispatchConfiguration(root,process.env.DM_ARCHON_DISPATCH_PATH,process.env.DM_ARCHON_DISPATCH_SHA256,audit),audit):
        createArchonAdapter(readJson(path), audit, path);
    return adapter;
}
export async function capabilities() { return { binding: 'existing-archon-node-host-v1', owner: 'dream-maker-engine', verified: false }; }
export async function run(input, emit, signal) { return configured().run(input, emit, signal); }
export async function verify(input, emit, signal) { return configured().verify(input, emit, signal); }
export async function close() { await adapter?.close(); }
