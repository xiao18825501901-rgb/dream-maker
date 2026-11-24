// Only the official model-list GET, never inference or raw authentication output.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Settings } from '../dist/server/config.js';
import { ModelProvider } from '../dist/server/providers/model.js';
const output = process.argv[2];
if (!output) throw Error('EXPLICIT_EVIDENCE_OUTPUT_REQUIRED');
const root = resolve('.'), settings = new Settings(resolve(root, 'config/local.json'));
const p = settings.value.planner1;
const candidateEnv = process.argv[3];
if (candidateEnv) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(candidateEnv)) throw Error('INVALID_CANDIDATE_ENV_NAME');
    p.keyEnv = candidateEnv;
}
const report = { schema: 'dream-maker.planner-api-metadata.v1', recordedAt: new Date().toISOString(),
    evidenceClass: 'REAL_API_METADATA_NOT_MODEL_RESPONSE', modelTurns: 0, paidInferenceRequests: 0,
    configurationPresent: existsSync(settings.path), provider: 'openai', baseUrl: p.baseUrl,
    protocol: p.protocol, model: p.model || null, keyEnv: p.keyEnv, keyPresent: !!process.env[p.keyEnv],
    deepSeekControlEnvironmentKeyPresent: !!process.env.DEEPSEEK_API_KEY, result: null };
if (p.baseUrl.replace(/\/$/, '') !== 'https://api.openai.com/v1' || p.protocol !== 'openai-responses') throw Error('SCOPE_REQUIRES_OPENAI_PLANNER_API');
try {
    const list = await new ModelProvider(() => settings.value, root).models();
    report.result = { status: 'PASS', configuredModelAvailable: p.model ? list.models.some(m => m.id === p.model) : null,
        modelCount: list.models.length, selectedAvailableIds: list.models.filter(m => /^(gpt-4\.1-mini|gpt-4o-mini|gpt-5-mini|gpt-6-sol)$/.test(m.id)).map(m => m.id) };
} catch (e) { report.result = { status: 'BLOCKED', code: e.code ?? 'MODEL_METADATA_UNAVAILABLE' }; }
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(report));
