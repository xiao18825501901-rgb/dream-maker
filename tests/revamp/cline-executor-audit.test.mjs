// OFFLINE contract only: no model, no account, no Store, no dispatch, no CLI process.
//
// Scope: the Cline executor lane, which the owner reviewed as a PROCESS-level lane because Cline
// always offers its 25 built-in tools and exposes no per-command deny. Four things are locked here:
//   - the protocol ladder (native anthropic-messages, then openai-responses, then chat-completions)
//     and the route resolving each rung to its own build set;
//   - the route staying fail-closed on every digest the reviewed build did not earn;
//   - the shape of the one record a Cline turn publishes, which states inside itself that it is not
//     a per-call trail;
//   - and the installer fence, including its negative: the instance a real --json row carries is
//     stopped, while the same words inside another command are not.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {clineExecutorProtocol,customMagpieProtocol} from '../../dist/shared/custom-magpie-protocol.js';
import {additionalMagpieRoute,concreteMagpieRoute,registeredCliExecutorDigests,registeredClineExecutorDigests,registeredDshExecutorDigests,registeredDshSupervisorDigests,supportsClineExecutorBuild,supportsClineExecutorTranslatedBuild} from '../../dist/server/magpie-route.js';
import {cliExecutorProcessAudit,clineInstallerCommand,clineInstallWatcher,gitRefChanges,readGitRefs} from '../../dist/server/providers/cli-executor.js';

const MODEL='deepseek-flash',PROVIDER='deepseek-fixture';
const NATIVE='anthropic-messages';
const TRANSLATED=['openai-responses','chat-completions'];
const routeOf=protocol=>({runtime:'cline',provider:PROVIDER,protocol,model:MODEL,authentication:'api_key',
 authRef:'offline_auth',accountRef:'offline_account',upstreamAccountRef:PROVIDER+'/offline_peer'});
const capabilities=protocol=>[{model:MODEL,protocol}];
// The registry is the only source of a product digest: a rebuild renames the build, so a pinned
// constant would turn a green lane into a false failure. A digest is used as a fail-closed negative
// only once the product proves that no lane registered it.
const registeredDigests=()=>new Set([...registeredCliExecutorDigests(),...registeredClineExecutorDigests(),
 ...registeredDshExecutorDigests(),...registeredDshSupervisorDigests()]);
const negatives=()=>{const hashes=['a'.repeat(64),'0'.repeat(64),'f'.repeat(64)].filter(hash=>!registeredDigests().has(hash));
 assert.equal(hashes.length,3,'the fail-closed fixtures are registered by no lane');return hashes;};

test('the Cline executor ladder is native Messages first, then Responses, then Chat',()=>{
 // The exact order OpenCode's leg uses: the CLI's own wire wins whenever the model declares it,
 // and a model that declares neither OpenAI wire leaves the role unrouted rather than guessed.
 assert.equal(clineExecutorProtocol('executor','cline',[NATIVE,...TRANSLATED]),NATIVE);
 assert.equal(clineExecutorProtocol('executor','cline',TRANSLATED),'openai-responses');
 assert.equal(clineExecutorProtocol('executor','cline',['chat-completions']),'chat-completions');
 assert.equal(customMagpieProtocol('executor','cline',[NATIVE,...TRANSLATED]),NATIVE);
 assert.equal(customMagpieProtocol('executor','cline',['openai-responses']),'openai-responses');
 assert.equal(customMagpieProtocol('executor','cline',['chat-completions']),'chat-completions');
 assert.equal(customMagpieProtocol('executor','cline',[]),undefined);
 // No supervision role and no other harness ever reaches this leg.
 for(const role of ['planner2','reviewer'])assert.equal(clineExecutorProtocol(role,'cline',[NATIVE]),undefined,role);
 for(const other of ['claude','opencode','codex','dsh','pi'])assert.equal(clineExecutorProtocol('executor',other,[NATIVE]),undefined,other);
});

test('each rung of the ladder resolves to its own build set, and the lane stays closed off them',()=>{
 const digests=registeredClineExecutorDigests();
 assert.ok(digests.length>=1,'the lane is registered on the reviewed build');
 const nativeLane=additionalMagpieRoute('executor',concreteMagpieRoute(routeOf(NATIVE)),capabilities(NATIVE));
 assert.ok(nativeLane);
 assert.equal(nativeLane.protocol,NATIVE);
 assert.equal(nativeLane.supportsBuild,supportsClineExecutorBuild);
 for(const digest of digests)assert.equal(nativeLane.supportsBuild(digest),true,digest);
 // Fail-closed: nothing else opens the native outlet - not a synthetic digest, not the zero hash,
 // and not a digest any other product lane registered.
 for(const hash of negatives()){
  assert.equal(supportsClineExecutorBuild(hash),false,hash);
  assert.equal(supportsClineExecutorTranslatedBuild(hash),false,hash);
 }
 // The translated outlets are named by the same ladder and answer their own set.
 for(const wire of TRANSLATED){
  const lane=additionalMagpieRoute('executor',concreteMagpieRoute(routeOf(wire)),capabilities(wire));
  assert.ok(lane,wire);
  assert.equal(lane.protocol,wire,wire);
  assert.equal(lane.supportsBuild,supportsClineExecutorTranslatedBuild,wire);
  for(const hash of negatives())assert.equal(lane.supportsBuild(hash),false,wire+' '+hash);
 }
});

