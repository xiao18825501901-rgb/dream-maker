import type { Project, RequirementsDraft, RequirementsDraftDocument } from '../shared/types.js';
import { DomainError, hash, id, now, object, text, hasSecret } from './security.js';
import { compileSpec } from './compile.js';

/**
 * The Seeker requirements draft ("需求稿").
 *
 * The pinned prompt-optimizer body asks for exactly this document, so the draft is the optimizer's
 * output and nothing else is invented on top of it. Three rules hold everywhere here:
 *  - original requirement text is retained byte for byte by the *compiler*, never by the model;
 *  - what the model adds is labelled AI_SUGGESTION and can never masquerade as a user answer;
 *  - a draft is editable, every edit is a new immutable version, and only an exact version hash can
 *    be confirmed. No draft step can approve a spec or start a flow.
 */
export const REQUIREMENTS_DRAFT_TASK = 'requirements_draft';
export const DRAFT_LIST_FIELDS = ['assumptions', 'conflicts', 'implementation_guidance', 'acceptance_candidates', 'residual_risks'] as const;

function stringList(value: unknown, field: string, max = 40, maxLength = 4000): string[] {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > max)
        throw new DomainError('REQUIREMENTS_DRAFT_INVALID', 502, '需求稿字段 ' + field + ' 必须是长度不超过 ' + max + ' 的数组。');
    const list = value.map(item => text(item, maxLength));
    if (list.some(item => hasSecret(item)))
        throw new DomainError('REQUIREMENTS_DRAFT_SECRET', 502);
    return list;
}

/** The original requirement texts the compiler already derived from the project. Never model output. */
export function compiledRequirementTexts(project: Project): { id: string; text: string }[] {
    return compileSpec(project, 1).requirements.map(r => ({ id: r.id, text: r.text }));
}

/** The request the optimizer body answers. The project name rides along so no second title call is needed. */
export function buildRequirementsDraftRequest(project: Project, notes: string): Record<string, unknown> {
    return {
        task: REQUIREMENTS_DRAFT_TASK,
        name: project.name,
        idea: project.idea,
        interviewMode: project.interviewMode ?? 'INITIAL',
        questions: project.questions.map(q => ({ id: q.id, topic: q.topic, text: q.text })),
        answers: project.answers.map(a => ({ questionId: a.questionId, status: a.status, text: a.text, optionIds: a.optionIds ?? [], customText: a.customText ?? '' })),
        originalRequirements: compiledRequirementTexts(project),
        notes: text(notes, 12000, true),
        alternativeContext: project.alternativeContext ?? null,
        instruction: 'Compile the owner\'s own words and interview answers into an editable requirements draft. Return JSON {summary, assumptions, conflicts, implementation_guidance, acceptance_candidates, residual_risks, requirementEdits:[{id,text}]}. Every string must be concrete. assumptions are labelled suggestions, never user answers. conflicts must stay conflicts. requirementEdits may only shorten or clarify an existing originalRequirements entry; never delete one, never invent a new id, never restate the owner\'s words as your own decision. No tools, no execution, no approval, no charges.',
    };
}

export function normalizeDraftDocument(raw: unknown): RequirementsDraftDocument {
    const data = object(raw);
    const document: RequirementsDraftDocument = {
        summary: text(data.summary, 6000),
        assumptions: stringList(data.assumptions, 'assumptions'),
        conflicts: stringList(data.conflicts, 'conflicts'),
        implementation_guidance: stringList(data.implementation_guidance, 'implementation_guidance', 30),
        acceptance_candidates: stringList(data.acceptance_candidates, 'acceptance_candidates', 30),
        residual_risks: stringList(data.residual_risks, 'residual_risks', 30),
    };
    if (hasSecret(JSON.stringify(document)))
        throw new DomainError('REQUIREMENTS_DRAFT_SECRET', 502);
    return document;
}

function applyModelEdits(project: Project, data: Record<string, unknown>): RequirementsDraft['requirements'] {
    const originals = compiledRequirementTexts(project);
    const byId = new Map(originals.map(r => [r.id, r.text]));
    // A model may only clarify an existing requirement; an unknown id is a contract violation.
    const list = Array.isArray(data.requirementEdits) ? data.requirementEdits as unknown[] : [];
    const edited = new Map<string, string>();
    for (const raw of list) {
        const item = object(raw), rid = text(item.id, 40);
        if (!byId.has(rid))
            throw new DomainError('REQUIREMENTS_DRAFT_REQUIREMENT_UNKNOWN', 502);
        const next = text(item.text, 4000);
        if (hasSecret(next))
            throw new DomainError('REQUIREMENTS_DRAFT_SECRET', 502);
        edited.set(rid, next);
    }
    // The original text is retained; a model edit is recorded as a separate AI_SUGGESTION line so the
    // owner sees both and decides. Nothing is silently rewritten.
    return originals.map(original => ({
        id: original.id,
        text: edited.has(original.id) ? original.text + '\nAI_SUGGESTION：' + edited.get(original.id)! : original.text,
        origin: 'USER' as const,
    }));
}

/** The interview input a draft describes. Editing an answer changes it; saving a pointer does not. */
export function draftInputHash(project: Project): string {
    return hash({
        idea: project.idea,
        alternativeContext: project.alternativeContext ?? null,
        questions: project.questions.map(q => ({ id: q.id, text: q.text })),
        answers: project.answers.map(a => ({ id: a.id, questionId: a.questionId, status: a.status, text: a.text, revision: a.revision })),
        answersHistory: project.answerHistory.map(a => a.id),
    });
}

