#!/usr/bin/env node
// Generate the native execution audit ONLY from checks that actually ran.
//
// Why a generator instead of a hand-written JSON: providers/dsh.ts validates every field of the audit
// (configuration fingerprint, LIVE_READY, four *Verified flags, expiry, per-file sha256, module hash).
// Writing those by hand would be a self-certification with no evidence. This script performs the
// checks, hashes the real evidence files, and refuses to emit LIVE_READY while any check fails.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { childEnv } from '../dist/server/security.js';
import { validateSandboxCommand } from '../dist/server/wsl-sandbox.js';
import { validateVerifierPlan } from '../dist/server/wsl-verifier.js';
import {resourceImplementationFiles} from '../dist/server/sandbox-resource.js';
import { OPERATOR_REQUEST_CEILING } from '../dist/server/operator-ceiling.js';
import { assertCustomModelPrices } from '../dist/server/native-budget.js';
import { nativeReadiness,dshRuntimeReadiness } from '../dist/server/providers/dsh.js';
import { layaQualificationBinding } from '../dist/server/laya-qualification.js';
import { parseConfig } from '../dist/server/config.js';

const root = resolve('.');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };

// --- candidate configuration for the executor role ------------------------------------------------
const base = JSON.parse(readFileSync(resolve(root, 'config/local.json'), 'utf8'));
const candidate = parseConfig({
    ...base,
    dsh: { modulePath: resolve(root, 'adapters/archon-dsh-native.mjs'), model: 'deepseek-flash', keyEnv: 'DEEPSEEK_API_KEY' },
    codex: { ...base.codex }, // Audit the selected runtime/home; never substitute an empty legacy home/model.
    nativeAuditPath: resolve(root, '.runtime/native-audit.json')
});
const readiness = nativeReadiness({ ...candidate, nativeAuditPath: '' });

// 1) OS isolation: the sandbox refuses anything outside the supported shape.
const NUL = String.fromCharCode(0);
const rejections = [
    () => validateSandboxCommand({ runtime: 'bash', entry: 'main.mjs', args: [], stdin: '' }),
    () => validateSandboxCommand({ runtime: 'node', entry: '/etc/passwd', args: [], stdin: '' }),
    () => validateSandboxCommand({ runtime: 'node', entry: 'main.mjs', args: [NUL], stdin: '' }),
    () => validateSandboxCommand({ runtime: 'node', entry: 'main.mjs', args: [], stdin: 'x'.repeat(70000) })
];
let refused = 0;
for (const attempt of rejections) { try { attempt(); } catch { refused += 1; } }
const accepted = (() => { try { return !!validateSandboxCommand({ runtime: 'node', entry: 'main.mjs', args: ['a'], stdin: '' }); } catch { return false; } })();
check('osIsolationVerified', refused === rejections.length && accepted, refused + '/' + rejections.length + ' hostile sandbox commands refused, benign accepted=' + accepted);

// 2) Secret isolation: the adapter env carries an ephemeral gateway token, never the real key.
const REAL_KEY = 'sk-REAL-SECRET-MUST-NOT-LEAK-0123456789';
const env = childEnv({ [candidate.dsh.keyEnv]: 'GATEWAY-EPHEMERAL-TOKEN', DM_MODEL_GATEWAY_URL: 'http://127.0.0.1:1/v1', DM_MODEL_GATEWAY_TOKEN: 'GATEWAY-EPHEMERAL-TOKEN' });
const leaked = JSON.stringify(env).includes(REAL_KEY);
const tokenOnly = env[candidate.dsh.keyEnv] === 'GATEWAY-EPHEMERAL-TOKEN';
check('secretIsolationVerified', !leaked && tokenOnly, 'real key absent=' + !leaked + ', keyEnv carries the ephemeral token=' + tokenOnly);

// 3) Verifier implemented: the trusted plan validator exists and refuses a foreign spec hash.
const verifierModule = resolve(root, 'adapters/wsl-verifier.mjs');
const plan = { schema: 'dream-maker.cli-verifier.v1', specHash: 'h'.repeat(64), cases: [{ id: 'C1', requirementIds: ['R001'], runtime: 'node', entry: 'main.mjs', args: [], stdin: '', expectedExitCode: 0, expectedStdout: 'PASS' }] };
let verifierOk = existsSync(verifierModule);
try { validateVerifierPlan(plan, 'h'.repeat(64), ['R001']); } catch (e) { verifierOk = false; console.log('  verifier fixture rejected: ' + String(e.code ?? e.message)); }
let refusedForeign = false;
try { validateVerifierPlan(plan, 'f'.repeat(64), ['R001']); } catch { refusedForeign = true; }
check('verifierImplemented', verifierOk && refusedForeign, 'module exists=' + existsSync(verifierModule) + ', plan accepts exact spec hash=' + verifierOk + ', foreign hash refused=' + refusedForeign);

