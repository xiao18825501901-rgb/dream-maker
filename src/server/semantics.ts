import type { AcceptanceItem, Requirement, Spec } from '../shared/types.js';
import { choose, DomainError, hasSecret, object, text } from './security.js';

function fields(value: Record<string, unknown>, allowed: string[]) {
    if (Object.keys(value).some(key => !allowed.includes(key)))
        throw new DomainError('SEMANTIC_FIELD_NOT_ALLOWED');
}

export function validateSemanticRevision(spec: Spec, raw: unknown): { requirements: Requirement[]; acceptanceItems: AcceptanceItem[] } {
    const input = object(raw);
    fields(input, ['confirmed', 'requirements', 'acceptanceItems']);
    if (input.confirmed !== true)
        throw new DomainError('SEMANTIC_CONFIRMATION_REQUIRED', 403);
    if (!Array.isArray(input.requirements) || !Array.isArray(input.acceptanceItems) || input.acceptanceItems.length > 500)
        throw new DomainError('SEMANTIC_SCHEMA_INVALID');
    const classified = new Map<string, Requirement>();
    for (const item of input.requirements) {
        const value = object(item);
        fields(value, ['id', 'kind', 'priority']);
        const rid = text(value.id, 64), original = spec.requirements.find(r => r.id === rid);
        if (!original)
            throw new DomainError('SEMANTIC_REQUIREMENT_UNKNOWN');
        if (classified.has(rid))
            throw new DomainError('SEMANTIC_REQUIREMENT_DUPLICATE');
        classified.set(rid, { ...original, kind: choose(value.kind, ['unclassified', 'functional', 'nonfunctional', 'constraint', 'out-of-scope'] as const), priority: choose(value.priority, ['must', 'should']), classificationOrigin: 'USER_CONFIRMED' });
    }
    if (classified.size !== spec.requirements.length)
        throw new DomainError('SEMANTIC_REQUIREMENT_COVERAGE');
    const ids = new Set<string>();
    const acceptanceItems: AcceptanceItem[] = input.acceptanceItems.map(item => {
        const value = object(item);
        fields(value, ['id', 'requirementIds', 'criterion', 'method']);
        const id = text(value.id, 64), criterion = text(value.criterion, 2000);
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))
            throw new DomainError('ACCEPTANCE_ID_INVALID');
        if (ids.has(id))
            throw new DomainError('ACCEPTANCE_DUPLICATE');
        ids.add(id);
        if (hasSecret(criterion))
            throw new DomainError('SECRET_IN_ACCEPTANCE');
        if (!Array.isArray(value.requirementIds) || !value.requirementIds.length || value.requirementIds.length > spec.requirements.length)
            throw new DomainError('ACCEPTANCE_REFERENCE_INVALID');
        const requirementIds = value.requirementIds.map(r => text(r, 64));
        if (new Set(requirementIds).size !== requirementIds.length)
            throw new DomainError('ACCEPTANCE_REFERENCE_DUPLICATE');
        if (requirementIds.some(rid => !classified.has(rid)))
            throw new DomainError('ACCEPTANCE_REQUIREMENT_UNKNOWN');
        choose(value.method, ['manual']);
        return { id, requirementIds, criterion, method: 'manual', source: 'USER_CONFIRMED', evidenceStatus: 'NOT_RUN' };
    });
    const requirements = spec.requirements.map(r => classified.get(r.id)!);
    if (requirements.some(r => r.priority === 'must' && !acceptanceItems.some(a => a.requirementIds.includes(r.id))))
        throw new DomainError('MUST_ACCEPTANCE_MISSING');
    return { requirements, acceptanceItems };
}
