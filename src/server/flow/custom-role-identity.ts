import type {AgentOutput,ExecutionIdentity,Role,Run} from '../../shared/types.js';
import type {CustomRoleProfile} from '../../shared/flow-profile.js';
import type {CustomFlowConfigSnapshot} from '../../shared/flow-configuration.js';
import {assertCustomSnapshot,assertFlowSnapshot} from '../flow-configuration.js';
import {CUSTOM_ROLE_POLICY} from '../role-policy.js';
import {DomainError,hash} from '../security.js';

export interface ResolvedCustomRole extends Omit<CustomRoleProfile,'runtime'|'provider'|'authentication'|'model'|'transport'|'nativeException'|'selectedMemberId'> {
 runtime:CustomRoleRuntime;provider:string;authentication:'oauth'|'api_key';model:{kind:'model';id:string};transport:'magpie'|'native';nativeException:false;selectedMemberId?:string;
}

/** The three engineering roles of one Custom Flow must not share a harness. A single
 * runtime serving every role cannot review its own output, so a Flow whose roles are
 * not diversified is refused before any qualification or dispatch happens. */
export type CustomRoleRuntime='codex'|'dsh'|'independent'|'kimi'|'claude'|'pi'|'opencode'|'cline';
export type CustomTextCliRuntime='opencode'|'cline';
export function isCustomTextCliRuntime(runtime:string):runtime is CustomTextCliRuntime {
 return runtime==='opencode'||runtime==='cline';
}
export const CUSTOM_TEXT_CLI_RUNNERS={opencode:'OPENCODE_CLI',cline:'CLINE_CLI'} as const;
/** Identity envelope names for the CLI executor legs; Codex runs `codex exec` under its own name. */
export const CUSTOM_CLI_RUNNERS={opencode:'OPENCODE_CLI',cline:'CLINE_CLI',codex:'CODEX_CLI'} as const;
/** Configurable API-key harness shape only. The owned resolver decides whether the
 * installed binary and exact account can actually execute the frozen model. */