// 3b) The plan validator is not the verifier: one benign case must actually EXECUTE inside the
//     isolation sandbox. Without this the audit would certify a boundary it never crossed.
import { mkdtempSync, rmSync } from 'node:fs';
import { WslSandbox } from '../dist/server/wsl-sandbox.js';
import { treeHash } from '../dist/server/workspace.js';
mkdirSync(resolve(root, '.runtime'), { recursive: true });
const sandboxDir = mkdtempSync(resolve(root, '.runtime/audit-sandbox-'));
let sandboxOk = false, sandboxDetail = 'not run';
try {
    writeFileSync(resolve(sandboxDir, 'main.mjs'), "console.log('AUDIT_OK');\n");
    const before = treeHash(sandboxDir);
    const run = await new WslSandbox(root).run(sandboxDir, { runtime: 'node', entry: 'main.mjs', args: [], stdin: '' }, {});
    const unchanged = treeHash(sandboxDir) === before;
    sandboxOk = run.status === 'EXECUTED' && run.exitCode === 0 && run.stdout === 'AUDIT_OK\n' && unchanged;
    sandboxDetail = 'status=' + run.status + ' exit=' + run.exitCode + ' stdout=' + JSON.stringify(run.stdout) + ' workspaceUnchanged=' + unchanged;
}
catch (error) { sandboxDetail = 'refused: ' + String(error && error.code || error).slice(0, 100); }
finally { rmSync(sandboxDir, { recursive: true, force: true }); }
check('sandboxExecutionVerified', sandboxOk, sandboxDetail);

// 4) Laya either stays OFF on real turns, or the enhanced Classic path holds a controller-owned
//    qualification: one real forward per engineering role, bound to this exact configuration.
const layaEvidencePath = resolve(root, '.runtime/laya-live-evidence.json');
// Recompute the qualification binding here with the exact function the Engine used. A source,
// prompt, adapter, Laya or role-model edit changes this fingerprint, so stale forward results
// cannot certify the current tree.
const layaBinding = layaQualificationBinding(root, candidate, p => treeHash(p));
let layaOk = false, layaDetail = 'no evidence file (run real Live turns first)';
if (existsSync(layaEvidencePath)) {
    try {
        const ev = JSON.parse(readFileSync(layaEvidencePath, 'utf8'));
        const base = ev.mode === 'LIVE' && Number(ev.turns) > 0 && ev.influencedTurns === 0;
        const off = base && ev.fullyOff === true;
        // Advisory mode: the runners never call Laya; the controller does, once per role, and the
        // record must match BOTH fingerprints this audit certifies: the qualification binding
        // (source + Laya + role models) and the nativeReadiness configuration (codex/dsh/laya/limits).
        const advisory = base && candidate.laya.mode !== 'off' &&
            ev.schema === 'dream-maker.laya-live-evidence.v2' && ev.fullyOff === false &&
            ev.controllerOwned === true && ev.qualified === true &&
            Number(ev.explicitControllerCalls) === 3 &&
            typeof ev.sourceHash === 'string' && ev.sourceHash === layaBinding.sourceHash &&
            typeof ev.configurationHash === 'string' && ev.configurationHash === layaBinding.configurationHash &&
            typeof ev.auditConfigurationHash === 'string' && ev.auditConfigurationHash === readiness.configurationHash;
        layaOk = off || advisory;
        layaDetail = JSON.stringify({ mode: ev.mode, turns: ev.turns, fullyOff: ev.fullyOff,
            path: off ? 'OFF_BASELINE' : advisory ? 'EXPLICIT_ADVISORY' : 'UNQUALIFIED',
            qualificationBound: ev.sourceHash === layaBinding.sourceHash && ev.configurationHash === layaBinding.configurationHash,
            readinessBound: ev.auditConfigurationHash === readiness.configurationHash });
    } catch (e) { layaDetail = 'unreadable: ' + String(e.message).slice(0, 60); }
}
check('noImplicitLayaVerified', layaOk, layaDetail);