test('the process audit says in its own shape that it is not a per-call trail',()=>{
 const audit=cliExecutorProcessAudit({runtime:'cline',commandLine:['C:/cline.exe','--json','a prompt'],
  cwd:'C:/flows/workspace',exitCode:0,modelResponses:2,toolUses:3,deniedToolResults:1,
  toolCallsByName:{run_commands:2,editor:1},
  fileChanges:[{path:'a.txt',bytes:5,sha256:'b'.repeat(64)}],
  diffSummary:{added:1,modified:0,deleted:0,bytesAdded:5},gitObserved:true,gitChanged:[]});
 // Exactly these members: a receipt carries argv, cwd, exit code, counts, the change list, the
 // summary and the git verdict - and nothing that could be read as one call's authorisation.
 assert.deepEqual(Object.keys(audit).sort(),['commandLine','cwd','diffSummary','exitCode','fileChanges','git',
  'modelResponses','perCallApproval','runtime','schema','toolCalls']);
 assert.equal(audit.schema,'dream-maker.cli-executor-audit.v1');
 assert.equal(audit.perCallApproval,false);
 // No ToolIntent and no ToolResult exists anywhere in the record: the tool calls are counts.
 const serialized=JSON.stringify(audit);
 assert.equal(/ToolIntent|ToolResult|tool_intent|tool_result/i.test(serialized),false);
 assert.deepEqual(audit.toolCalls,{total:3,refused:1,byTool:{run_commands:2,editor:1}});
 assert.deepEqual(audit.diffSummary,{added:1,modified:0,deleted:0,bytesAdded:5});
 // The record is frozen: a later stage cannot edit what the turn proved.
 assert.ok(Object.isFrozen(audit));
 assert.ok(Object.isFrozen(audit.toolCalls));
 assert.ok(Object.isFrozen(audit.git));
});

test('an installer on the CLI own stream stops the turn, and the same words elsewhere do not',()=>{
 // The fence is the CLI's own event row, at the exact shape measured on Cline 3.0.74.
 const row=command=>JSON.stringify({ts:'now',type:'agent_event',event:{type:'content_start',contentType:'tool',
  toolName:'run_commands',toolCallId:'toolu_1',input:{command}}})+'\n';
 for(const command of ['npm install left-pad','pnpm add zustand','yarn install','pip install requests',
  'python -m pip install requests','sudo -E pip install requests','cd app && npm ci']){
  assert.ok(clineInstallerCommand(command),command);
  const watcher=clineInstallWatcher();
  assert.throws(()=>watcher.push(row(command)),/CLI_INSTALL_OBSERVED/,command);
  assert.equal(watcher.violation(),command);
 }
 // A command that merely mentions an installer is not one: the matcher reads the segment head.
 for(const command of ['echo hi > out.txt','grep "npm install" notes.md','git status','node -v','npm run build'])
  assert.equal(clineInstallerCommand(command),undefined,command);
 const clean=clineInstallWatcher();
 clean.push(row('echo hi > out.txt'));
 clean.push(JSON.stringify({type:'run_result',finishReason:'completed',iterations:1})+'\n');
 assert.equal(clean.violation(),undefined);
 // A row split across chunks is still inspected once it completes, and a row that is not one of
 // the CLI's events is skipped rather than guessed at.
 const split=clineInstallWatcher();
 const body=row('npm install left-pad');
 assert.throws(()=>{split.push(body.slice(0,20)); split.push(body.slice(20));},/CLI_INSTALL_OBSERVED/);
 assert.equal(split.violation(),'npm install left-pad');
 const noise=clineInstallWatcher();
 noise.push('{not json}\n');
 noise.push(JSON.stringify({type:'hook_event',hookEventName:'tool_call'})+'\n');
 assert.equal(noise.violation(),undefined);
});

test('a git reference that moves during a turn is visible to the post-turn refusal',()=>{
 const root=mkdtempSync(join(tmpdir(),'dm-cline-git-'));
 try{
  // No .git at all is the ordinary flows workspace: nothing to watch, and the record says so.
  assert.equal(readGitRefs(root).size,0);
  // A workspace with a repository is watched by HEAD, packed-refs and every file under refs/.
  mkdirSync(join(root,'.git','refs','heads'),{recursive:true});
  writeFileSync(join(root,'.git','HEAD'),'ref: refs/heads/main\n');
  writeFileSync(join(root,'.git','refs','heads','main'),'0'.repeat(40)+'\n');
  writeFileSync(join(root,'.git','packed-refs'),'# pack-refs with: peeled\n');
  const before=readGitRefs(root);
  assert.ok(before.has('HEAD')&&before.has('refs/heads/main')&&before.has('packed-refs'));
  assert.deepEqual(gitRefChanges(before,readGitRefs(root)),[]);
  // The push this lane cannot deny in advance is exactly what this comparison catches.
  writeFileSync(join(root,'.git','refs','heads','main'),'1'.repeat(40)+'\n');
  assert.deepEqual(gitRefChanges(before,readGitRefs(root)),['refs/heads/main']);
  // A new branch, and a deleted one, are both changes rather than both invisible.
  writeFileSync(join(root,'.git','refs','heads','push-target'),'2'.repeat(40)+'\n');
  assert.deepEqual(gitRefChanges(before,readGitRefs(root)).sort(),['refs/heads/main','refs/heads/push-target']);
 } finally { rmSync(root,{recursive:true,force:true,maxRetries:3}); }
});