export function customMagpieApiRuntime(role:string,runtime:string):runtime is Exclude<CustomRoleRuntime,'kimi'> {
 // An executor turn spends one model request per tool call, so the harness needs a tool-carrying
 // MODEL LEG, not merely a headless CLI. Six legs exist: Pi-native and DSH-translated
 // (shared/custom-magpie-protocol.ts piExecutorToolProtocol / dshExecutorProtocol), plus the four
 // CLI legs claudeExecutorProtocol, opencodeExecutorProtocol, clineExecutorProtocol and
 // codexExecutorProtocol. A CLI leg keeps the wire its own tools speak and falls back to the
 // translated outlet when the model declares only an OpenAI wire. Every outlet is entered through
 // its own reviewed-build digest in magpie-route.ts additionalMagpieRoute - the native set for the
 // passthrough, the translated set for the product-built body - and declaring the route here is not
 // qualification: an unregistered digest still fails at the transport.
 if(role==='executor')return runtime==='dsh'||runtime==='pi'||runtime==='claude'||runtime==='opencode'||runtime==='cline'||runtime==='codex';
 // Pi is also a read-only harness. Its planner2/reviewer leg is not the executor leg wearing a
 // different role: it is one supervision answer on Pi's native Responses wire, its tool set is
 // frozen to desk_read/desk_search (flow/pi-native-wire.ts PI_READ_ONLY_TOOLS) and it has its own
 // reviewed build set in magpie-route.piReadOnlyBuilds, so a build that only proved an executor
 // tool turn opens nothing here. Declaring the route is not qualification: an unregistered digest
 // fails at the route, and a write tool in a read-only turn is refused by the runner and the wire.
 return (role==='planner2'||role==='reviewer')&&(runtime==='dsh'||runtime==='codex'||runtime==='claude'||runtime==='independent'||runtime==='pi'||isCustomTextCliRuntime(runtime));
}
const CUSTOM_ROLE_MODELS:Record<string,readonly string[]>={'string':['claude-sonnet-5'],'openai':['gpt-6-luna'],'deepseek-official':['deepseek-flash','deepseek-v4-pro','deepseek-v4-flash','deepseek-v4-flash-vision-exp','deepseek-chat','deepseek-reasoner'],'kimi':['kimi-for-coding','kimi-code/kimi-for-coding']};
const CUSTOM_ROLE_ROUTES:readonly {runtime:CustomRoleRuntime;provider:string;authentication:'oauth'|'api_key';transport:'magpie'|'native';nativeException:boolean;role?:Role}[]=[
 {runtime:'claude',provider:'string',authentication:'api_key',transport:'magpie',nativeException:false},
 // The same installed Claude Code CLI is also a tool-bearing executor: its own edit/shell
 // tools run inside the flows workspace while the model leg stays metered by the DM-owned
 // Magpie on the native Messages wire. Declaring the route is not qualification; the lane
 // still needs its reviewed build digest in magpie-route.supportsClaudeExecutorBuild.
 {runtime:'claude',provider:'string',authentication:'api_key',transport:'magpie',nativeException:false,role:'executor'},
 {runtime:'codex',provider:'openai',authentication:'oauth',transport:'magpie',nativeException:false,role:'planner2'},
 // Native subscription routes stay listed for OAuth; Magpie-fronted API-key routes are added per harness.
 {runtime:'codex',provider:'openai',authentication:'oauth',transport:'native',nativeException:true},
 // Same official CLI, driven through the DM-owned loopback admission gateway. The model is data,
 // so a Codex harness may serve a DeepSeek model while staying inside the metered Magpie path.
 {runtime:'codex',provider:'deepseek-official',authentication:'api_key',transport:'magpie',nativeException:false},
 {runtime:'opencode',provider:'deepseek-official',authentication:'api_key',transport:'magpie',nativeException:false},
 {runtime:'cline',provider:'deepseek-official',authentication:'api_key',transport:'magpie',nativeException:false},
 // OpenCode and Cline are also tool-bearing executors: their own edit/shell tools run inside the
 // flows workspace while the model leg stays metered by the DM-owned Magpie on the native Messages
 // wire. Declaring the route is not qualification; each lane still needs its reviewed build digest
 // in magpie-route.supportsOpencodeExecutorBuild / supportsClineExecutorBuild.
 {runtime:'opencode',provider:'deepseek-official',authentication:'api_key',transport:'magpie',nativeException:false,role:'executor'},
 {runtime:'cline',provider:'deepseek-official',authentication:'api_key',transport:'magpie',nativeException:false,role:'executor'},
 // Codex is the one CLI executor on the Responses wire, and stays a supervision harness on OAuth.
 {runtime:'codex',provider:'deepseek-official',authentication:'api_key',transport:'magpie',nativeException:false,role:'executor'},
 {runtime:'dsh',provider:'deepseek-official',authentication:'api_key',transport:'magpie',nativeException:false},
 // Pi Agent disables its own shell/file tools in every role; the only tools it receives are the
 // DM broker's scoped desk_* tools. As an executor it may hold the write three when the frozen
 // permissions grant source_write; as planner2 or reviewer it is frozen to desk_read/desk_search.
 {runtime:'pi',provider:'deepseek-official',authentication:'api_key',transport:'magpie',nativeException:false,role:'executor'},
 {runtime:'pi',provider:'deepseek-official',authentication:'api_key',transport:'magpie',nativeException:false,role:'planner2'},
 {runtime:'pi',provider:'deepseek-official',authentication:'api_key',transport:'magpie',nativeException:false,role:'reviewer'},
 // A text-only direct API harness can also be fronted by the same loopback admission gateway;
 // the native route above stays for providers that must be reached directly.
 {runtime:'independent',provider:'deepseek-official',authentication:'api_key',transport:'magpie',nativeException:false},
 {runtime:'independent',provider:'deepseek-official',authentication:'api_key',transport:'native',nativeException:true},
 // Kimi is the third harness: official OAuth, no Magpie, its own usage ledger.
 {runtime:'kimi',provider:'kimi',authentication:'oauth',transport:'native',nativeException:true},
];

