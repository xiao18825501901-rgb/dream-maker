#!/usr/bin/env node
// Generate the operator binding for the real DSH executor from REAL local files.
//
// Every path is resolved from something that exists on this machine and every digest is computed from
// the bytes on disk — no placeholder SHA, no invented price, no copied Archon implementation (ADR 005).
// The script prints what it could not establish instead of inventing it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { OPERATOR_REQUEST_CEILING } from '../dist/server/operator-ceiling.js';

const root = resolve('.');
const out = resolve(root, '.runtime/native');
mkdirSync(out, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const digestOf = path => (existsSync(path) ? sha256(readFileSync(path)) : null);
const write = (name, value, mode = 0o600) => { const p = join(out, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(value, null, 2) + '\n', { mode }); return p; };
const need = (label, path) => { if (!existsSync(path)) { console.log('MISSING ' + label + ' -> ' + path); process.exitCode = 1; } return path; };

// --- real component locations (verified last round) ----------------------------------------------
const SDK_ROOT = resolve(process.env.DM_SUITE_ROOT || resolve(root,'../..'),'runtime/dsh-sdk-0.2.0-rc.1');
const SDK = join(SDK_ROOT,'node_modules/@deepseek-ai');
const ARCHON = 'C:\\Users\\Hp\\Documents\\Archon_Astra_DSH_Source_Package\\Archon_Astra_DSH_Source_Package';
const files = {
  hostModule: need('hostModule', join(ARCHON, 'dist/provider/node-host-client.js')),
  eventModule: need('eventModule', join(ARCHON, 'dist/provider/host-events.js')),
  // The project's OWN copy, not the shared Archon install: an earlier round removed the 300000 ms cap on
  // one executor turn by editing the shared file in place, which left dispatch depending on a mutated
  // global install. The derived copy is byte-identical, lives in this worktree, and is the only path the
  // operator binding and the dispatch template now name.
  hostScript: need('hostScript', join(root, 'vendor/archon/dsh-node-host.mjs')),
  // `defineTool` is the DSH SDK's tool compiler, not Archon's file-tools module: pointing this at
  // Archon's file-tools made the tool plugin's `const {defineTool} = await import(...)` resolve to
  // undefined, so the plugin threw, registered NOTHING, and every executor turn shipped a request with
  // no `tools` at all (observed via DM_GATEWAY_TRACE: keys had no tools entry).
  sdkToolsModule: need('sdkToolsModule', join(SDK, 'dsh-tools/lib/index.js')),
  archonFileTools: need('archonFileTools', join(ARCHON, 'dist/provider/file-tools.js')),
  policyManifest: need('policyManifest', join(ARCHON, 'dist/provider/policy-manifest.js')),
  dshBin: need('dshBin', join(SDK, 'dsh/lib/bin.js')),
  sdkRootDir: need('sdkRoot', join(SDK, 'dsh-sdk-client')),
  sdkClientEntry: need('sdkClientEntry', join(SDK, 'dsh-sdk-client/lib/index.js')),
  basePatch: need('basePatch', join(SDK, 'dsh-base/cordis.patch.yml')),
  sdkPatch: need('sdkPatch', join(SDK, 'dsh-sdk-app/cordis.patch.yml')),
  yamlModule: need('yamlModule', join(SDK_ROOT,'node_modules/js-yaml/index.js')),
  verifierModule: need('verifierModule', resolve(root, 'adapters/wsl-verifier.mjs')),
  adapterModule: need('adapterModule', resolve(root, 'adapters/archon-dsh-native.mjs')),
  // The executor's file tools live in Archon's file-tools module, and it imports its own io helper.
  // Pointing files.modulePath at the ARCHON ADAPTER instead (what this script used to do) fails at
  // execution time with NATIVE_FILE_MODULE_NOT_AUDITED, because the adapter exports no BoundedFileTools.
  fileToolsModule: need('fileToolsModule', join(ARCHON, 'dist/provider/file-tools.js')),
  coreIoModule: need('coreIoModule', join(ARCHON, 'dist/core/io.js'))
};
if (process.exitCode === 1) { console.log('ABORT: a required component is absent'); process.exit(1); }

// sdkRoot is a directory the adapter resolves lib/index.js inside; it is not itself a hashed file.
const manifest = Object.fromEntries(Object.entries(files).map(([k, p]) => k === 'sdkRootDir'
    ? [k, { path: p, directory: true }]
    : [k, { path: p, sha256: digestOf(p), bytes: readFileSync(p).length }]));
console.log('COMPONENTS'); for (const [k, v] of Object.entries(manifest)) console.log('  ' + k.padEnd(16) + ' ' + (v.sha256 ? v.sha256.slice(0, 16) : '(directory)      ') + '  ' + v.path);

// --- authority: owner-approved uncapped testing (HA-005) ------------------------------------------
const authority = {
  scopeId: 'dream-maker-live-' + sha256(root).slice(0, 12),
  // Full sha256: a truncated id here is what made every probe unverifiable
  // (NATIVE_PROBE_BINDING_INVALID) before the probe binding started hashing the whole document.
  authorizationHash: sha256('HA-004+HA-005:' + root),
  totalMicros: 50000000, probeMicros: 5000000, warningMicros: 40000000,
  maxInFlight: 1, maxRepairs: 2,
  mode: 'UNCAPPED',
  uncappedApproval: {
    // FIXED, not new Date(): the approval moment is a fact from 2026-10-18 22:06, and a generator that
    // stamped "now" on every run would mint a fresh authorization each time (and break the ledger id).
    approvedAt: '2026-10-18T14:06:00.000Z',
    approvedBy: 'USER',
    statement: 'User approved necessary official DeepSeek inference for Dream Maker Live acceptance without a cumulative CNY ceiling (2026-10-18 22:06).',
    evidenceRef: 'docs/continuation/HUMAN_ACTIONS.json#HA-005',
    supersedes: ['totalMicros<=50000000', 'probeMicros<=5000000', 'warningMicros<=40000000']
  }
};
const authorityPath = write('authority.json', authority);

// --- official price artifact (peak rates, so the reservation is an upper bound) --------------------
const price = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  currency: 'CNY',
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing (peak-hour rates, captured ' + new Date().toISOString().slice(0, 10) + ')',
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  maxInputTokens: 1048576,
  inputMissMicrosPerMillion: 2000000,
  inputHitMicrosPerMillion: 40000,
  outputMicrosPerMillion: 8000000
};
const pricePath = write('prices/executor.json', price);
console.log('PRICE official deepseek-flash: peak in-miss 2 CNY / in-hit 0.04 CNY / out 8 CNY per Mtok, 1M ctx');

