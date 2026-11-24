// The DM desk_* MCP server: protocol, broker forward, and the audit rows it produces.
// Offline: a loopback broker and synthetic bindings only, no model request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { serveDeskMcp, readDeskMcpBinding, deskMcpTools, DESK_MCP_TOOLS } from '../dist/server/providers/desk-mcp-stdio.js';
import { writeDeskMcpConfig, DESK_MCP_SERVER, deskMcpModulePath } from '../dist/server/providers/desk-mcp.js';
import { startToolBroker } from '../dist/server/tool-broker.js';
import { root, harness, ready } from './helpers.mjs';
import { createExecutorTools } from '../dist/server/executor-tools.js';
import { hash } from '../dist/server/security.js';
import { treeHash } from '../dist/server/workspace.js';
import { captureSource } from '../dist/server/review-packet.js';
import { installPrework } from '../dist/server/prework/runtime.js';

const token = () => randomBytes(32).toString('hex');
const bindingOf = (url) => ({ url, token: token() });

/** Drive the stdio server through a duplex pair and collect every JSON-RPC reply by id. */
function driver(options = {}) {
  const stdin = new PassThrough(), stdout = new PassThrough();
  const replies = new Map(), seen = [];
  const lines = createInterface({ input: stdout, crlfDelay: Infinity });
  lines.on('line', line => { const row = JSON.parse(line); seen.push(row); if (row.id !== undefined) replies.set(row.id, row); });
  const finished = serveDeskMcp({ binding: options.binding, stdin, stdout });
  const send = row => stdin.write(JSON.stringify(row) + '\n');
  const call = async (id, method, params) => {
    send({ jsonrpc: '2.0', id, method, params });
    for (let i = 0; i < 400 && !replies.has(id); i++) await new Promise(r => setTimeout(r, 10));
    const reply = replies.get(id);
    if (!reply) throw new Error('no reply for id ' + id);
    return reply;
  };
  return { call, send, seen, stdout, close: async () => { stdin.end(); await finished; } };
}

test('a desk MCP binding is loopback-only and env-only', () => {
  const good = 'http://127.0.0.1:4317/tools', hex = token();
  assert.deepEqual(readDeskMcpBinding({ DM_DESK_MCP_URL: good, DM_DESK_MCP_TOKEN: hex }), { url: good, token: hex });
  for (const [url, node] of [['https://127.0.0.1:4317/tools', 'scheme'], ['http://127.0.0.1:4317/other', 'path'],
    ['http://evil.invalid:4317/tools', 'host'], ['http://127.0.0.1:4317/tools?x=1', 'query'], ['http://user:pw@127.0.0.1:4317/tools', 'userinfo']])
    assert.equal(readDeskMcpBinding({ DM_DESK_MCP_URL: url, DM_DESK_MCP_TOKEN: hex }), undefined, node);
  assert.equal(readDeskMcpBinding({ DM_DESK_MCP_URL: good, DM_DESK_MCP_TOKEN: 'short' }), undefined);
  assert.equal(readDeskMcpBinding({}), undefined);
});

test('the server advertises exactly the two read-only desk tools', async () => {
  assert.deepEqual([...DESK_MCP_TOOLS], ['desk_read', 'desk_search']);
  const d = driver({ binding: bindingOf('http://127.0.0.1:1/tools') });
  const init = await d.call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'dream-maker-desk');
  const list = await d.call(2, 'tools/list');
  assert.deepEqual(list.result.tools.map(t => t.name), ['desk_read', 'desk_search']);
  assert.deepEqual(list.result.tools[0].inputSchema.required, ['path']);
  assert.equal(list.result.tools[0].inputSchema.additionalProperties, false);
  const ping = await d.call(3, 'ping'); assert.deepEqual(ping.result, {});
  const unknown = await d.call(4, 'tools/call', { name: 'desk_run', arguments: {} });
  assert.equal(unknown.error.code, -32602);
  assert.match(unknown.error.message, /DESK_MCP_TOOL_UNKNOWN: desk_run/);
  await d.close();
});

