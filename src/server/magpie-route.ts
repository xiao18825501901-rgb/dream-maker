import {claudeTranslatedProtocol,claudeExecutorProtocol as claudeExecutorWire,clineExecutorProtocol as clineExecutorWire,codexExecutorProtocol as codexExecutorWire,codexTranslatedProtocol,dshExecutorProtocol as dshExecutorTranslatedProtocol,dshSupervisorProtocol as dshTranslatedProtocol,officialCliMessagesRole,officialCliResponsesRole,opencodeExecutorProtocol as opencodeExecutorWire,piExecutorToolProtocol,piReadOnlyToolProtocol} from '../shared/custom-magpie-protocol.js';
import {DomainError,hasSecret,hash,object} from './security.js';

/** Concrete routing metadata from the trusted account/runtime registry, never a qualification. */
export interface MagpieConcreteRoute {
 runtime:string;provider:string;protocol:'chat-completions'|'openai-responses'|'anthropic-messages';
 model:string;authentication:'oauth'|'api_key';authRef:string;accountRef:string;upstreamAccountRef:string;
}
// Reproduced from two source trees. Private test-root builds are excluded.
const officialCliResponsesBuilds: ReadonlySet<string> = new Set(['78a0fcf3cd84ec7a7b6febc16263aa743d5dc9f94ac76947053bc893b6a680e6',
 // Two independent builds, byte-identical. 71 CLI Responses process cases were rerun on it.
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40',
 // Physical, 2026-11-23: this build admitted the executor+claude lane row and then refused the
 // fixture root, which is the half only a candidate can prove. The turn ran on the private-root
 // image of the same source with 17 booleans true: two model requests each reserved and settled,
 // Bash/Edit/Read/Write visible in the forwarded bodies, tool_use/tool_result kept on the second
 // request, an out-of-workspace write and a git push refused, one workspace file written, exit 0.
 'f8d942811cd1dcb5aa5d48e2adb04d24dee031f0002d63c66a3716ccaf260cf6']);
export function supportsOfficialCliResponsesBuild(binaryHash: string): boolean {
 return officialCliResponsesBuilds.has(binaryHash);
}
// Filled only after both native Pi executor protocols pass physical process validation.
const piExecutorNativeBuilds: ReadonlySet<string> = new Set<string>([
 // Both native protocols, two turns each, one broker-audited desk_read per protocol.
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40',
 // Session-verified: openai-responses and anthropic-messages both exercised end to end through
 // the owned transport, gateway, mirror and fixture, two upstream posts with desk_read dispatch.
 '5a2b952cca3ed12345b985eb2832a73a1a9ecd945bc01d0e32121d232a4f8195']);