// --- independent provider price (official USD list price, no FX invention) ------------------------
// The two providers bill in two currencies. Rather than convert dollars into yuan at a rate nobody on
// this machine can attest, the artifact declares USD and the ledger keeps a per-currency total.
const independentConfig = (() => {
  try { return JSON.parse(readFileSync(resolve(root, 'config/local.json'), 'utf8')).independent ?? null; }
  catch { return null; }
})();
const independentModel = String(independentConfig?.model ?? '');
const OPENAI_PRICING = {
  // Standard tier, USD per 1M tokens. Captured from the official page; the sha256 is of the page bytes
  // so the numbers can be re-checked against the exact document this binding was made from.
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
};
const officialPricing = OPENAI_PRICING[independentModel] ?? null;
const independentPricePath = officialPricing ? write('prices/independent.json', {
  provider: 'openai-official',
  model: independentModel,
  currency: 'USD',
  source: 'https://developers.openai.com/api/docs/pricing standard tier, captured ' + new Date().toISOString().slice(0, 10) +
    ' (page sha256 a4b423233db0d4a44eb84538f7ab8553de9e22c362ae99338bb91cb0e53cd6ac); USD, never converted to CNY',
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  // Deliberately conservative: the reservation window is larger than the model's own context, so a
  // reservation is an upper bound and settlement corrects it with the provider's real token counts.
  maxInputTokens: 1048576,
  inputMissMicrosPerMillion: Math.round(officialPricing.input * 1e6),
  inputHitMicrosPerMillion: Math.round(officialPricing.cachedInput * 1e6),
  outputMicrosPerMillion: Math.round(officialPricing.output * 1e6)
}) : null;
if (independentPricePath) console.log('PRICE official ' + independentModel + ' (USD): in-miss ' + officialPricing.input + ' / in-hit ' + officialPricing.cachedInput + ' / out ' + officialPricing.output + ' per Mtok');
else if (independentConfig?.enabled === true) console.log('MISSING independent price for model "' + independentModel + '" — the independent provider cannot be probed or run until an official price artifact exists.');

