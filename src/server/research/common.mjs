/** Shared validators. This package is called only from a trusted controller.
 * It does not authenticate users or replace the host app's session/CSRF system. */
import { createHash, randomUUID } from 'node:crypto';

export class GuardError extends Error {
  constructor(code, status = 409) { super(code); this.name = 'GuardError'; this.code = code; this.status = status; }
}
export function requireCondition(ok, code, status) { if (!ok) throw new GuardError(code, status); }
export const isRecord = x => x !== null && typeof x === 'object' && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
export function text(x, name, max = 2000, empty = false) {
  requireCondition(typeof x === 'string' && x.length <= max && (empty || x.trim().length > 0) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(x), `INVALID_${name}`, 400);
  return x;
}
export function id(x, name = 'ID') { text(x, name, 128); requireCondition(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(x), `INVALID_${name}`, 400); return x; }
export function integer(x, name, min = 0, max = Number.MAX_SAFE_INTEGER) { requireCondition(Number.isSafeInteger(x) && x >= min && x <= max, `INVALID_${name}`, 400); return x; }
export function oneOf(x, values, name) { requireCondition(values.includes(x), `INVALID_${name}`, 400); return x; }
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function digest(x) { return sha256(canonicalJson(x)); }
export function canonicalJson(x) {
  const seen = new WeakSet();
  function visit(v, depth) {
    requireCondition(depth <= 64, 'JSON_TOO_DEEP', 400);
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number') { requireCondition(Number.isFinite(v), 'JSON_NONFINITE', 400); return JSON.stringify(v); }
    requireCondition(Array.isArray(v) || isRecord(v), 'JSON_UNSUPPORTED_VALUE', 400);
    requireCondition(!seen.has(v), 'JSON_CYCLE', 400); seen.add(v);
    if (Array.isArray(v)) requireCondition(Object.keys(v).length===v.length && Array.from({length:v.length},(_,i)=>Object.hasOwn(v,i)).every(Boolean), 'JSON_SPARSE_ARRAY',400);
    const out = Array.isArray(v)
      ? '[' + v.map(a => visit(a, depth + 1)).join(',') + ']'
      : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + visit(v[k], depth + 1)).join(',') + '}';
    seen.delete(v); return out;
  }
  const result = visit(x, 0); requireCondition(Buffer.byteLength(result) <= 2_000_000, 'JSON_TOO_LARGE', 413); return result;
}
export const newId = prefix => `${prefix}_${randomUUID()}`;
export function hashValue(x, name = 'HASH') { requireCondition(typeof x === 'string' && /^[a-f0-9]{64}$/.test(x), `INVALID_${name}`, 400); return x; }
export function commitValue(x) { requireCondition(typeof x === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(x), 'UNPINNED_REVISION', 400); return x; }
export function validTime(x, name = 'TIME') { text(x, name, 40); requireCondition(Number.isFinite(Date.parse(x)) && /Z$/.test(x), `INVALID_${name}`, 400); return x; }
export function trustedActor(actor, type = 'user') {
  requireCondition(isRecord(actor) && actor.type === type, 'EXPLICIT_USER_ACTION_REQUIRED', 403);
  id(actor.id, 'ACTOR');
  // Host must obtain this actor from its own authenticated action, never JSON supplied by a model.
  return actor;
}
export const copy = x => structuredClone(x);
