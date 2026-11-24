/**
 * A frozen spec is only worth approving if its requirements actually decide something.
 *
 * Why this exists: `compileSpec` records each requirement as "question" + "用户回答：answer", so a
 * question whose answer was never really answered stays in the spec looking settled. Two rounds of
 * engineering were spent discovering that such a spec cannot yield a trusted verifier plan. This makes
 * the gap visible at SPEC_REVIEW instead of at verification time.
 *
 * The rule is deliberately narrow, because a false alarm here would train the owner to ignore it:
 *  - a requirement with no answer part is flagged when it still reads like a question, and
 *  - a requirement whose answer is shorter than MIN_ANSWER is flagged, because a two-character answer
 *    ('ok') is not a decision the verifier could ever assert.
 * Acceptance items clear a requirement: a confirmed acceptance criterion IS the decision.
 */
export interface DecidabilityRequirement {
    id: string;
    text: string;
}

export interface DecidabilitySpec {
    requirements?: DecidabilityRequirement[];
    acceptanceItems?: { requirementIds?: string[] }[];
}

export const MIN_ANSWER = 20;

const ANSWER_MARKER = /用户回答\s*[:：]/;

function answerPart(text: string): string | null {
    const marker = ANSWER_MARKER.exec(text);
    if (!marker) return null;
    return text.slice(marker.index + marker[0].length).trim();
}

function asksForDecision(text: string): boolean {
    const value = String(text ?? '').trim();
    if (!value) return false;
    return /[?？]\s*$/.test(value) || /请[^。；]{0,12}(决定|明确|二选一|给出|回答|选择|确认)/.test(value);
}

export function looksUndecided(text: string): boolean {
    const value = String(text ?? '').trim();
    if (!value) return false;
    const answer = answerPart(value);
    if (answer === null) return asksForDecision(value);
    return answer.length < MIN_ANSWER;
}

/** Requirement ids that are still open questions and are not covered by any acceptance item. */
export function undecidedRequirements(spec: DecidabilitySpec | null | undefined): string[] {
    const requirements = Array.isArray(spec?.requirements) ? spec!.requirements! : [];
    const covered = new Set<string>();
    for (const item of Array.isArray(spec?.acceptanceItems) ? spec!.acceptanceItems! : [])
        for (const id of Array.isArray(item?.requirementIds) ? item!.requirementIds! : []) covered.add(String(id));
    return requirements
        .filter(r => typeof r?.id === 'string' && !covered.has(r.id) && looksUndecided(r.text))
        .map(r => r.id);
}