/** A draft only describes the interview it was compiled from. */
export function draftIsCurrent(draft: Pick<RequirementsDraft, 'inputHash'>, project: Project): boolean {
    return draft.inputHash === draftInputHash(project);
}

export function draftFromModel(project: Project, raw: unknown, actor: string, previous?: RequirementsDraft | null): RequirementsDraft {
    const data = object(raw);
    const document = normalizeDraftDocument(data);
    const requirements = applyModelEdits(project, data);
    const draft: RequirementsDraft = {
        id: id('draft'), projectId: project.id, version: (previous?.version ?? 0) + 1, parentId: previous?.id ?? null, origin: 'MODEL',
        document, requirements,
        sourceAnswerIds: project.answers.filter(a => a.status === 'answered').map(a => a.id),
        inputHash: draftInputHash(project),
        contentHash: '', at: now(), actor,
    };
    draft.contentHash = draftContentHash(draft);
    return draft;
}

export function draftContentHash(draft: Pick<RequirementsDraft, 'document' | 'requirements' | 'sourceAnswerIds' | 'inputHash'>): string {
    return hash({ document: draft.document, requirements: draft.requirements, sourceAnswerIds: draft.sourceAnswerIds, inputHash: draft.inputHash });
}

/** One owner edit = one new immutable version. No model request, no charge, no approval. */
export function reviseDraft(previous: RequirementsDraft, raw: unknown, actor: string): RequirementsDraft {
    const input = object(raw);
    const document = normalizeDraftDocument(input.document ?? previous.document);
    const originals = new Map(previous.requirements.map(r => [r.id, r.text.split('\nAI_SUGGESTION：')[0]]));
    const rawList = input.requirements;
    let requirements: RequirementsDraft['requirements'];
    if (rawList === undefined)
        requirements = previous.requirements.map(r => ({ ...r }));
    else {
        if (!Array.isArray(rawList) || rawList.length !== previous.requirements.length)
            throw new DomainError('REQUIREMENTS_DRAFT_REQUIREMENTS_INCOMPLETE', 400, '编辑需求稿时必须保留原有的每一条需求编号。');
        requirements = rawList.map(rawItem => {
            const item = object(rawItem), rid = text(item.id, 40);
            if (!originals.has(rid))
                throw new DomainError('REQUIREMENTS_DRAFT_REQUIREMENT_UNKNOWN', 400);
            const value = text(item.text, 4000);
            if (hasSecret(value))
                throw new DomainError('REQUIREMENTS_DRAFT_SECRET', 400);
            return { id: rid, text: value, origin: 'USER' as const };
        });
        if (new Set(requirements.map(r => r.id)).size !== requirements.length)
            throw new DomainError('REQUIREMENTS_DRAFT_REQUIREMENT_DUPLICATE', 400);
    }
    const draft: RequirementsDraft = {
        id: id('draft'), projectId: previous.projectId, version: previous.version + 1, parentId: previous.id,
        origin: 'USER', document, requirements, sourceAnswerIds: [...previous.sourceAnswerIds],
        inputHash: previous.inputHash,
        contentHash: '', at: now(), actor,
    };
    if (hasSecret(JSON.stringify(draft)))
        throw new DomainError('REQUIREMENTS_DRAFT_SECRET', 400);
    draft.contentHash = draftContentHash(draft);
    return draft;
}

/** Only the exact version the owner looked at can be confirmed. */
export function assertConfirmable(draft: RequirementsDraft, expectedHash: string): void {
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash) || draft.contentHash !== expectedHash)
        throw new DomainError('REQUIREMENTS_DRAFT_STALE', 409, '这份需求稿已经变了；请重新查看当前版本再确认。');
}

/** The confirmed draft becomes the compiler summary plus the final requirement texts of the spec. */
export function draftSummary(draft: RequirementsDraft): Record<string, unknown> {
    return {
        summary: draft.document.summary,
        assumptions: draft.document.assumptions,
        conflicts: draft.document.conflicts,
        implementation_guidance: draft.document.implementation_guidance,
        acceptance_candidates: draft.document.acceptance_candidates,
        residual_risks: draft.document.residual_risks,
    };
}

/** Requirement texts confirmed by the owner, keyed by the compiled spec's own ids. */
export function draftRequirementOverrides(draft: RequirementsDraft): Map<string, string> {
    return new Map(draft.requirements.filter(r => r.origin === 'USER').map(r => [r.id, r.text]));
}

/**
 * The frozen requirement text of a confirmed draft, with the model's clarification split off. A
 * spec's USER requirement must contain only what the owner confirmed; the suggestion travels in the
 * notes instead of silently becoming part of the requirement.
 */
export function confirmedRequirementTexts(draft: RequirementsDraft): Map<string, { text: string; suggestion: string | null }> {
    const out = new Map<string, { text: string; suggestion: string | null }>();
    for (const r of draft.requirements.filter(item => item.origin === 'USER')) {
        const parts = r.text.split('\nAI_SUGGESTION：');
        const [text, ...suggestion] = parts;
        out.set(r.id, { text, suggestion: suggestion.length ? suggestion.join(' ') : null });
    }
    return out;
}