/** Configured direct route only. Qualification remains the original NativeOwner's job.
 * A group must name its initial member; this helper never selects the first member. */
export function customRoleConfiguration(snapshot:CustomFlowConfigSnapshot,role:Role,executorRoleId?:string):ResolvedCustomRole {
 assertCustomSnapshot(snapshot);
 if(role==='planner1')throw new DomainError('ENGINE_PLANNER1_DISPATCH_DENIED',403);
 const selected=role==='executor'?snapshot.roles.executors.find(r=>r.id===executorRoleId):snapshot.roles[role];
 if(!selected||role!=='executor'&&executorRoleId!==undefined)throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
 let actor:CustomRoleProfile;
 if(selected.model.kind==='model'){
  if(selected.selectedMemberId!==undefined)throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
  actor=structuredClone(selected);
 }else{
  if(!selected.selectedMemberId)throw new DomainError('CUSTOM_MODEL_GROUP_SELECTION_REQUIRED',409);
  const group=snapshot.groups.find(g=>g.id===selected.model.id),member=group?.members.find(m=>m.id===selected.selectedMemberId);
  if(!group||!member||member.permissions.some(p=>!selected.permissions.includes(p)))throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
  const account=snapshot.accounts.find(a=>a.provider===member.provider&&a.authRef===member.authRef&&a.accountRef===member.accountRef);
  if(!account)throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
  actor={...structuredClone(selected),provider:member.provider,authentication:account.authentication,authRef:member.authRef,accountRef:member.accountRef,
   model:{kind:'model',id:member.model},permissions:[...member.permissions],selectedMemberId:member.id};
 }
 if(snapshot.privacy.deniedProviders.includes(actor.provider)||snapshot.privacy.deniedDataLabels.length)throw new DomainError('CUSTOM_ROLE_PRIVACY_DENIED',409);
 const route=CUSTOM_ROLE_ROUTES.find(r=>r.runtime===actor.runtime&&r.provider===actor.provider&&r.authentication===actor.authentication&&r.transport===actor.transport&&r.nativeException===actor.nativeException&&(!r.role||r.role===role));
 const explicitApi=actor.transport==='magpie'&&actor.authentication==='api_key'&&!actor.nativeException;
 if(explicitApi?!customMagpieApiRuntime(role,actor.runtime):!route||!(CUSTOM_ROLE_MODELS[actor.provider]??[]).includes(actor.model.id))throw new DomainError('CUSTOM_ROLE_RUNTIME_UNSUPPORTED',409);
 if(actor.runtime==='kimi'&&role!=='reviewer')throw new DomainError('CUSTOM_ROLE_RUNTIME_UNSUPPORTED',409);
 // Pi serves all three roles, but every role stays its own binding: only the executor may hold a
 // write tool, and a read role must be pinned to its own role id (planner2/reviewer), never to an
 // executor's. The route table above already restricts each Pi role to the magpie API-key shape.
 if(actor.runtime==='pi'&&role!=='executor'&&(actor.id!==role||actor.permissions.includes('source_write')))throw new DomainError('CUSTOM_ROLE_RUNTIME_UNSUPPORTED',409);
 if(!actor.permissions.includes('source_read')||role!=='executor'&&actor.permissions.includes('source_write'))throw new DomainError('CUSTOM_ROLE_PERMISSION_DENIED',409);
 return structuredClone(actor) as ResolvedCustomRole;
}
export function assertCustomDirectRoles(snapshot:CustomFlowConfigSnapshot):void {
 customRoleConfiguration(snapshot,'planner2');customRoleConfiguration(snapshot,'reviewer');
 for(const role of snapshot.roles.executors)customRoleConfiguration(snapshot,'executor',role.id);
}

