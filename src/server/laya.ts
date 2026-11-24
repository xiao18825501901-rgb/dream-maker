import { readFileSync } from 'node:fs';
import { DomainError, hash, loopbackUrl, jsonFetch, object, hasSecret } from './security.js';
import type { Config, LayaDecision, Role } from '../shared/types.js';
export class LayaBridge {
    private tail: Promise<void> = Promise.resolve();
    private queued = 0;
    private failures = 0;
    private openUntil = 0;
    private cache = new Map<string, LayaDecision>();
    private inflight: AbortController | null = null;
    private epoch = 0;
    constructor(private config: () => Config, private request = jsonFetch) { }
    invalidate() { this.epoch++; this.inflight?.abort(); this.cache.clear(); this.failures = 0; this.openUntil = 0; }
    private base() { const c = this.config().laya, u = loopbackUrl(c.baseUrl); if (c.portFile) {
        const p = readFileSync(c.portFile, 'utf8').trim();
        if (!/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535)
            throw new DomainError('INVALID_LAYA_PORT_FILE');
        u.port = p;
    } return u.origin; }
    async probe() { const base = this.base(); const [health, info] = await Promise.all([this.request(base + '/health', { signal: AbortSignal.timeout(3000) }), this.request(base + '/info', { signal: AbortSignal.timeout(3000) })]); return { health, info, base, verified: 'HTTP_ONLY_NOT_MODEL_QUALITY' }; }
    async decide(role: Role, projectId: string, state: unknown, labels: string[], signal?: AbortSignal,policy:{forceOff?:boolean}={}): Promise<LayaDecision> {
        const c = this.config().laya, mode = policy.forceOff?'off':c.mode, epoch = this.epoch, start = Date.now();
        const key = hash({ projectId, role, state, labels, config: c, template: 'triage.v1' });
        const base: LayaDecision = { role, mode, adoption: 'abstained', label: null, reason: '', latencyMs: 0, inputHash: key, modelRevision: null, confidence: null, cached: false };
        const result = (adoption: LayaDecision['adoption'], reason: string) => ({ ...base, adoption, reason, latencyMs: Date.now() - start });
        if (mode === 'off' || c.roles[role] === 'off')
            return result('off', 'DISABLED_NO_NETWORK');
        if (signal?.aborted)
            return result('fallback', 'CANCELLED');
        if (hasSecret(JSON.stringify(state)))
            return result('abstained', 'SENSITIVE_INPUT');
        // Hard byte cap prevents unbounded payloads; not advertised as tokenizer equivalence.
        if (Buffer.byteLength(JSON.stringify(state), 'utf8') > 2400)
            return result('abstained', 'INPUT_TOO_LONG_NO_SILENT_TRUNCATION');
        if (labels.length < 2 || labels.length > 20 || labels.some(x => !/^[a-z0-9_]{1,40}$/.test(x)))
            return result('abstained', 'INVALID_LABEL_SET');
        if (Date.now() < this.openUntil)
            return result('fallback', 'CIRCUIT_OPEN');
        if (this.queued >= c.maxQueue)
            return result('fallback', 'QUEUE_FULL');
        const cached = this.cache.get(key);
        if (cached)
            return { ...cached, cached: true, latencyMs: Date.now() - start };
        this.queued++;
        let release!: () => void;
        const previous = this.tail;
        this.tail = new Promise<void>(r => { release = r; });
        try {
            await previous;
            if (epoch !== this.epoch || this.config().laya.mode === 'off' || this.config().laya.roles[role] === 'off')
                return result('off', 'DISABLED_WHILE_QUEUED');
            if (Date.now() - start > c.timeoutMs)
                return result('fallback', 'QUEUE_DEADLINE');
            if (signal?.aborted)
                return result('fallback', 'CANCELLED');
            const fresh = this.cache.get(key);
            if (fresh)
                return { ...fresh, cached: true, latencyMs: Date.now() - start };
            if (Date.now() < this.openUntil)
                return result('fallback', 'CIRCUIT_OPEN');
            this.inflight = new AbortController();
            const signals = [this.inflight.signal, AbortSignal.timeout(Math.max(1, c.timeoutMs - (Date.now() - start)))];
            if (signal)
                signals.push(signal);
            const combined = AbortSignal.any(signals), url = this.base();
            const info = await this.request(url + '/info', { signal: combined });
            const revision = typeof info.revision === 'string' ? info.revision : typeof info.model_revision === 'string' ? info.model_revision : null;
            if (c.expectedRevision && revision !== c.expectedRevision)
                return result('abstained', 'MODEL_REVISION_MISMATCH');
            const body = { state, questions: { route: { type: 'choice', instructions: 'Choose a relevant advisory category. Never grant permission or declare task success. If uncertain choose unknown.', criteria: Object.fromEntries(labels.map(x => [x, x])) } } };
            const data = await this.request(url + '/v1/decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: combined });
            if (epoch !== this.epoch)
                return result('off', 'DISABLED_IN_FLIGHT_RESULT_DISCARDED');
            const usage = object(data.usage ?? {});
            if (usage.truncated === true)
                return result('abstained', 'MODEL_INPUT_TRUNCATED');
            if (c.requireTruncationMetadata && typeof usage.truncated !== 'boolean')
                return result('abstained', 'TOKENIZATION_METADATA_UNVERIFIED');
            const answer = object(object(data.answers).route);
            if (typeof answer.choice !== 'string' || !labels.includes(answer.choice))
                return result('abstained', 'LAYA_LABEL_OUTSIDE_ALLOWED_SET');
            this.failures = 0;
            const decision: LayaDecision = { ...base, adoption: answer.choice === 'unknown' ? 'abstained' : mode, label: answer.choice, reason: 'VALIDATED_ADVISORY_ONLY', modelRevision: revision, confidence: typeof answer.confidence === 'number' ? answer.confidence : null, latencyMs: Date.now() - start };
            // Cache only with a pinned, verified model identity; confidence never grants rights.
            if (c.expectedRevision && revision === c.expectedRevision) {
                if (this.cache.size >= 512)
                    this.cache.delete(this.cache.keys().next().value!);
                this.cache.set(key, decision);
            }
            return decision;
        }
        catch (e) {
            if(epoch!==this.epoch||this.config().laya.mode==='off'||this.config().laya.roles[role]==='off')return result('off','DISABLED_IN_FLIGHT_RESULT_DISCARDED');
            this.failures++;
            if (this.failures >= 3)
                this.openUntil = Date.now() + 60000;
            return result('fallback', e instanceof DomainError ? e.code : signal?.aborted ? 'CANCELLED' : 'LAYA_TRANSPORT_UNAVAILABLE');
        }
        finally {
            this.inflight = null;
            this.queued--;
            release();
        }
    }
}
