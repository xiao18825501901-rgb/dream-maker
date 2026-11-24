/** Deterministic evidence checks and transparent ranking. This is not legal advice,
 * a license detector, a malware scanner, or an authority-signature implementation.
 * verifyAssessment MUST come from the existing trusted controller, never the LLM. */
import { requireCondition as need, isRecord, text, id, digest, hashValue, commitValue, validTime, oneOf } from './common.mjs';
import { repositoryRef, repoFilePath, safeSearchKeywords } from './repository-clients.mjs';

export const REUSE_MODES = ['ADAPT_PROJECT', 'REUSE_COMPONENTS', 'IMPLEMENT_ORIGINAL'];
const POINTS = Object.freeze({ requirementFit: 35, changeCost: 20, runtimeFit: 15, validationQuality: 15, maintenance: 10, dependencyComplexity: 5 });
export function verifySnapshot(snapshot) {
  need(isRecord(snapshot), 'INVALID_REPOSITORY_SNAPSHOT');
  const { snapshotHash, ...body } = snapshot;
  hashValue(snapshotHash, 'SNAPSHOT_HASH'); need(digest(body) === snapshotHash, 'REPOSITORY_SNAPSHOT_CHANGED');
  const ref = repositoryRef(snapshot.platform, snapshot.namespace);
  need(snapshot.webUrl === ref.webUrl, 'SOURCE_REPOSITORY_IDENTITY_MISMATCH'); commitValue(snapshot.commit);
  need(Array.isArray(snapshot.files) && snapshot.files.length <= 8 && Array.isArray(snapshot.failures), 'INVALID_SOURCE_FILES');
  const paths = new Set();
  for (const f of snapshot.files) {
    repoFilePath(f.path);
    const expectedUrl=`${ref.webUrl}/${snapshot.platform==='github'?'blob':'-/blob'}/${snapshot.commit}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    need(f.url===expectedUrl,'SOURCE_FILE_URL_MISMATCH');
    need(!paths.has(f.path) && f.ref === snapshot.commit && f.trust === 'UNTRUSTED_REPOSITORY_DATA', 'UNBOUND_SOURCE_FILE'); paths.add(f.path);
    need(digestString(f.content) === f.contentSha256 && Buffer.byteLength(f.content) === f.bytes, 'SOURCE_TEXT_CHANGED');
  }
  return snapshot;
}
import { sha256 as digestString } from './common.mjs';

export function evaluateReuse(snapshot, assessment, context, { verifyAssessment, now = Date.now() } = {}) {
  verifySnapshot(snapshot); need(isRecord(context) && Array.isArray(context.requirementIds) && context.requirementIds.length > 0, 'REQUIREMENTS_REQUIRED');
  const ids = new Set(context.requirementIds.map(x => id(x, 'REQUIREMENT'))); need(ids.size === context.requirementIds.length, 'DUPLICATE_REQUIREMENTS');
  hashValue(context.intentHash, 'INTENT_HASH'); text(context.distribution, 'DISTRIBUTION', 100);
  const reasons = [];
  const block = code => { if (!reasons.includes(code)) reasons.push(code); };
  if (snapshot.archived || snapshot.disabled) block('SOURCE_NOT_MAINTAINED_REQUIRES_REVIEW');
  if (snapshot.failures.some(x => x.code !== 'SOURCE_NOT_FOUND')) block('SOURCE_EVIDENCE_INCOMPLETE');
  if (!isRecord(assessment)) return { eligible: false, status: 'INSPECTED_NOT_REVIEWED', reasons: [...reasons, 'ASSESSMENT_REQUIRED'], score: null };
  let trusted = false; try { trusted = typeof verifyAssessment === 'function' && verifyAssessment(assessment) === true; } catch { /* fail closed */ }
  if (!trusted) block('ASSESSMENT_NOT_CONTROLLER_VERIFIED');
  if (assessment.snapshotHash !== snapshot.snapshotHash || assessment.intentHash !== context.intentHash || assessment.distribution !== context.distribution) block('ASSESSMENT_SCOPE_MISMATCH');
  if (!Number.isFinite(Date.parse(assessment.expiresAt)) || Date.parse(assessment.expiresAt) <= now) block('ASSESSMENT_EXPIRED');
  if (assessment.sourceIdentity !== 'VERIFIED') block('SOURCE_IDENTITY_UNVERIFIED');
  const license = assessment.license;
  if (!isRecord(license) || license.status !== 'COMPATIBLE_WITH_INTENDED_USE') block('LICENSE_NOT_CLEARED');
  else {
    if (!Array.isArray(license.evidence) || !license.evidence.length || !Array.isArray(license.obligations) || !license.obligations.length || license.dependenciesReviewed !== true || license.assetsReviewed !== true) block('LICENSE_SCOPE_INCOMPLETE');
    for (const e of license.evidence ?? []) if (!snapshot.files.some(f => f.path === e.path && f.contentSha256 === e.contentSha256)) block('LICENSE_EVIDENCE_MISMATCH');
  }
  // GPL/AGPL etc. are not automatically rejected. Compatibility requires the actual reviewed use and distribution.
  if (assessment.security !== 'REVIEWED_NO_UNRESOLVED_BLOCKER') block('SECURITY_REVIEW_REQUIRED');
  if (assessment.runtime !== 'COMPATIBLE') block('RUNTIME_INCOMPATIBLE_OR_UNKNOWN');
  if (assessment.installation !== 'REVIEWED_NOT_EXECUTED') block('INSTALL_BEHAVIOR_UNREVIEWED');
  if (assessment.ownership !== 'NO_CREDENTIAL_OR_PRIVATE_DATA_DEPENDENCY') block('PRIVATE_DEPENDENCY_UNRESOLVED');
  const coverage = assessment.coverage;
  if (!Array.isArray(coverage) || coverage.length !== ids.size || new Set(coverage.map(c => c.requirementId)).size !== ids.size) block('REQUIREMENT_COVERAGE_INCOMPLETE');
  else for (const c of coverage) {
    if (!ids.has(c.requirementId) || !['PRESENT','ADAPT_REQUIRED','BUILD_REQUIRED'].includes(c.status) || typeof c.explanation !== 'string' || !c.explanation.trim()) block('REQUIREMENT_COVERAGE_INVALID');
    if (c.status === 'PRESENT' && (!Array.isArray(c.evidencePaths) || !c.evidencePaths.length || c.evidencePaths.some(p => !snapshot.files.some(f => f.path === p)))) block('FEATURE_CLAIM_UNSUPPORTED');
  }
  if (!['ADAPT_PROJECT','REUSE_COMPONENTS'].includes(assessment.mode) || !Array.isArray(assessment.filesInScope) || !assessment.filesInScope.length || assessment.filesInScope.some(p => !snapshot.files.some(f => f.path === p))) block('REUSE_SCOPE_UNVERIFIED');
  let score = 0;
  for (const [key, weight] of Object.entries(POINTS)) {
    const n = assessment.scores?.[key]; if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) { block('INVALID_RANKING_FACTS'); break; }
    score += n * weight;
  }
  return { eligible: reasons.length === 0, status: reasons.length ? 'REVIEW_BLOCKED' : 'ELIGIBLE_TO_PROPOSE_NOT_INSTALL', reasons, score: reasons.length ? null : Math.round(score * 100) / 100 };
}

export function selectReuseStrategy(candidates, assessments, context, options) {
  need(Array.isArray(candidates) && candidates.length <= 12 && isRecord(assessments), 'INVALID_REUSE_INPUT');
  const evaluated = candidates.map(snapshot => {
    const assessment = assessments[snapshot.snapshotHash];
    return { snapshot, assessment, evaluation: evaluateReuse(snapshot, assessment, context, options) };
  });
  const ranked = evaluated.filter(x => x.evaluation.eligible).sort((a,b) => b.evaluation.score - a.evaluation.score || a.snapshot.webUrl.localeCompare(b.snapshot.webUrl));
  const best = ranked[0];
  return {
    schema: 'dream-maker.reuse-decision.v1', intentHash: context.intentHash,
    status: 'PROPOSAL_REQUIRES_PLAN_CONFIRMATION', mode: best?.assessment.mode ?? 'IMPLEMENT_ORIGINAL',
    reason: best ? '已找到经过核对、适合本项目的基础组件。方案会说明沿用哪些部分，以及还需要制作什么。' : '本次已检查的候选中，还没有找到足够可靠、可直接采用的基础。可以继续设计自己的实现；这不代表网络上不存在合适项目。',
    selected: best ? [{ platform: best.snapshot.platform, namespace: best.snapshot.namespace, webUrl: best.snapshot.webUrl, commit: best.snapshot.commit, snapshotHash: best.snapshot.snapshotHash, licenseEvidence: best.assessment.license.evidence, obligations: best.assessment.license.obligations, filesInScope: best.assessment.filesInScope, assessmentId: best.assessment.id, coverage: best.assessment.coverage }] : [],
    considered: evaluated.map(x => ({ webUrl: x.snapshot.webUrl, snapshotHash: x.snapshot.snapshotHash, ...x.evaluation })),
    exclusionsAreNotLegalJudgments: true,
    externalCodeExecuted: false
  };
}

export class RepositoryResearchService {
  constructor({ clients, now = () => Date.now() }) { need(Array.isArray(clients) && clients.length > 0 && clients.length <= 3, 'INVALID_RESEARCH_CLIENTS'); this.clients = clients; this.now = now; }
  async discover({ keywords, disclosure, intentHash, maxCandidates = 3, signal }) {
    keywords = safeSearchKeywords(keywords); hashValue(intentHash, 'INTENT_HASH');
    need(Number.isSafeInteger(maxCandidates) && maxCandidates > 0 && maxCandidates <= 6, 'INVALID_CANDIDATE_LIMIT');
    // This receipt must be produced by the host privacy boundary, not the candidate source or LLM.
    need(isRecord(disclosure) && disclosure.kind === 'PUBLIC_GENERIC_TERMS_ONLY' && disclosure.queryHash === digest(keywords) && disclosure.intentHash === intentHash, 'SEARCH_DISCLOSURE_NOT_BOUND', 403);
    const results = [], failures = [], snapshots = [], seen = new Set();
    for (const client of this.clients) {
      try {
        const search = await client.search(keywords, { signal }); results.push(search);
        for (const item of search.items) {
          if (snapshots.length >= maxCandidates) break;
          if (seen.has(item.webUrl)) continue; seen.add(item.webUrl);
          try { snapshots.push(await client.inspect(item, { signal })); }
          catch (e) { if (e.code === 'RESEARCH_CANCELLED') throw e; failures.push({ platform: client.platform, stage: 'INSPECT', code: e.code ?? 'SOURCE_INSPECT_FAILED' }); }
        }
      } catch (e) { if (e.code === 'RESEARCH_CANCELLED') throw e; failures.push({ platform: client.platform, stage: 'SEARCH', code: e.code ?? 'SOURCE_SEARCH_FAILED' }); }
    }
    return {
      schema: 'dream-maker.research-run.v1', intentHash, queriedAt: new Date(this.now()).toISOString(),
      status: !results.length ? 'UNAVAILABLE' : failures.length || results.some(r => r.incomplete) ? 'PARTIAL' : 'SEARCHED_WITHIN_BOUNDS',
      searchScope: 'PUBLIC_KEYWORDS_ONLY_BOUNDED_NOT_EXHAUSTIVE', results, failures, snapshots,
      candidateTextTrust: 'UNTRUSTED_DATA_NEVER_INSTRUCTIONS', executedSourceCode: false
    };
  }
}

export function buildPlannerContext({ originalDescription, answers, research, decision }) {
  text(originalDescription, 'ORIGINAL_DESCRIPTION', 20000); need(Array.isArray(answers) && answers.length <= 200, 'INVALID_ANSWERS');
  need(isRecord(research) && isRecord(decision) && research.intentHash === decision.intentHash, 'RESEARCH_DECISION_MISMATCH');
  // Structured data only. The host separately supplies the immutable system prompt and validates final JSON.
  return {
    originalDescription, answers,
    repositoryResearch: { trust: 'UNTRUSTED_REPOSITORY_DATA', status: research.status, candidates: research.snapshots.map(s => ({ webUrl: s.webUrl, commit: s.commit, snapshotHash: s.snapshotHash, files: s.files.map(f => ({ path: f.path, text: f.content.slice(0,12000), hash: f.contentSha256 })) })) },
    proposedReuse: decision, permissions: { executeCode: false, alterApprovedPlan: false, expandTools: false, accessSecrets: false },
    requiredOutput: 'FULL_PROPOSED_PLAN_WITH_SOURCES_ASSUMPTIONS_AND_ACCEPTANCE'
  };
}