/** The probe binding carries the same route as the product configuration, so it is
 * validated by the same table instead of a second, looser copy. Only the three
 * engineering roles qualify; OAuth legs report their own subscription shape. */
export function assertCustomProbeActor(actor:{role:string;roleId:string;runtime:string;provider:string;authentication:string;model:string;transport?:string}):void {
 currentModelIdentity(actor.provider,actor.model);
 const role=actor.role;
 if(role!=='planner2'&&role!=='executor'&&role!=='reviewer')throw new DomainError('CUSTOM_PROBE_BINDING_INVALID',409);
 if(role!=='executor'&&actor.roleId!==role)throw new DomainError('CUSTOM_PROBE_BINDING_INVALID',409);
 const authentication=actor.authentication==='API_KEY'?'api_key':actor.authentication==='CHATGPT_SUBSCRIPTION'||actor.authentication==='MEMBER_SUBSCRIPTION'?'oauth':undefined;
 if(!authentication)throw new DomainError('CUSTOM_PROBE_BINDING_INVALID',409);
 // A probe that states its transport is matched against that exact route; an older binding
 // without one falls back to the historical shape inference below.
 const transport=actor.transport==='magpie'||actor.transport==='native'?actor.transport:undefined;
 if(actor.transport!==undefined&&transport===undefined)throw new DomainError('CUSTOM_PROBE_BINDING_INVALID',409);
 if(transport==='magpie'&&authentication==='api_key'){
  if(!customMagpieApiRuntime(role,actor.runtime))throw new DomainError('CUSTOM_PROBE_BINDING_INVALID',409);
  // A qualification probe is one tool-free request. It cannot speak for a tool-bearing executor
  // leg, so the Claude executor is qualified by its own physical registration instead of a probe.
  if(role==='executor'&&actor.runtime==='claude')throw new DomainError('CUSTOM_PROBE_BINDING_INVALID',409);
  return;
 }
 if(actor.runtime==='claude'||isCustomTextCliRuntime(actor.runtime))throw new DomainError('CUSTOM_PROBE_BINDING_INVALID',409);
 const routes=CUSTOM_ROLE_ROUTES.filter(r=>r.runtime===actor.runtime&&r.provider===actor.provider&&r.authentication===authentication&&(!r.role||r.role===role&&transport===r.transport)&&(transport===undefined||r.transport===transport));
 if(!routes.length||!(CUSTOM_ROLE_MODELS[actor.provider]??[]).includes(actor.model))throw new DomainError('CUSTOM_PROBE_BINDING_INVALID',409);
 if(actor.runtime==='kimi'&&role!=='reviewer'||actor.runtime==='codex'&&role==='executor'||actor.runtime==='pi'&&role!=='executor')throw new DomainError('CUSTOM_PROBE_BINDING_INVALID',409);
 // A Codex probe is a subscription probe unless the matched route is the loopback Magpie one;
 // in that case the CLI is running on an api-key provider and must say so.
 const codexApi=routes.some(r=>r.runtime==='codex'&&r.transport==='magpie');
 if(actor.runtime==='kimi'&&actor.authentication!=='MEMBER_SUBSCRIPTION'||
    actor.runtime==='codex'&&actor.authentication!=='CHATGPT_SUBSCRIPTION'&&!(actor.authentication==='API_KEY'&&codexApi))throw new DomainError('CUSTOM_PROBE_BINDING_INVALID',409);
 if(actor.runtime!=='codex'&&actor.runtime!=='kimi'&&actor.authentication!=='API_KEY')throw new DomainError('CUSTOM_PROBE_BINDING_INVALID',409);
}
/** Current execution identity, not a rewrite of stored historical configuration.
 * DeepSeek official updates/pricing checked 2026-11-18: old chat/reasoner retired;
 * both V4 Flash compatibility names now resolve to the current Flash model. */
