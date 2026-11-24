import type { Project, Spec, Run, Config, Event as RunEvent } from '../shared/types.js';
import type { ResearchOperation } from '../shared/research.js';
import type { PlanningEvent } from '../shared/project-plan.js';
import { ROLE_WIRE_IDS, roleMetadata } from '../shared/role-names.js';
export function semanticRows(spec: Spec) {
  const used = new Set((spec.acceptanceItems ?? []).map(item => item.id));
  let sequence = 1;
  return spec.requirements.map(requirement => {
    const existing = spec.acceptanceItems?.find(item => item.requirementIds.length === 1 && item.requirementIds[0] === requirement.id);
    if (existing) return { requirement, item: { id: existing.id, criterion: existing.criterion } };
    while (used.has('A' + sequence)) sequence++;
    const id = 'A' + sequence++; used.add(id);
    return { requirement, item: { id, criterion: '' } };
  });
}
export function semanticPayload(spec: Spec, value: (key: string) => string, confirmed: boolean) {
  const rows = semanticRows(spec), editedIds = new Set(rows.map(row => row.item.id));
  const acceptanceItems = (spec.acceptanceItems ?? []).filter(item => !editedIds.has(item.id))
    .map(({ id, requirementIds, criterion, method }) => ({ id, requirementIds: [...requirementIds], criterion, method }));
  for (const { requirement, item } of rows) {
    const criterion = value('criterion-' + requirement.id).trim();
    if (criterion) acceptanceItems.push({ id: item.id, requirementIds: [requirement.id], criterion, method: 'manual' });
  }
  return { specHash: spec.hash, confirmed, requirements: spec.requirements.map(r => ({ id: r.id, kind: value('kind-' + r.id), priority: value('priority-' + r.id) })), acceptanceItems };
}
export type RunView=Run&{mergeRecoveryRequired?:boolean;executorCheckpointRequired?:boolean;reviewPreparationCandidate?:{kind:'SOURCE_VERSION';sourceHash:string;version:number}|null;reviewWindowCandidate?:{kind:'EXPIRED_REVIEW_WINDOW';sourceHash:string;version:number;maxSeconds:7200}|null};
export interface Snapshot { project: Project; spec: Spec | null; runs: RunView[]; records: { id: string; kind: string; runId: string | null; data: unknown; at: string }[]; research?:ResearchOperation[];planning?:PlanningEvent[];flowOptions?:FlowBlock[];status?:{laya?:import('./flow-workspace-view.js').LayaSummaryView|null} }
export type BrowserConfig = Omit<Config, 'clash'> & { clash: Omit<Config['clash'], 'configPath'> };
/** Exactly two new engineering modes; Laya is an option within classic. */
export interface FlowBlock {
    name: 'classic' | 'custom';
    label: string;
    roles: string[];
    layaCoupled: boolean;
    layaMode: 'off' | 'shadow' | 'advisory';
    layaRoles: Record<string, 'inherit' | 'off'>;
    blockedBy: '' | 'FLOW_UNKNOWN' | 'LAYA_DISABLED' | 'LAYA_ROLES_INCOMPLETE' | 'NATIVE_LAYA_BASELINE_REQUIRED' | 'NATIVE_LAYA_QUALIFICATION_REQUIRED' | 'CUSTOM_MAGPIE_SECURITY_REQUIRED' | 'CUSTOM_ROLE_QUALIFICATION_REQUIRED';
    setupAllowed?:boolean;
    layaAvailable?:boolean;
    liveAllowed: boolean;
    reason: string;
}
export interface PublicConfig {
    config: BrowserConfig;
    /** Resolved by the server; absent in the public demo, which has no local flows. */
    flows?: FlowBlock[];
    keyStatus: { planner1: boolean; executor: boolean };
    nativeStatus: string;
    /** K02/K06: active planner1 binding and whether it is retired (no dispatch allowed). */
    planner1Binding?: { provider: string; runner: string; authMethod: string; accountRef: string; model: string; policyHash: string; protocolHash: string; bindingVersion: number };
    planner1BindingHash?: string;
    planner1Retired?: boolean;
    planner1RetiredReason?: string | null;
}
export interface ClashStatus {
    enabled: boolean;
    status: string;
    configured: { selector: string; node: string; expectedMode: 'rule' | 'global' };
    selectors: { name: string; now: string; members: string[] }[];
    nodes: { name: string; type: string }[];
    recoveryRequired: boolean;
    evidence?: string;
    controller?: { version: { version: string; premium: boolean | null }; mode: string; mixedPort: number | null };
}
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';
/** A browser-only boundary. It does not schedule agents or redefine the server contract. */
export interface UiAdapter {
  readonly mode: 'local' | 'public-demo';
  readonly presentation?:'frontend-review';
  init(): Promise<void>;
  request<T>(path: string, method?: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  subscribe(pid: string, onEvent: (e: RunEvent) => void, onState: (s: ConnectionState) => void): () => void;
  exportRun(id: string): Promise<{ blob: Blob; filename: string }>;
  advanceScenario?(pid: string): Promise<Snapshot>;
  selectScenario?(pid: string, state: string): Promise<Snapshot>;
  dispose(): void;
}
export class UiError extends Error {
  constructor(public code: string, message: string, public status = 0) { super(message); this.name = 'UiError'; }
}
export interface NativeVerifierPlan {
 sha256:string;
 plan:{schema:'dream-maker.cli-verifier.v1';specHash:string;cases:{id:string;requirementIds:string[];acceptanceIds?:string[];runtime:'node'|'python';entry:string;args:string[];stdin:string;expectedExitCode:number;expectedStdout?:string;expectedStdoutPrefix?:string;expectedStdoutMatch?:string;expectedJson?:unknown;expectedStderr?:string;expectedStderrPrefix?:string;expectedStderrMatch?:string;fixtures?:Record<string,string>}[]};
}
/** Validate the narrow display contract; authority and coverage remain server-owned. */
export function readVerifierPlan(raw:unknown,specHash:string):NativeVerifierPlan {
 const fail=():never=>{throw new UiError('VERIFIER_PLAN_INVALID','验收计划与当前规格不匹配或内容不完整，请重新读取。');};
 const record=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail();
 const strings=(v:unknown,max:number)=>Array.isArray(v)&&v.length<=max&&v.every(x=>typeof x==='string');
 const bytes=(v:string)=>new TextEncoder().encode(v).length;
 const bounded=(v:unknown,max:number):v is string=>typeof v==='string'&&bytes(v)<=max;
 const pattern=(v:unknown):v is string=>bounded(v,300)&&(()=>{try{new RegExp(v);return true;}catch{return false;}})();
 const jsonSafe=(v:unknown)=>{try{const text=JSON.stringify(v,(_key,value)=>typeof value==='number'&&!Number.isFinite(value)?fail():value);return typeof text==='string'&&bytes(text)<=65536;}catch{return false;}};
 const safeFixture=(value:string)=>value.length>0&&/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value)&&!value.split('/').some(part=>part==='.'||part==='..'||part==='node_modules'||part==='.git'||/^\.env(?:\.|$)/i.test(part));
 const data=record(raw),plan=record(data.plan);
 if(typeof data.sha256!=='string'||!/^[a-f\d]{64}$/.test(data.sha256)||plan.schema!=='dream-maker.cli-verifier.v1'||plan.specHash!==specHash||!Array.isArray(plan.cases)||!plan.cases.length||plan.cases.length>20)return fail();
 for(const item of plan.cases){const c=record(item);
  if(typeof c.id!=='string'||typeof c.entry!=='string'||!strings(c.requirementIds,1000)||!(c.requirementIds as string[]).length||!strings(c.args,32)||!['node','python'].includes(String(c.runtime))||!bounded(c.stdin,65536)||!Number.isInteger(c.expectedExitCode))return fail();
  if(Object.hasOwn(c,'acceptanceIds')){
   const ids=c.acceptanceIds;
   if(!strings(ids,1000)||!(ids as string[]).length||(ids as string[]).some(id=>!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))||new Set(ids as string[]).size!==(ids as string[]).length)return fail();
  }
  const stdoutExact=Object.hasOwn(c,'expectedStdout'),stdoutPrefix=Object.hasOwn(c,'expectedStdoutPrefix'),stdoutMatch=Object.hasOwn(c,'expectedStdoutMatch'),stdoutJson=Object.hasOwn(c,'expectedJson');
  if([stdoutExact,stdoutPrefix,stdoutMatch,stdoutJson].filter(Boolean).length!==1)return fail();
  if(stdoutExact&&!bounded(c.expectedStdout,65536)||stdoutPrefix&&!bounded(c.expectedStdoutPrefix,65536)||stdoutMatch&&!pattern(c.expectedStdoutMatch)||stdoutJson&&!jsonSafe(c.expectedJson))return fail();
  const stderrExact=Object.hasOwn(c,'expectedStderr'),stderrPrefix=Object.hasOwn(c,'expectedStderrPrefix'),stderrMatch=Object.hasOwn(c,'expectedStderrMatch');
  if([stderrExact,stderrPrefix,stderrMatch].filter(Boolean).length>1)return fail();
  if(stderrExact&&!bounded(c.expectedStderr,65536)||stderrPrefix&&!bounded(c.expectedStderrPrefix,65536)||stderrMatch&&!pattern(c.expectedStderrMatch))return fail();
  if(Object.hasOwn(c,'fixtures')){
   const fixtures=record(c.fixtures),keys=Object.keys(fixtures),total=keys.reduce((sum,key)=>sum+(bounded(fixtures[key],8192)?bytes(fixtures[key] as string):Infinity),0);
   if(!keys.length||keys.length>4||total>16384||keys.some(key=>!safeFixture(key)||key===c.entry))return fail();
  }
 }
 return data as unknown as NativeVerifierPlan;
}
export const labels: Record<string, string> = {
  DRAFT:'未开始', INTERVIEWING:'等待回答', AWAITING_INTERVIEW_DECISION:'等待你的选择', REQUIREMENTS_REVIEW:'待确认需求稿', SPEC_REVIEW:'待确认规格', READY_TO_BUILD:'规格已确认',
  PLANNING:'制定工程计划', IMPLEMENTING:'执行制作', VERIFYING:'运行验证', REVIEWING:'独立审查', REPAIRING:'返修中',
  PAUSE_REQUESTED:'已请求暂停 · 等待检查点', PAUSED:'已暂停', CANCEL_REQUESTED:'已请求取消 · 等待清理', CANCELLED:'已取消',
  BLOCKED:'需要处理', FAILED:'运行失败', PARTIAL:'部分完成', READY_FOR_DELIVERY:'待验收', ACCEPTED:'已接受成果'
};
/** Chinese labels by stable wire id. The rename did not change these. */
export const roleNames: Record<string, string> = Object.fromEntries(ROLE_WIRE_IDS.map(id => [id, roleMetadata(id).zhLabel]));
/** Product names shown to people: Seeker / Planner / Executor / Reviewer. */
export const roleDisplayNames: Record<string, string> = Object.fromEntries(ROLE_WIRE_IDS.map(id => [id, roleMetadata(id).displayName]));
export function label(state: string): string { return labels[state] ?? state; }
export function activeRole(state: string): string | null {
  return ({INTERVIEWING:'planner1',PLANNING:'planner2',IMPLEMENTING:'executor',REPAIRING:'executor',REVIEWING:'reviewer'} as Record<string,string>)[state] ?? null;
}
export function escapeHtml(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }
export function runTone(state: string): string { return ['FAILED','BLOCKED'].includes(state) ? 'danger' : ['ACCEPTED','READY_FOR_DELIVERY'].includes(state) ? 'success' : ['PAUSED','PAUSE_REQUESTED','REPAIRING','PARTIAL','AWAITING_INTERVIEW_DECISION','CANCEL_REQUESTED'].includes(state) ? 'warning' : 'neutral'; }

/** Opaque request/UI identifier; fallback uses CSPRNG, never timestamps or Math.random. */
export function newId():string {
 if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
 const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const h=[...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
}