test('every MCP call is forwarded to the broker with the executor role and the model arguments', async t => {
  const seen = [];
  const broker = await startToolBroker({ dispatch: async (role, name, args) => { seen.push({ role, name, args }); return { content: 'done', sha256: 'abc' }; } });
  t.after(() => broker.close());
  const d = driver({ binding: { url: broker.url, token: broker.token } });
  await d.call(1, 'initialize', {});
  const read = await d.call(2, 'tools/call', { name: 'desk_read', arguments: { path: 'src/main.ts' } });
  assert.equal(read.result.isError, undefined);
  assert.deepEqual(JSON.parse(read.result.content[0].text), { content: 'done', sha256: 'abc' });
  const search = await d.call(3, 'tools/call', { name: 'desk_search', arguments: { text: 'needle' } });
  assert.equal(search.result.isError, undefined);
  assert.deepEqual(seen, [{ role: 'executor', name: 'desk_read', args: { path: 'src/main.ts' } },
    { role: 'executor', name: 'desk_search', args: { text: 'needle' } }]);
  await d.close();
});

test('a broker refusal reaches the model as an MCP error carrying the broker code, not a silent pass', async t => {
  const broker = await startToolBroker({ dispatch: async () => { const { DomainError } = await import('../dist/server/security.js'); throw new DomainError('PREWORK_SCOPE_INVALID', 403); } });
  t.after(() => broker.close());
  const d = driver({ binding: { url: broker.url, token: broker.token } });
  await d.call(1, 'initialize', {});
  const reply = await d.call(2, 'tools/call', { name: 'desk_read', arguments: { path: 'secret.txt' } });
  assert.equal(reply.result.isError, true);
  assert.deepEqual(JSON.parse(reply.result.content[0].text), { error: 'PREWORK_SCOPE_INVALID' });
  await d.close();
});

