import type { AcceptanceItem, Requirement } from '../shared/types.js';
import { DomainError, object, text } from './security.js';
import type { VerifierPlan } from './wsl-verifier.js';

type AcceptanceSpec = {
    hash: string;
    requirements: Pick<Requirement, 'id'>[];
    acceptanceItems?: Pick<AcceptanceItem, 'id' | 'requirementIds' | 'criterion' | 'method'>[];
};

type ObservedCase = {
    id: string;
    acceptanceIds?: string[];
    requirementIds: string[];
    ok: boolean;
    status: string;
};

const STATUSES = ['EXECUTED', 'TIMED_OUT', 'CANCELLED', 'OUTPUT_LIMIT', 'MEMORY_LIMIT'] as const;

function invalid(reason: string): never {
    throw new DomainError('ACCEPTANCE_EVIDENCE_INVALID', 409, reason);
}

function sameStrings(left: readonly string[], right: readonly string[]) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Project owner-confirmed acceptance items onto explicitly declared controller
 * cases. This never mutates the frozen spec and never promotes a manual item to
 * human acceptance.
 */
export function buildAcceptanceEvidence(input: {
    spec: AcceptanceSpec;
    plan: VerifierPlan;
    observed: readonly unknown[];
    evidenceId: string;
    planHash: string;
    sourceHash: string;
}) {
    if (input.spec.hash !== input.plan.specHash || !/^[a-f0-9]{64}$/.test(input.planHash) || !/^[a-f0-9]{64}$/.test(input.sourceHash))
        invalid('binding');
    const required = new Set(input.spec.requirements.map(item => text(item.id, 64)));
    const items = input.spec.acceptanceItems ?? [];
    const ids = new Set<string>();
    for (const item of items) {
        const id = text(item.id, 64);
        if (ids.has(id) || !Array.isArray(item.requirementIds) || !item.requirementIds.length ||
            item.requirementIds.some(requirement => !required.has(requirement)) || item.method !== 'manual')
            invalid('acceptance definition');
        ids.add(id);
    }
    const observed = new Map<string, ObservedCase>();
    for (const raw of input.observed) {
        const value = object(raw), id = text(value.id, 80);
        if (observed.has(id) || typeof value.ok !== 'boolean' || !STATUSES.includes(value.status as typeof STATUSES[number]) ||
            !Array.isArray(value.requirementIds) || value.requirementIds.some(requirement => typeof requirement !== 'string' || !required.has(requirement)))
            invalid('observed case');
        const acceptanceIds = Object.hasOwn(value, 'acceptanceIds')
            ? Array.isArray(value.acceptanceIds) && value.acceptanceIds.every(acceptanceId => typeof acceptanceId === 'string')
                ? [...value.acceptanceIds] as string[]
                : invalid('observed acceptance binding')
            : undefined;
        observed.set(id, {id, requirementIds: [...value.requirementIds] as string[], ok: value.ok, status: String(value.status), ...(acceptanceIds ? {acceptanceIds} : {})});
    }

    const projected = items.map(item => {
        const cases = input.plan.cases.filter(candidate => candidate.acceptanceIds?.includes(item.id) === true);
        const results = cases.map(candidate => {
            const actual = observed.get(candidate.id) ?? invalid('mapped case missing');
            if (!sameStrings(actual.requirementIds, candidate.requirementIds) ||
                !sameStrings(actual.acceptanceIds ?? [], candidate.acceptanceIds ?? []))
                invalid('mapped case binding');
            return {
                caseId: candidate.id,
                requirementIds: [...candidate.requirementIds],
                acceptanceIds: [...(candidate.acceptanceIds ?? [])],
                status: actual.status,
                ok: actual.ok && actual.status === 'EXECUTED',
            };
        });
        const executableEvidenceStatus = !results.length
            ? 'NOT_RUN' as const
            : results.every(result => result.ok)
                ? 'PASS' as const
                : 'FAIL' as const;
        return {
            id: item.id,
            requirementIds: [...item.requirementIds],
            criterion: item.criterion,
            method: 'manual' as const,
            caseIds: cases.map(candidate => candidate.id),
            cases: results,
            executableEvidenceStatus,
            manualAcceptanceStatus: 'NOT_RUN' as const,
        };
    });
    const coverage = {
        acceptanceItems: projected.length,
        withExecutableEvidence: projected.filter(item => item.caseIds.length > 0).length,
        withoutExecutableEvidence: projected.filter(item => item.caseIds.length === 0).length,
        passedExecutableEvidence: projected.filter(item => item.executableEvidenceStatus === 'PASS').length,
        failedExecutableEvidence: projected.filter(item => item.executableEvidenceStatus === 'FAIL').length,
    };
    return {
        schema: 'dream-maker.acceptance-evidence.v1' as const,
        specHash: input.spec.hash,
        planHash: input.planHash,
        sourceHash: input.sourceHash,
        evidenceId: input.evidenceId,
        items: projected,
        coverage,
        limitations: [
            'PASS means every explicitly mapped executable case ran successfully for the bound source hash.',
            'It does not replace the USER_CONFIRMED manual acceptance review.',
            'Acceptance items without an explicit case mapping remain NOT_RUN.',
        ],
    };
}
