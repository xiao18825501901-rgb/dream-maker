import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
const {createCliExecutorExchange} = await import('../dist/server/flow/cli-executor-wire.js');

const base = resolve('.runtime/test-temp'); mkdirSync(base,{recursive:true});
const root = mkdtempSync(join(base,'probe-body-')), workspace = join(root,'workspace');
mkdirSync(workspace,{recursive:true});
writeFileSync(join(workspace,'seed.txt'),'seed\n');
const MODEL = 'flash-executor-1';
const bodies = [];
const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    bodies.push({url:req.url, headers:{...req.headers}, body});
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_probe","type":"message","role":"assistant","model":"'+MODEL+'","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PROBE_DONE"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
});
await new Promise(done => server.listen(0,'127.0.0.1',done));
const port = server.address().port;
const home = mkdtempSync(join(root,'home-'));
for (const part of ['config','tmp','appdata','localappdata']) mkdirSync(join(home,part),{recursive:true});
const claude = resolve(process.argv[2]);
const env = {...process.env};
for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) delete env[key];
Object.assign(env,{HOME:home,USERPROFILE:home,CLAUDE_CONFIG_DIR:join(home,'config'),APPDATA:join(home,'appdata'),
    LOCALAPPDATA:join(home,'localappdata'),TEMP:join(home,'tmp'),TMP:join(home,'tmp'),
    ANTHROPIC_API_KEY:'DM_SYNTHETIC_probe_key_value_1234',ANTHROPIC_BASE_URL:'http://127.0.0.1:'+port,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'});
const child = spawn(claude,['--print','--tools','Read,Edit,Write,Bash','--permission-mode','acceptEdits',
    '--permission-prompts','none','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','',
    '--settings','{}','--no-session-persistence','--disable-slash-commands','--output-format','stream-json','--verbose',
    '--model',MODEL,'--add-dir',workspace],{cwd:workspace,env,stdio:['pipe','pipe','pipe']});
child.stdin.end('Write the file, then report.');
await new Promise(done => child.on('close',done));
server.close();
writeFileSync(resolve('.runtime/probe-body.json'), bodies[0]?.body ?? '{}');
console.log('captured', bodies.length, 'request(s); url=' + bodies[0]?.url);
// Now run the lane's own parser over it and bisect the refusal.
const route = {runtime:'claude',provider:'fixture',protocol:'chat-completions',model:MODEL,authentication:'api_key',
    authRef:'A',accountRef:'a:1',upstreamAccountRef:'fixture/u'};
const context = {route,role:'executor',accounts:[{...route,capabilities:[{model:MODEL,protocol:'chat-completions'}]}],
    limits:{model:MODEL,maxInputTokens:4096,maxOutputTokens:512},assertCurrent(){},assertSafe(){},signal:new AbortController().signal};
const ingress = {method:'POST',path:bodies[0]?.url ?? '/v1/messages',version:bodies[0]?.headers['anthropic-version'] ?? '2023-06-01',
    contentType:bodies[0]?.headers['content-type'] ?? 'application/json',body:bodies[0]?.body ?? '{}'};
const parsed = JSON.parse(ingress.body);
const probe = (label, body) => {
    try { createCliExecutorExchange(context).prepare({...ingress, body:JSON.stringify(body)}); console.log('OK   ', label); return true; }
    catch (error) { console.log('FAIL ', label, '->', String(error?.code ?? error)); return false; }
};
console.log('top-level keys:', Object.keys(parsed).sort().join(','));
try { createCliExecutorExchange(context).prepare(ingress); console.log('OK    as captured'); }
catch (error) { console.log('STACK:\n' + String(error?.stack ?? error).split('\n').slice(0, 12).join('\n')); }
probe('as captured', parsed);
for (const drop of ['metadata','context_management','output_config','thinking','tools','system']) {
    const clone = structuredClone(parsed); delete clone[drop]; probe('without ' + drop, clone);
}
for (const role of ['system']) {
    const clone = structuredClone(parsed); clone.messages = clone.messages.filter(m => m.role !== role);
    probe('without ' + role + ' messages', clone);
}
if (parsed.thinking) console.log('thinking:', JSON.stringify(parsed.thinking));
if (parsed.output_config) console.log('output_config:', JSON.stringify(parsed.output_config).slice(0,300));
if (parsed.context_management) console.log('context_management:', JSON.stringify(parsed.context_management).slice(0,400));
if (parsed.tools) console.log('tool[0] keys:', Object.keys(parsed.tools[0] ?? {}).join(','));
console.log('message roles:', parsed.messages.map(m => m.role).join(','));