function currentModelIdentity(provider:string,model:string):string{
 if(provider==='deepseek-official'){
  if(model==='deepseek-chat'||model==='deepseek-reasoner')throw new DomainError('CUSTOM_MODEL_RETIRED',409,'所选 DeepSeek 旧模型名称已停用，请明确选择当前可用模型。');
  if(model==='deepseek-v4-flash'||model==='deepseek-v4-flash-vision-exp')model='deepseek-flash';
 }
 if(provider==='kimi'&&model==='kimi-code/kimi-for-coding')model='kimi-for-coding';
 return provider+'/'+model;
}
/** Distinct harness AND distinct model per engineering role. This is the owner's
 * acceptance rule: three DSH/deepseek-flash roles are one harness wearing three hats. */
export function assertCustomRoleDiversity(snapshot:CustomFlowConfigSnapshot):void {
 const roles=[customRoleConfiguration(snapshot,'planner2'),...snapshot.roles.executors.map(r=>customRoleConfiguration(snapshot,'executor',r.id)),customRoleConfiguration(snapshot,'reviewer')];
 if(new Set(roles.map(r=>r.runtime)).size!==roles.length)throw new DomainError('CUSTOM_ROLE_HARNESS_NOT_DIVERSIFIED',409,'每个 Custom 角色必须使用不同的运行器；同一 harness 承担多个角色时不能作为互相独立的规划与执行/审查。');
 if(new Set(roles.map(r=>currentModelIdentity(r.provider,r.model.id))).size!==roles.length)throw new DomainError('CUSTOM_ROLE_MODEL_NOT_DIVERSIFIED',409,'每个 Custom 角色必须使用不同的模型。');
}
/** Compare adapter evidence with the exact frozen actor. Never infer from global Codex
 * settings, a displayed model name, or the model's completion summary. */
export function customExecutionIdentity(run:Run,role:Role,out:AgentOutput,executorRoleId?:string):ExecutionIdentity {
 assertFlowSnapshot(run);
 if(run.flowConfig?.mode!=='custom'||run.rolePolicy!==CUSTOM_ROLE_POLICY)throw new DomainError('CUSTOM_ROLE_BINDING_CHANGED',409);
 const identity=out.identity;
 if(!identity||!out.sessionId||!identity.model||identity.model!==out.model)throw new DomainError('ROLE_EXECUTION_IDENTITY_UNVERIFIED',409);
 const selected=customRoleConfiguration(run.flowConfig,role,executorRoleId??(role==='executor'?identity.roleId:undefined));
 const runner=isCustomTextCliRuntime(selected.runtime)?CUSTOM_TEXT_CLI_RUNNERS[selected.runtime]:selected.runtime==='claude'?'CLAUDE_CODE':selected.runtime==='codex'?'CODEX_CLI':selected.runtime==='independent'?'INDEPENDENT_API':selected.runtime==='kimi'?'KIMI_SERVER':selected.runtime==='pi'?'PI_CLI':'DSH',
  authentication=selected.authentication==='api_key'?'API_KEY':selected.runtime==='codex'?'CHATGPT_SUBSCRIPTION':selected.runtime==='kimi'?'MEMBER_SUBSCRIPTION':'API_KEY',
  // Every Magpie-fronted harness carries a route hash and a metered usage record.
  metered=selected.transport==='magpie',
  expected={runner,runtime:selected.runtime,provider:selected.provider,authentication,model:selected.model.id,roleId:selected.id,authRef:selected.authRef,accountRef:selected.accountRef,configurationHash:hash(run.flowConfig)};
 if(Object.entries(expected).some(([key,value])=>identity[key as keyof ExecutionIdentity]!==value)
  ||metered&&(typeof identity.routeHash!=='string'||!/^[a-f0-9]{64}$/.test(identity.routeHash))
  ||metered&&(out.usage?.role!==role||typeof out.usage.requestId!=='string'||!out.usage.requestId))throw new DomainError('ROLE_EXECUTION_ROUTE_MISMATCH',409);
 return{...identity};
}
