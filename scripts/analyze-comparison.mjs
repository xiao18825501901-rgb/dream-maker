// Summarizes externally recorded, matched trials; never invents missing runs or prices.
import { readFileSync } from 'node:fs';
const file = process.argv[2];
if (!file) {
    console.log(readFileSync('eval/comparison-plan.json', 'utf8'));
    process.exit(0);
}
const rows = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(rows) || !rows.length)
    throw Error('NONEMPTY_RECORD_ARRAY_REQUIRED');
const groups = new Map();
for (const r of rows) {
    if (!['A', 'B', 'C'].includes(r.arm) || typeof r.caseId !== 'string' || !Number.isSafeInteger(r.repeat) || typeof r.success !== 'boolean' || !Number.isFinite(r.latencyMs) || r.latencyMs < 0 || !Array.isArray(r.evidenceRefs) || r.evidenceRefs.length === 0)
        throw Error('INVALID_COMPARISON_RECORD');
    for (const k of ['inputDigest', 'codeBaseHash', 'modelMapHash', 'cacheState'])
        if (typeof r[k] !== 'string' || !r[k])
            throw Error('CONTROL_MISSING:' + k);
    const key = [r.caseId, r.repeat, r.cacheState].join(':');
    const group = groups.get(key) || [];
    if (group.some(x => x.arm === r.arm))
        throw Error('DUPLICATE_ARM');
    group.push(r);
    groups.set(key, group);
}
for (const group of groups.values()) {
    if (group.length !== 3)
        throw Error('UNMATCHED_TRIAL');
    for (const k of ['inputDigest', 'codeBaseHash', 'modelMapHash'])
        if (new Set(group.map(x => x[k])).size !== 1)
            throw Error('UNCONTROLLED_COMPARISON:' + k);
}
const summary = { schema: 'dream-maker.comparison-summary.v1', evidenceLevel: 'REPORTED_RUN_METRICS_NOT_INDEPENDENTLY_VERIFIED', matchedTrials: groups.size, arms: {} };
for (const arm of ['A', 'B', 'C']) {
    const selected = rows.filter(r => r.arm === arm), latencies = selected.map(x => x.latencyMs).sort((a, b) => a - b), sum = key => selected.every(r => Number.isFinite(r[key]) && r[key] >= 0) ? selected.reduce((a, r) => a + r[key], 0) : null;
    summary.arms[arm] = { runs: selected.length, successes: selected.filter(r => r.success).length, meanLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length, p95LatencyMs: latencies[Math.ceil(latencies.length * .95) - 1], inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), costUsd: sum('costUsd') };
}
console.log(JSON.stringify(summary, null, 2));