test('the MCP config file carries the token in the file, never in the caller argv', async t => {
  const dir = mkdtempSync(resolve(root, '.runtime/test-temp', 'desk-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binding = bindingOf('http://127.0.0.1:5000/tools');
  const written = writeDeskMcpConfig({ directory: dir, binding, command: process.execPath });
  assert.equal(existsSync(written.configPath), true);
  const config = JSON.parse(readFileSync(written.configPath, 'utf8'));
  const server = config.mcpServers[DESK_MCP_SERVER];
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, [deskMcpModulePath()]);
  assert.deepEqual(server.env, { DM_DESK_MCP_URL: binding.url, DM_DESK_MCP_TOKEN: binding.token });
  assert.equal(written.allowedTools, 'mcp__dm__desk_read mcp__dm__desk_search');
  assert.equal(written.configPath.includes(binding.token), false);
  // A non-loopback or malformed binding is refused before anything is written.
  for (const url of ['http://10.0.0.5:5000/tools', 'https://127.0.0.1:5000/tools', 'http://127.0.0.1:5000/elsewhere'])
    assert.throws(() => writeDeskMcpConfig({ directory: dir, binding: { url, token: binding.token }, command: process.execPath }), { code: 'DESK_MCP_BINDING_INVALID' });
});

test('the CLI shim refuses to start without a valid env binding', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(process.execPath, [deskMcpModulePath()], { env: { ...process.env, DM_DESK_MCP_URL: 'http://10.0.0.5/tools' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /DESK_MCP_BINDING_INVALID/);
});

// ---------------------------------------------------------------------------------------------
// The point of the whole module: a model tool call routed through MCP must produce the SAME
// journal rows the in-process runtimes produce — one ToolIntent and one ToolResult per call.
// This uses the real createExecutorTools authority chain, not a spy.
// ---------------------------------------------------------------------------------------------
const archon='C:/Users/Hp/Documents/Archon_Astra_DSH_Source_Package/Archon_Astra_DSH_Source_Package';
async function auditRig(t){
 const h=harness(t),{p,s}=await ready(h),created=h.engine.create(p.id,s.hash,true);
 await h.engine.cancel(created.id);await h.engine.settled(created.id);
 const run=h.store.run(created.id);run.state='IMPLEMENTING';run.phase='IMPLEMENTING';h.store.saveRun(run);h.store.acquire(p.id,run.id);
 const project=h.store.project(p.id);project.activeRunId=run.id;h.store.saveProject(project);
 mkdirSync(run.workspace,{recursive:true});writeFileSync(resolve(run.workspace,'main.mjs'),'console.log(1);\n');
 if(!run.tasks.length)run.tasks=[{id:'OFFLINE_FILE_TASK',title:'synthetic file fixture',status:'pending',dependsOn:[],requirementIds:s.requirements.map(x=>x.id),acceptance:['offline file authority'],writePaths:['main.mjs','src/']}];
 if(!h.store.records(p.id,'SourceSnapshot').some(x=>x.runId===run.id&&x.data.stage==='BASELINE'))h.store.record('SourceSnapshot',p.id,run.id,captureSource(run.workspace,{runId:run.id,specHash:run.specHash},'BASELINE'));
 delete run.prework;run.treeHash=treeHash(run.workspace);h.store.saveRun(run);installPrework(h.store,run.id);
 const module=resolve(archon,'dist/provider/file-tools.js'),io=resolve(archon,'dist/core/io.js');
 const binding={modulePath:module,dependencies:[{path:module,sha256:hash(readFileSync(module))},{path:io,sha256:hash(readFileSync(io))}],readPaths:['main.mjs','src'],writePaths:['main.mjs','src']};
 const tools=await createExecutorTools(h.store,()=>h.config,run.id,binding,{run:async()=>{throw Error('NO_OS_CALL_ALLOWED');}});
 return{h,p,run,tools};
}
const rows=(h,p,run)=>h.store.records(p.id).filter(r=>r.runId===run.id&&(r.kind==='ToolIntent'||r.kind==='ToolResult'));

test('a desk_read through MCP writes exactly one ToolIntent and one COMPLETE ToolResult',async t=>{
 const f=await auditRig(t);
 const broker=await startToolBroker(f.tools);t.after(()=>broker.close());
 const d=driver({binding:{url:broker.url,token:broker.token}});
 await d.call(1,'initialize',{});
 assert.equal(rows(f.h,f.p,f.run).length,0);
 const reply=await d.call(2,'tools/call',{name:'desk_read',arguments:{path:'main.mjs'}});
 assert.equal(reply.result.isError,undefined);
 const body=JSON.parse(reply.result.content[0].text);
 assert.equal(body.content,'console.log(1);\n');
 const after=rows(f.h,f.p,f.run),intents=after.filter(r=>r.kind==='ToolIntent'),results=after.filter(r=>r.kind==='ToolResult');
 assert.equal(intents.length,1);assert.equal(results.length,1);
 assert.equal(intents[0].data.tool,'desk_read');assert.match(intents[0].data.requestHash,/^[a-f0-9]{64}$/);
 assert.equal(results[0].data.status,'COMPLETE');assert.equal(results[0].data.intentId,intents[0].id);
 assert.equal(results[0].data.responseHash,hash(body));
 await d.close();
});

test('a second call adds a second pair, so the journal is per-call and not per-process',async t=>{
 const f=await auditRig(t);
 const broker=await startToolBroker(f.tools);t.after(()=>broker.close());
 const d=driver({binding:{url:broker.url,token:broker.token}});
 await d.call(1,'initialize',{});
 await d.call(2,'tools/call',{name:'desk_read',arguments:{path:'main.mjs'}});
 await d.call(3,'tools/call',{name:'desk_search',arguments:{text:'console'}});
 const intents=rows(f.h,f.p,f.run).filter(r=>r.kind==='ToolIntent');
 assert.equal(intents.length,2);
 assert.deepEqual(intents.map(r=>r.data.tool),['desk_read','desk_search']);
 await d.close();
});

test('a call the prework scope refuses leaves no journal row and tells the model why',async t=>{
 const f=await auditRig(t);
 const broker=await startToolBroker(f.tools);t.after(()=>broker.close());
 const d=driver({binding:{url:broker.url,token:broker.token}});
 await d.call(1,'initialize',{});
 const reply=await d.call(2,'tools/call',{name:'desk_read',arguments:{path:'README.md'}});
 assert.equal(reply.result.isError,true);
 assert.deepEqual(JSON.parse(reply.result.content[0].text),{error:'PREWORK_SCOPE_INVALID'});
 assert.equal(rows(f.h,f.p,f.run).length,0);
 await d.close();
});