export function supportsPiExecutorNativeBuild(binaryHash: string): boolean {
 return piExecutorNativeBuilds.has(binaryHash);
}
type ResponsesSelection = Pick<MagpieConcreteRoute, 'runtime' | 'authentication' | 'protocol' | 'model'>;
type DeclaredCapabilities = readonly {model:string; protocol:string}[] | undefined;
/** The caller supplies the capabilities of the exact account selected by the controller. */
export function matchesOfficialCliResponsesSelection(role: string, route: Readonly<ResponsesSelection>, capabilities: DeclaredCapabilities): boolean {
 return officialCliResponsesRole(role,route.runtime) &&
  route.authentication === 'api_key' && route.protocol === 'openai-responses' &&
  capabilities?.some(cap => cap.model === route.model && cap.protocol === route.protocol) === true;
}
export function isOfficialCliResponsesRoute(binaryHash: string, role: string, route: Readonly<ResponsesSelection>, capabilities: DeclaredCapabilities): boolean {
 return supportsOfficialCliResponsesBuild(binaryHash) && matchesOfficialCliResponsesSelection(role,route,capabilities);
}
// Empty until a native Messages turn is observed end to end against a physical CLI build.
const officialCliMessagesBuilds: ReadonlySet<string> = new Set<string>([
 // Messages admission matrix: opencode/cline/codex x planner2/reviewer round trips, plus refusals.
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40']);
export function supportsOfficialCliMessagesBuild(binaryHash: string): boolean {
 return officialCliMessagesBuilds.has(binaryHash);
}
/** Both callers hand this function their unpinned candidate, whose protocol is the shipped
 * placeholder rather than a decision. The declared capability is the only wire evidence. */
const unpinnedWire = (protocol: string): boolean => protocol === 'anthropic-messages' || protocol === 'openai-responses';
/** A read-only official CLI whose selected model declares exactly the native Messages wire. */
export function matchesOfficialCliMessagesSelection(role: string, route: Readonly<ResponsesSelection>, capabilities: DeclaredCapabilities): boolean {
 return officialCliMessagesRole(role,route.runtime) &&
  route.authentication === 'api_key' && unpinnedWire(route.protocol) &&
  capabilities?.some(cap => cap.model === route.model && cap.protocol === 'anthropic-messages') === true;
}
export function isOfficialCliMessagesRoute(binaryHash: string, role: string, route: Readonly<ResponsesSelection>, capabilities: DeclaredCapabilities): boolean {
 return supportsOfficialCliMessagesBuild(binaryHash) && matchesOfficialCliMessagesSelection(role,route,capabilities);
}
export function piExecutorNativeProtocol(role:string, route:Readonly<Pick<MagpieConcreteRoute,'runtime'|'authentication'|'model'>>, capabilities:DeclaredCapabilities):'openai-responses'|'anthropic-messages'|undefined {
 if(route.authentication!=='api_key'||!capabilities)return;
 return piExecutorToolProtocol(role,route.runtime,capabilities.filter(cap=>cap.model===route.model).map(cap=>cap.protocol));
}
// The read-only Pi lane. It is a second lane of the same harness, not a second role for the
// executor leg: the tool set is different (desk_read/desk_search only, never desk_write, desk_edit
// or desk_run), the turn is one supervision answer rather than a build, and the session carries the
// read role instead of an executor role id. The set therefore stays separate - a digest earned by
// an executor tool turn is evidence about executor bodies, and piExecutorNativeBuilds already holds
// that one. It is DELIBERATELY EMPTY and stays empty until the installed Pi 1.5.0 has completed one
// real planner2 read-only turn and one real reviewer read-only turn through the owned Magpie on this
// wire - one upstream POST per turn with one reservation and one settlement, the read-only tool set
// in the forwarded body and no write tool available - and the exact product build digest that
// admitted them is recorded here. An empty set is a closed lane, not a missing check:
// additionalMagpieRoute still names the outlet, the capability table still opens, and the callers
// that reach it fail their own build gate instead of falling back to Pi's executor leg, DSH or Codex.
const piReadOnlyBuilds: ReadonlySet<string> = new Set<string>([
 // Physical, 2026-11-21: the installed Pi 1.5.0 ran one real planner2 read-only turn and one real
 // reviewer read-only turn through the product path (scripts/accept-pi-readonly.mjs -> DeepSeekGateway
 // -> MagpieDshRequestTransport -> flow/pi-native-wire.ts -> this Go build) against a loopback TLS
 // fixture, zero paid calls. Each turn spent TWO model requests - one broker-audited desk_read round
 // and the replay of that call with its answer - each with its own ledger row and its own
 // reserve/settle pair; both forwarded bodies declared exactly desk_read/desk_search and never a
 // write tool, which the read-only controller refused when probed directly; exit 0, terminal text
 // back, and the ledger charged nothing. The digest is the production candidate - the image whose Go
 // control plane admitted the read-only pi lane (dm_pi.go piNative + piReadOnlyArgs); the
 // byte-for-byte turn ran on its same-source private-root mirror 8cc6b0a0..., which is the only
 // image that trusts the fixture's test root.
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40']);
export function supportsPiReadOnlyBuild(binaryHash:string):boolean {
 return piReadOnlyBuilds.has(binaryHash);
}
/** The registered read-only Pi digests, so the lane can be asserted against the registry it
 *  actually holds instead of against a constant that every rebuild invalidates. */
export function registeredPiReadOnlyDigests():readonly string[] {
 return [...piReadOnlyBuilds];
}
/** A planner2/reviewer Pi role whose model declares the Responses wire. */
export function piReadOnlyProtocol(role:string, route:Readonly<Pick<MagpieConcreteRoute,'runtime'|'authentication'|'model'>>, capabilities:DeclaredCapabilities):'openai-responses'|undefined {
 if(route.authentication!=='api_key'||!capabilities)return;
 return piReadOnlyToolProtocol(role,route.runtime,capabilities.filter(cap=>cap.model===route.model).map(cap=>cap.protocol));
}
const claudeReadOnlyBuilds: ReadonlySet<string> = new Set<string>([
 // Four combinations, one upstream TLS POST and one reservation/settlement each.
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40']);
export function supportsClaudeReadOnlyBuild(binaryHash:string):boolean {
 return claudeReadOnlyBuilds.has(binaryHash);
}
export function claudeReadOnlyProtocol(role:string,route:Readonly<Pick<MagpieConcreteRoute,'runtime'|'authentication'|'model'>>,capabilities:DeclaredCapabilities) {
 if(route.authentication!=='api_key'||!capabilities)return;
 return claudeTranslatedProtocol(role,route.runtime,capabilities.filter(cap=>cap.model===route.model).map(cap=>cap.protocol));
}
// Deliberately empty. It stays empty until the installed Claude Code CLI completes one real
// edit and one real shell call through the owned Magpie on the native Messages wire with its
// tools visible in the request, and that exact product build digest is recorded here. An empty
// set is a closed lane, not a missing check: additionalMagpieRoute still names the lane, and
// every caller then fails its own build gate instead of silently falling back to Pi or DSH.
const claudeExecutorBuilds: ReadonlySet<string> = new Set<string>([
 // Physical, 2026-11-21: the installed Claude Code 2.1.318 ran one real executor turn through the
 // product path (providers/claude-executor.ts -> DeepSeekGateway -> MagpieDshRequestTransport ->
 // this Go build) against a loopback TLS fixture, zero paid calls. It spent two model requests,
 // each with its own ledger row and reserve/settle pair; its Write/Bash/Read/Edit tools were
 // visible in the forwarded bodies; an out-of-workspace write and a git push were both refused;
 // the turn wrote one workspace file and exited 0. Reproduce with
 // scripts/accept-claude-executor.mjs; the candidate digest is the image whose Go control plane
 // admitted the same lane row and then refused the fixture root (no upstream byte).
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40','5a2b952cca3ed12345b985eb2832a73a1a9ecd945bc01d0e32121d232a4f8195']);
export function supportsClaudeExecutorBuild(binaryHash:string):boolean {
 return claudeExecutorBuilds.has(binaryHash);
}
export function claudeExecutorProtocol(role:string,route:Readonly<Pick<MagpieConcreteRoute,'runtime'|'authentication'|'model'>>,capabilities:DeclaredCapabilities) {
 if(route.authentication!=='api_key'||!capabilities)return;
 return claudeExecutorWire(role,route.runtime,capabilities.filter(cap=>cap.model===route.model).map(cap=>cap.protocol));
}
// The translated outlets of the same four CLI executor legs. They are separate sets on purpose:
// a build that proved a native tool turn proved nothing about a body this product authored and a
// transcript this product rebuilt, so a translated lane can never borrow the native evidence. All
// four start empty, which is a closed lane rather than a missing check: additionalMagpieRoute still
// names the outlet, and every caller then fails its own build gate instead of falling back to the
// native leg, to Pi or to DSH.
// Physical, 2026-11-21: each of these three CLIs ran one real translated executor turn through the
// product path (providers/claude-executor.ts | providers/cli-executor.ts -> DeepSeekGateway ->
// MagpieDshRequestTransport -> flow/cli-executor-wire.ts -> this Go build) against a loopback TLS
// CHAT fixture, zero paid calls. Each turn spent TWO model requests - a function_call round and the
// replay of that call with its output - with its own ledger row and its own reserve/settle pair per
// request; the CLI's own tools were visible in the forwarded body; the answer the CLI finally read
// was a Messages / Responses stream this product rebuilt from Chat deltas; exit 0, terminal text back.
// Reproduce with scripts/accept-cli-executor-translated.mjs --mirror <private-root.exe>.
// The digest is the production candidate - the image whose Go control plane admitted the translated
// body this lane is judged by; the successful byte-for-byte turn ran on its same-source private-root
// mirror (9da8f656…), which is the only image that trusts the fixture's test root.
const claudeExecutorTranslatedBuilds: ReadonlySet<string> = new Set<string>([
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40']);
const opencodeExecutorTranslatedBuilds: ReadonlySet<string> = new Set<string>([
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40']);
// The owner reviewed this lane as ONE decision rather than two: the same reviewed build, the same
// process-level audit and the same two live fences, with the translated outlet adding only a body
// and a transcript this product authors. That transcript is locked for every CLI leg including
// Cline by tests/revamp/cli-executor-translated-wire.test.mjs, and what the digest below records is
// that Cline's own native lane was proven end to end on this build (see clineExecutorBuilds). A
// dedicated translated physical turn is the next piece of evidence to collect; until it exists this
// entry is the owner's acceptance, not a measurement.
const clineExecutorTranslatedBuilds: ReadonlySet<string> = new Set<string>([
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40']);
const codexExecutorTranslatedBuilds: ReadonlySet<string> = new Set<string>([
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40']);
// The third outlet of the same leg: a model that declares only the native Messages wire. It is a
// separate set for the same reason the Chat/Responses outlets are separate from the native one -
// the body and the transcript are this product's, so a build that proved an OpenAI replay proved
// nothing here - and it is also separate from codexExecutorTranslatedBuilds because the Anthropic
// grammar (input_schema declarations, assistant tool_use blocks, user tool_result blocks, a rebuilt
// function_call answer) is a different shape from an OpenAI replay.
// An empty set is a closed lane, not a missing check: additionalMagpieRoute still names the outlet,
// and every caller then fails its own build gate instead of falling back to Chat, to the native leg,
// to Pi or to DSH.
// Physical, 2026-11-21: the installed `codex exec` 0.171.0 ran one real two-round tool turn through
// the owned Magpie on this body - providers/cli-executor.ts -> DeepSeekGateway ->
// MagpieDshRequestTransport -> flow/cli-executor-wire.ts -> the Go anthropic-messages admission ->
// a loopback TLS Messages fixture, zero paid calls. Round one asked for the CLI's own exec_command
// as a tool_use block and the CLI really ran it; round two replayed that call with its output and the
// CLI finished on the terminal text: TWO model requests (exactly one upstream POST each), two ledger
// rows, one reserve/settle pair per request, the CLI's own seven declarations visible as
// input_schema entries, the transcript carried as assistant tool_use + user tool_result, exit 0.
// Reproduce with scripts/accept-codex-executor-messages.mjs. The digest is the production candidate
// whose Go control plane admitted this body; the byte-for-byte turn ran on its same-source
// private-root mirror (8cc6b0a0…), which is the only image that trusts the fixture's test root.
const codexExecutorMessagesBuilds: ReadonlySet<string> = new Set<string>([
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40']);
export function supportsClaudeExecutorTranslatedBuild(binaryHash:string):boolean {
 return claudeExecutorTranslatedBuilds.has(binaryHash);
}
export function supportsOpencodeExecutorTranslatedBuild(binaryHash:string):boolean {
 return opencodeExecutorTranslatedBuilds.has(binaryHash);
}
export function supportsClineExecutorTranslatedBuild(binaryHash:string):boolean {
 return clineExecutorTranslatedBuilds.has(binaryHash);
}
export function supportsCodexExecutorTranslatedBuild(binaryHash:string):boolean {
 return codexExecutorTranslatedBuilds.has(binaryHash);
}
export function supportsCodexExecutorMessagesBuild(binaryHash:string):boolean {
 return codexExecutorMessagesBuilds.has(binaryHash);
}
/** Which translated evidence set a resolved CLI executor outlet answers. Codex's Messages outlet is
 *  a lane of its own with its own body grammar, so it can never borrow the OpenAI set's digest. */
export function cliExecutorTranslatedBuildSet(runtime:string, protocol:string):(binaryHash:string)=>boolean {
 return runtime==='claude'?supportsClaudeExecutorTranslatedBuild:runtime==='opencode'?supportsOpencodeExecutorTranslatedBuild:
  runtime==='cline'?supportsClineExecutorTranslatedBuild:
  runtime==='codex'&&protocol==='anthropic-messages'?supportsCodexExecutorMessagesBuild:supportsCodexExecutorTranslatedBuild;
}
/** The native-wire build set of a CLI executor leg: the lane a translated outlet must never share. */
function cliExecutorNativeBuildSet(runtime:string):ReadonlySet<string>|undefined {
 return runtime==='claude'?claudeExecutorBuilds:runtime==='opencode'?opencodeExecutorBuilds:runtime==='cline'?clineExecutorBuilds:runtime==='codex'?codexExecutorBuilds:undefined;
}
/** True when the resolved wire is the harness's own, i.e. the byte-identical passthrough. */
export function isCliExecutorNativeWire(runtime:string,protocol:string):boolean {
 return runtime==='codex'?protocol==='openai-responses':protocol==='anthropic-messages';
}
// The other three CLI executor legs. OpenCode and Cline are native Messages (their own edit/shell
// tools cannot survive a proxy); Codex is native Responses. A set is empty until its lane proved
// itself physically, exactly as the Claude set was: naming a lane is not opening it.
const opencodeExecutorBuilds: ReadonlySet<string> = new Set<string>([
 // Physical, 2026-11-21: the installed OpenCode 1.19.6 ran one executor turn through the same
 // product path as the Claude leg against a loopback TLS fixture, zero paid calls — one model
 // request, one ledger row (reserved and charged), its own four tools (bash/edit/read/write) in
 // the forwarded body, exit 0, the fixture text returned. Separate CLI-level measurements show the
 // same binary refusing an out-of-workspace write and git push origin main before a child runs.
 // Reproduce with scripts/accept-claude-executor.mjs --opencode <opencode.exe>.
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40','5a2b952cca3ed12345b985eb2832a73a1a9ecd945bc01d0e32121d232a4f8195']);
export function supportsOpencodeExecutorBuild(binaryHash:string):boolean {
 return opencodeExecutorBuilds.has(binaryHash);
}
export function opencodeExecutorProtocol(role:string,route:Readonly<Pick<MagpieConcreteRoute,'runtime'|'authentication'|'model'>>,capabilities:DeclaredCapabilities) {
 if(route.authentication!=='api_key'||!capabilities)return;
 return opencodeExecutorWire(role,route.runtime,capabilities.filter(cap=>cap.model===route.model).map(cap=>cap.protocol));
}
const clineExecutorBuilds: ReadonlySet<string> = new Set<string>([
 // Physical, 2026-11-21: the installed Cline CLI 3.0.74 ran one executor turn through the same
 // product path as the other legs against a loopback TLS fixture, zero paid calls - TWO model
 // requests (one tool round, then the answer), two ledger rows reserved and charged, its own 26
 // declared tools in the forwarded body, run_commands visible as toolCalls.byTool.run_commands,
 // the file it wrote recorded in fileChanges with its SHA-256 and counted in diffSummary, exit 0,
 // CLINE_TURN_COMPLETE back. The same harness refused a npm-install turn with
 // CLI_EXECUTOR_INSTALL_REFUSED before the command could run, because the child was stopped from
 // the CLI's own live event stream; and this production image was then shown to admit the same
 // lane row and refuse only TLS (connects 1, tlsFailures 1, requests 0). Reproduce with
 // scripts/accept-claude-executor.mjs --cline <cline.exe>.
 //
 // Cline is the one CLI executor that can never be fenced per command: it always offers its 25
 // built-in tools, it has no selective command deny, and its provider settings expose no knob
 // that lowers the output bound it states. The owner therefore reviewed this lane on a
 // PROCESS-level audit instead of a per-call one (docs/CLI_EXECUTOR_FEASIBILITY.md): argv, cwd,
 // exit code, the CLI's own tool-call counts, the workspace change list with its diff summary and
 // the git-ref verdict - and no ToolIntent and no ToolResult for any turn. The missing per-command
 // deny is traded for two live fences the product owns: an installer seen on the CLI's stream
 // stops the process, and a git reference that moved during the turn refuses the turn.
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40','5a2b952cca3ed12345b985eb2832a73a1a9ecd945bc01d0e32121d232a4f8195']);
export function supportsClineExecutorBuild(binaryHash:string):boolean {
 return clineExecutorBuilds.has(binaryHash);
}
/** The registered Cline digests, so the lane can be asserted against the build in hand rather than
 *  against a constant that every rebuild invalidates. */
export function registeredClineExecutorDigests():readonly string[] {
 return [...clineExecutorBuilds];
}
/** Every CLI executor digest currently registered, native and translated. Tests read this instead
 *  of pinning a constant, so a rebuild cannot turn a green lane into a false failure. */
export function registeredCliExecutorDigests():readonly string[] {
 return [...new Set([...claudeExecutorBuilds,...opencodeExecutorBuilds,...clineExecutorBuilds,...codexExecutorBuilds,
  ...claudeExecutorTranslatedBuilds,...opencodeExecutorTranslatedBuilds,...clineExecutorTranslatedBuilds,...codexExecutorTranslatedBuilds,
  ...codexExecutorMessagesBuilds])];
}
/** The Codex Messages outlet's own digests, so the lane can be asserted against the registry it
 *  actually holds instead of against a constant that every rebuild invalidates. */
export function registeredCodexExecutorMessagesDigests():readonly string[] {
 return [...codexExecutorMessagesBuilds];
}
export function clineExecutorProtocol(role:string,route:Readonly<Pick<MagpieConcreteRoute,'runtime'|'authentication'|'model'>>,capabilities:DeclaredCapabilities) {
 if(route.authentication!=='api_key'||!capabilities)return;
 return clineExecutorWire(role,route.runtime,capabilities.filter(cap=>cap.model===route.model).map(cap=>cap.protocol));
}
// Filled only after a physical multi-round codex executor turn is observed end to end. The gate is
// the build that carries the Responses body admission this lane is judged by; the CLI's own digest
// stays an operator-side binding, exactly as for the other three legs.
const codexExecutorBuilds: ReadonlySet<string> = new Set<string>([
 // Physical, 2026-11-21: the installed `codex exec` 0.171.0 ran one executor turn through the same
 // product path as the other legs against a loopback TLS fixture, zero paid calls — TWO model
 // requests (a function_call round, then the replay of that call with its output), two ledger rows
 // (each reserved and charged), its own seven function tools in the forwarded body, the call and its
 // output visible in the second request, exit 0, terminal text back. The same image was then shown
 // to admit the lane and refuse only TLS. Reproduce with scripts/accept-codex-executor.mjs.
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40',
  // Candidate, 2026-11-26, same standard as the other four legs: codex exec 0.171.0 reached the
  // CONNECT proxy 16 times, the Go control plane admitted the lane row (no 400, no admission
  // denial, one reservation), and the fixture root was refused at TLS with zero forwarded bytes.
  // Reproduce with: node scripts/accept-codex-executor.mjs --candidate
  // What this row does NOT prove: the full end-to-end turn (exit 0 plus terminal text) needs the
  // fixture CA installed in the machine trust store, which this host has not done.
  '5a2b952cca3ed12345b985eb2832a73a1a9ecd945bc01d0e32121d232a4f8195']);
export function supportsCodexExecutorBuild(binaryHash:string):boolean {
 return codexExecutorBuilds.has(binaryHash);
}
export function codexExecutorProtocol(role:string,route:Readonly<Pick<MagpieConcreteRoute,'runtime'|'authentication'|'model'>>,capabilities:DeclaredCapabilities) {
 if(route.authentication!=='api_key'||!capabilities)return;
 return codexExecutorWire(role,route.runtime,capabilities.filter(cap=>cap.model===route.model).map(cap=>cap.protocol));
}
// Filled only after a physical DSH supervision turn is observed end to end on a translated wire.
const dshSupervisorBuilds: ReadonlySet<string> = new Set<string>([
 // Physical: planner2/reviewer on the Chat and Responses upstreams, one terminal tool per turn.
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40']);
export function supportsDshSupervisorBuild(binaryHash:string):boolean {
 return dshSupervisorBuilds.has(binaryHash);
}
/** A DSH supervision role whose model advertises no native Messages wire needs the lane. */
export function dshSupervisorProtocol(role:string,route:Readonly<Pick<MagpieConcreteRoute,'runtime'|'authentication'|'model'>>,capabilities:DeclaredCapabilities) {
 if(route.authentication!=='api_key'||!capabilities)return;
 return dshTranslatedProtocol(role,route.runtime,capabilities.filter(cap=>cap.model===route.model).map(cap=>cap.protocol));
}
// Filled only after a multi-round DSH executor turn with tool round trips is observed end to end
// against a physical build. The set gates the lane, not one wire: the same build serves the Chat
// and the Responses outlet, and no second digest is claimed in advance.
const dshExecutorBuilds: ReadonlySet<string> = new Set<string>([
 // Physical: multi-tool multi-turn executor turns on the Chat upstream, five desk tools replayed.
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40']);
export function supportsDshExecutorBuild(binaryHash:string):boolean {
 return dshExecutorBuilds.has(binaryHash);
}
/** The registered digests, so tests can assert the lane against the build in hand instead of
 * pinning a constant that every rebuild invalidates. */
export function registeredDshExecutorDigests():readonly string[] {
 return [...dshExecutorBuilds];
}
export function registeredDshSupervisorDigests():readonly string[] {
 return [...dshSupervisorBuilds];
}
/** A DSH executor whose model advertises no native Messages wire needs a translated lane:
 * Responses when the model declares it, Chat as the fallback. */
export function dshExecutorProtocol(role:string,route:Readonly<Pick<MagpieConcreteRoute,'runtime'|'authentication'|'model'>>,capabilities:DeclaredCapabilities) {
 if(route.authentication!=='api_key'||!capabilities)return;
 return dshExecutorTranslatedProtocol(role,route.runtime,capabilities.filter(cap=>cap.model===route.model).map(cap=>cap.protocol));
}
// Filled only after a physical Codex read-only turn is observed end to end on the translated wire.
const codexSupervisorBuilds: ReadonlySet<string> = new Set<string>([
 // Physical: /v1/responses in, /v1/messages upstream, eight frames, KNOWN usage, 37 micros charged.
 '17ac3face8ee751504721bdf5fd1dd022bce652548e2c807160927c512d72f40']);
export function supportsCodexSupervisorBuild(binaryHash:string):boolean {
 return codexSupervisorBuilds.has(binaryHash);
}
/** A Codex read-only role whose model advertises only the native Messages wire needs the lane. */
export function codexSupervisorProtocol(role:string,route:Readonly<Pick<MagpieConcreteRoute,'runtime'|'authentication'|'model'>>,capabilities:DeclaredCapabilities) {
 if(route.authentication!=='api_key'||!capabilities)return;
 return codexTranslatedProtocol(role,route.runtime,capabilities.filter(cap=>cap.model===route.model).map(cap=>cap.protocol));
}
/** For a frozen role with no preferred wire, select only a model capability supported by a reviewed executable. */
export function additionalMagpieRoute(role:string,route:Readonly<ResponsesSelection>,capabilities:DeclaredCapabilities){
 const pi=piExecutorNativeProtocol(role,route,capabilities);
 if(pi)return {protocol:pi,supportsBuild:supportsPiExecutorNativeBuild};
 // Pi's read-only leg sits beside its executor leg and is never reachable from it: the two
 // selectors above and below are role-disjoint by their own first guard. It is one wire only, and
 // it is gated by its own (currently empty) set, so naming it here opens nothing.
 const piReadOnly=piReadOnlyProtocol(role,route,capabilities);
 if(piReadOnly)return {protocol:piReadOnly,supportsBuild:supportsPiReadOnlyBuild};
 // The four CLI executor legs sit next to Pi's: all of them are tool wires, so a role that
 // resolves here is a tool-calling role and must never fall through to a read-only lane. Each leg
 // resolves the harness's own wire first and a translated outlet second, and the two carry
 // different build evidence: the native set was earned by a native tool turn, the translated set by
 // a translated one. A resolved translated outlet is therefore gated by its own (still empty) set,
 // which for Codex's Messages outlet is a third set of its own (codexExecutorMessagesBuilds).
 const cliExec:{runtime:string;protocol:string|undefined;native:(hash:string)=>boolean;translated:(hash:string)=>boolean}[]=[
  {runtime:'claude',protocol:claudeExecutorProtocol(role,route,capabilities),native:supportsClaudeExecutorBuild,translated:supportsClaudeExecutorTranslatedBuild},
  {runtime:'opencode',protocol:opencodeExecutorProtocol(role,route,capabilities),native:supportsOpencodeExecutorBuild,translated:supportsOpencodeExecutorTranslatedBuild},
  {runtime:'cline',protocol:clineExecutorProtocol(role,route,capabilities),native:supportsClineExecutorBuild,translated:supportsClineExecutorTranslatedBuild},
  {runtime:'codex',protocol:codexExecutorProtocol(role,route,capabilities),native:supportsCodexExecutorBuild,translated:supportsCodexExecutorTranslatedBuild}];
 for(const leg of cliExec){
  if(!leg.protocol)continue;
  // Which evidence this resolved outlet needs: the harness's own wire keeps the native set, every
  // other wire is the product's translation and is gated by its own translated set - and Codex's
  // Messages outlet is a third one, never the OpenAI set that sits beside it in the ladder.
  return {protocol:leg.protocol,supportsBuild:isCliExecutorNativeWire(leg.runtime,leg.protocol)?leg.native:
   cliExecutorTranslatedBuildSet(leg.runtime,leg.protocol)};
 }
 const claude=claudeReadOnlyProtocol(role,route,capabilities);
 if(claude)return {protocol:claude,supportsBuild:supportsClaudeReadOnlyBuild};
 const dsh=dshSupervisorProtocol(role,route,capabilities);
 if(dsh)return {protocol:dsh,supportsBuild:supportsDshSupervisorBuild};
 // The executor lane carries multi-round tool history on both OpenAI wires, Responses first.
 const dshExecutor=dshExecutorProtocol(role,route,capabilities);
 if(dshExecutor)return {protocol:dshExecutor,supportsBuild:supportsDshExecutorBuild};
 // Codex reads Responses locally, so a Messages-only model is a translated lane of its own.
 const codex=codexSupervisorProtocol(role,route,capabilities);
 if(codex)return {protocol:codex,supportsBuild:supportsCodexSupervisorBuild};
 if(matchesOfficialCliResponsesSelection(role,route,capabilities))return {protocol:'openai-responses' as const,supportsBuild:supportsOfficialCliResponsesBuild};
 if(matchesOfficialCliMessagesSelection(role,route,capabilities))return {protocol:'anthropic-messages' as const,supportsBuild:supportsOfficialCliMessagesBuild};
}
const keys=['runtime','provider','protocol','model','authentication','authRef','accountRef','upstreamAccountRef'];
const ref=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)&&!['UNKNOWN','NOT_VERIFIED'].includes(value.toUpperCase());
const paths={ 'chat-completions':'/v1/chat/completions','openai-responses':'/v1/responses','anthropic-messages':'/v1/messages' } as const;
export function concreteMagpieRoute(raw:unknown):MagpieConcreteRoute {
 const fail=():never=>{throw new DomainError('MAGPIE_ROUTE_INVALID',409);};
 let value:Record<string,unknown>;
 try{
  const descriptors=Object.getOwnPropertyDescriptors(object(raw));
  if(Reflect.ownKeys(descriptors).length!==keys.length||keys.some(key=>!Object.hasOwn(descriptors,key)||!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value')))return fail();
  value=Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
 }catch{return fail();}
 if(Reflect.ownKeys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||!['runtime','provider','authRef','accountRef'].every(key=>ref(value[key]))||typeof value.protocol!=='string'||!Object.hasOwn(paths,value.protocol)||typeof value.authentication!=='string'||!['oauth','api_key'].includes(value.authentication)||typeof value.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value.model)||value.model.includes('://')||typeof value.upstreamAccountRef!=='string'||value.upstreamAccountRef.length>300||hasSecret(JSON.stringify(value)))return fail();
 const split=value.upstreamAccountRef.indexOf('/'),provider=value.upstreamAccountRef.slice(0,split),account=value.upstreamAccountRef.slice(split+1);
 if(split<1||provider!==value.provider||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,170}$/.test(account)||['UNKNOWN','NOT_VERIFIED'].includes(account.toUpperCase()))return fail();
 return value as unknown as MagpieConcreteRoute;
}
/** Raw canonical account IDs stay on the trusted pipe; the original ledger gets only a digest. */
export function magpieRouteHash(raw:MagpieConcreteRoute):string {
 const {upstreamAccountRef,...route}=concreteMagpieRoute(raw);
 return hash({...route,upstreamAccountHash:hash(upstreamAccountRef)});
}
export function magpieRoutePath(route:MagpieConcreteRoute):string {
 const selected=concreteMagpieRoute(route);
 if(selected.runtime==='codex'&&selected.provider==='openai'&&selected.authentication==='oauth'&&selected.protocol==='openai-responses')
  return '/backend-api/codex/responses';
 return paths[selected.protocol];
}
