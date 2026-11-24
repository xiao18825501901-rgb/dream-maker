/** Pure plan validation extracted from the verified kit. No database or approval authority. */
import {requireCondition as need,isRecord,text,id,oneOf,canonicalJson,hashValue} from './common.mjs';
export function validatePlanBody(body) {
  need(isRecord(body), 'INVALID_PLAN'); text(body.goal, 'PLAN_GOAL', 6000);
  need(Array.isArray(body.requirements) && body.requirements.length > 0 && body.requirements.length <= 200, 'REQUIREMENTS_REQUIRED');
  const reqs = new Set();
  for (const r of body.requirements) {
    id(r.id, 'REQUIREMENT_ID'); need(!reqs.has(r.id), 'DUPLICATE_REQUIREMENT'); reqs.add(r.id); text(r.text, 'REQUIREMENT_TEXT', 20000);
    oneOf(r.origin, ['USER','AI_SUGGESTION','ASSUMPTION'], 'REQUIREMENT_ORIGIN');
    need(Array.isArray(r.sources), 'SOURCE_REFERENCES_REQUIRED'); r.sources.forEach(x => text(x, 'SOURCE_REFERENCE', 512));
  }
  need(Array.isArray(body.acceptance) && body.acceptance.length > 0 && body.acceptance.length <= 200, 'ACCEPTANCE_REQUIRED');
  const ac = new Set(), covered = new Set();
  for (const a of body.acceptance) {
    id(a.id, 'ACCEPTANCE_ID'); need(!ac.has(a.id), 'DUPLICATE_ACCEPTANCE'); ac.add(a.id); text(a.check, 'ACCEPTANCE_CHECK', 4000);
    need(Array.isArray(a.requirementIds) && a.requirementIds.length > 0 && a.requirementIds.every(x => reqs.has(x)), 'ACCEPTANCE_REQUIREMENTS_INVALID');
    a.requirementIds.forEach(x => covered.add(x));
  }
  need(covered.size === reqs.size, 'REQUIREMENT_WITHOUT_ACCEPTANCE');
  for (const k of ['architecture','delivery']) { need(isRecord(body[k]) && Object.keys(body[k]).length > 0, `PLAN_${k.toUpperCase()}_REQUIRED`); }
  for (const k of ['milestones','assumptions','unknowns','outOfScope']) need(Array.isArray(body[k]), `PLAN_${k.toUpperCase()}_REQUIRED`);
  need(body.milestones.length > 0, 'MILESTONES_REQUIRED');
  need(isRecord(body.research) && ['SEARCHED_WITHIN_BOUNDS','PARTIAL','UNAVAILABLE','USER_IMPORTED_PLAN'].includes(body.research.status), 'RESEARCH_RESULT_REQUIRED');
  need(Array.isArray(body.research.sourceRefs), 'RESEARCH_SOURCES_REQUIRED');
  oneOf(body.reuse?.mode, ['ADAPT_PROJECT','REUSE_COMPONENTS','IMPLEMENT_ORIGINAL'], 'REUSE_MODE');
  need(Array.isArray(body.reuse.selected), 'REUSE_SELECTION_REQUIRED');
  if (body.reuse.mode === 'IMPLEMENT_ORIGINAL') need(body.reuse.selected.length === 0, 'ORIGINAL_PLAN_HAS_REUSE');
  else {
    need(body.reuse.selected.length > 0, 'REUSE_SELECTION_REQUIRED');
    for (const x of body.reuse.selected) {
      text(x.webUrl, 'SOURCE_URL', 1024); need(/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(x.commit), 'REUSE_NOT_PINNED');
      hashValue(x.snapshotHash); need(Array.isArray(x.obligations) && x.obligations.length > 0, 'REUSE_OBLIGATIONS_REQUIRED');
    }
  }
  canonicalJson(body); return body;
}