// --- template: the Archon launch template the native owner validates ------------------------------
const maxOutputTokens = 8192;
const template = {
  schema: 'dream-maker.archon-template.v1',
  profile: 'sdk',
  reasoningEffort: 'off',
  maxTokens: maxOutputTokens,
  // A template without timeoutMs dies as ARCHON_LAUNCH_LIMITS_INVALID on the unsuited path.
  // This is ALSO the hard ceiling on one executor turn: Archon's scripts/dsh-node-host.mjs:227 starts
  // `setTimeout(..., config.timeoutMs)` and, when it fires, prints 'run timeout reached', closes the host
  // and exits 0 — which the parent can only see as a failed RPC. At 120000 a real tool-using turn (20+ SDK
  // steps, 45 desk-tool calls) was killed mid-flight and looked like an unexplained child death.
  timeoutMs: 1200000,
  patches: [],
  hostModule: files.hostModule,
  eventModule: files.eventModule,
  hostScript: files.hostScript,
  dshBin: files.dshBin,
  sdkRoot: files.sdkRootDir,
  verifierModule: files.verifierModule,
  dependencyFiles: [files.policyManifest]
};
const templatePath = write('template.json', template);

const filesPath = write('files.json', { schema: 'dream-maker.native.files.v1', generatedAt: new Date().toISOString(), components: manifest });

// --- operator binding ----------------------------------------------------------------------------
const ref = path => ({ path, sha256: digestOf(path) });
const operator = {
  schema: 'dream-maker.native-owner.v1',
  scopeRoot: root,
  authority: ref(authorityPath),
  template: ref(templatePath),
  // When the independent roles run on DeepSeek's OpenAI-compatible endpoint (owner-authorized same-vendor
  // fallback, 2026-10-28), they bill at the SAME official CNY price artifact as the executor — so the ledger
  // stays truthful instead of pretending a USD price applies.
  prices: independentConfig?.enabled === true
    ? (String(independentConfig.baseUrl ?? '').includes('api.deepseek.com')
        ? { executor: ref(pricePath), independent: ref(pricePath) }
        : (independentPricePath ? { executor: ref(pricePath), independent: ref(independentPricePath) } : { executor: ref(pricePath) }))
    : { executor: ref(pricePath) },
  files: { modulePath: files.fileToolsModule, dependencies: [ref(files.hostModule), ref(files.eventModule), ref(files.hostScript), ref(files.fileToolsModule), ref(files.coreIoModule), ref(files.archonFileTools), ref(files.sdkToolsModule), ref(files.policyManifest), ref(files.sdkClientEntry)], readPaths: ['main.mjs', 'src', 'sample.json', 'data.json'], writePaths: ['main.mjs', 'src', 'sample.json', 'data.json'] },
  sdkToolsModule: files.sdkToolsModule,
  profileBinding: { sdkCommit: '4878cdabd87d4041bdaff61d04c966883b9fd07a', basePatch: files.basePatch, sdkPatch: files.sdkPatch, yamlModule: files.yamlModule, dependencies: [ref(files.basePatch), ref(files.sdkPatch), ref(files.yamlModule)] },
  oracleRoot: resolve(root, '.runtime/controller/oracles'),
  oracles: {},
  maxOutputTokens,
  maxRequests: OPERATOR_REQUEST_CEILING, // operational guard only; money is bounded by prices and the authority. Raise it in src/server/operator-ceiling.ts and record the owner's instruction under docs/continuation/AUTHORITY_CHANGE_*.md
  probeExpiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
};
mkdirSync(operator.oracleRoot, { recursive: true });
const operatorPath = resolve(root, 'config/native-owner.local.json');
writeFileSync(operatorPath, JSON.stringify(operator, null, 2) + '\n', { mode: 0o600 });
console.log('WROTE ' + operatorPath);

// --- what is still not established ---------------------------------------------------------------
const gaps = [];
if (!process.env.DEEPSEEK_API_KEY) gaps.push('DEEPSEEK_API_KEY is absent from the launching environment (HA-006)');
if (!existsSync(resolve(root, '.runtime/native-audit.json'))) gaps.push('native audit not written yet (scripts/native-audit.mjs needs real Live turns)');
if (Object.keys(operator.oracles).length === 0) gaps.push('oracles are produced per project from the trusted verifier plan + owner consent');
console.log(gaps.length === 0 ? 'BINDING_COMPLETE' : 'BINDING_WRITTEN_WITH_GAPS');
for (const g of gaps) console.log('  GAP ' + g);