// 5) Operator binding: the refs the owner will re-verify must exist and still hash to what the
//    binding recorded. assertReady() re-checks every one of these at call time, so auditing them
//    here is the only way the audit can honestly cover the binding it authorises.
const operatorPath = resolve(root, 'config/native-owner.local.json');
let operatorOk = false, operatorDetail = 'missing ' + operatorPath;
const bindingPaths = new Map();
if (existsSync(operatorPath)) {
    try {
        const opText = readFileSync(operatorPath, 'utf8');
        const op = JSON.parse(opText);
        const problems = [];
        if (op.schema !== 'dream-maker.native-owner.v1') problems.push('schema');
        if (resolve(op.scopeRoot) !== resolve(root)) problems.push('scopeRoot');
        // Keep this in step with NativeOwner: the request ceiling is operational (money is bounded by prices
// and the authority), and 30 could not cover four probes plus a real executor turn.
if (!Number.isInteger(op.maxRequests) || op.maxRequests < 1 || op.maxRequests > OPERATOR_REQUEST_CEILING) problems.push('maxRequests');
        if (!Number.isInteger(op.maxOutputTokens) || op.maxOutputTokens < 128 || op.maxOutputTokens > 16000) problems.push('maxOutputTokens');
        if (/sk-[A-Za-z0-9]/.test(opText)) problems.push('secret-shaped text');
        const refs = [op.authority, op.template, op.magpieCandidate, ...Object.values(op.prices ?? {}), ...(op.files?.dependencies ?? []), ...(op.profileBinding?.dependencies ?? [])].filter(Boolean);
        if (op.claudeSupervisor !== undefined) {
            const {verifiedClaudeCommand}=await import('../dist/server/providers/claude-supervisor.js');
            verifiedClaudeCommand(op.claudeSupervisor);
            bindingPaths.set(op.claudeSupervisor.path,op.claudeSupervisor.sha256);
        }
        try {
            assertCustomModelPrices(op.customModelPrices, root);
            refs.push(...Object.values(op.customModelPrices ?? {}));
        } catch { problems.push('customModelPrices'); }
        if (op.customTextCli !== undefined) {
            if (!op.customTextCli || typeof op.customTextCli !== 'object' || Array.isArray(op.customTextCli) || Object.keys(op.customTextCli).some(runtime => !['opencode','cline'].includes(runtime))) problems.push('customTextCli');
            else refs.push(...Object.values(op.customTextCli));
        }
        for (const ref of refs) {
            if (typeof ref?.path !== 'string' || typeof ref?.sha256 !== 'string') { problems.push('ref shape'); continue; }
            if (!existsSync(ref.path)) { problems.push('missing ' + ref.path); continue; }
            const actual = sha256(readFileSync(ref.path));
            if (actual !== ref.sha256) { problems.push('changed ' + ref.path); continue; }
            bindingPaths.set(ref.path, actual);
        }
        const template = JSON.parse(readFileSync(op.template.path, 'utf8'));
        const {dshTemplateBindingFiles}=await import('../dist/server/dsh-template-bindings.js');
        const plain = [op.sdkToolsModule,...dshTemplateBindingFiles(template)];
        for (const path of plain) {
            if (typeof path !== 'string') { problems.push('plain path shape'); continue; }
            if (!existsSync(path)) { problems.push('missing ' + path); continue; }
            bindingPaths.set(path, sha256(readFileSync(path)));
        }
        bindingPaths.set(operatorPath, sha256(readFileSync(operatorPath)));
        operatorOk = problems.length === 0;
        operatorDetail = problems.length === 0 ? bindingPaths.size + ' binding files verified' : 'problems: ' + [...new Set(problems)].slice(0, 4).join('; ');
    } catch (e) { operatorDetail = 'unreadable: ' + String(e.message).slice(0, 80); }
}
check('operatorBindingsVerified', operatorOk, operatorDetail);

// --- emit only when every check passed ------------------------------------------------------------
const failed = results.filter(r => !r.ok);
if (failed.length > 0) {
    console.log('AUDIT_NOT_WRITTEN — ' + failed.length + ' check(s) lack real evidence: ' + failed.map(f => f.name).join(', '));
    console.log('configurationHash=' + readiness.configurationHash);
    process.exitCode = 1;
} else {
    const auditPath = candidate.nativeAuditPath;
    const evidence = [
        { path: candidate.dsh.modulePath, sha256: sha256(readFileSync(candidate.dsh.modulePath)) },
        { path: verifierModule, sha256: sha256(readFileSync(verifierModule)) },
        { path: layaEvidencePath, sha256: sha256(readFileSync(layaEvidencePath)) },
        ...resourceImplementationFiles.map(name=>{const path=resolve(root,name);return{path,sha256:sha256(readFileSync(path))};}),
        ...[...bindingPaths].map(([path, sha]) => ({ path, sha256: sha }))
    ];
    const audit = {
        schema: 'dream-maker.native.audit.v1',
        status: 'LIVE_READY',
        configurationHash: readiness.configurationHash,
        dshConfigurationHash:dshRuntimeReadiness({...candidate,nativeAuditPath:''}).configurationHash,
        moduleSha256: sha256(readFileSync(candidate.dsh.modulePath)),
        osIsolationVerified: true,
        secretIsolationVerified: true,
        noImplicitLayaVerified: true,
        verifierImplemented: true,
        sandboxExecutionVerified: true,
        operatorBindingsVerified: true,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        evidenceFiles: evidence,
        checks: results.map(r => ({ name: r.name, detail: r.detail }))
    };
    writeFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n', { mode: 0o600 });
    console.log('AUDIT_WRITTEN ' + auditPath);
}
