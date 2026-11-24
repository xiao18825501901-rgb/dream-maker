#!/usr/bin/env node
// HARNESS-ONLY physical check for the Codex executor's Messages outlet.
//
//   node scripts/accept-codex-executor-messages-harness.mjs --codex <codex.exe> [--out <json>]
//
// This script does NOT replace the product acceptance (accept-codex-executor-messages.mjs) and its
// result must never register a build digest. It exists because the Go control plane in the build in
// hand still refuses issuance for a codex executor on the anthropic-messages wire
// (overlay/internal/dmbridge/gate.go, ExplicitRouteAllowed, case "anthropic-messages"), so the
// product path can be exercised only up to that refusal. What this script isolates is everything
// BELOW the Magpie hop, with the real installed CLI:
//
//   codex 0.171.0 -> a loopback stand-in for the product gateway
//     -> the real flow/cli-executor-wire.ts exchange (Responses ingress -> Messages body)
//     -> a loopback Messages fixture (two rounds: tool_use, then terminal text)
//     -> back through the same exchange (Messages read -> rebuilt function_call events) -> the CLI
//
// It answers one question the Go-refused run cannot: does codex 0.171.0 read back the Responses
// events this product rebuilds from an Anthropic tool_use answer, run the tool, replay the call and
// finish on text? Zero paid calls; nothing outside 127.0.0.1 is dialled.
import {createHash,randomBytes} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createServer as http} from 'node:http';
import {join,resolve} from 'node:path';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf('--' + name); return i === -1 ? undefined : argv[i + 1]; };
if (!opt('codex') || !existsSync(opt('codex'))) {
    console.error('usage: node scripts/accept-codex-executor-messages-harness.mjs --codex <codex.exe> [--out <json>]');
    process.exit(2);
}
const CODEX = resolve(opt('codex'));
const OUT = opt('out') ?? resolve('.runtime/accept-codex-executor-messages-harness.json');
const sha = value => createHash('sha256').update(value).digest('hex');
const CODEX_SHA = sha(readFileSync(CODEX));

const {createCliExecutorExchange} = await import('../dist/server/flow/cli-executor-wire.js');
const {runCliExecutorTurn} = await import('../dist/server/providers/cli-executor.js');

const provider = 'fixture', model = 'claude-sonnet-5', qualified = provider + '/' + model;
const PROMPT = 'Run one command and report CODEX_MESSAGES_DONE.';
const ANSWER = 'CODEX_MESSAGES_DONE';
const TOKEN = randomBytes(24).toString('hex');
const route = {runtime:'codex', provider, protocol:'anthropic-messages', model, authentication:'api_key',
    authRef:'AUTH_CODEX_M', accountRef:'ACCOUNT_CODEX_M', upstreamAccountRef: provider + '/offline_peer'};
const accounts = [{...route, capabilities:[{model, protocol:'anthropic-messages'}]}];

const frame = (type, fields) => 'event: ' + type + '\ndata: ' + JSON.stringify({type, ...fields}) + '\n\n';
const startFrame = id => frame('message_start', {message:{id, type:'message', role:'assistant', model:qualified,
    content:[], stop_reason:null, stop_sequence:null,
    usage:{input_tokens:13, cache_read_input_tokens:0, cache_creation_input_tokens:0, output_tokens:0}}});

/** Round one: one Anthropic tool_use block naming the CLI's own exec_command. */
function toolReply() {
    const args = JSON.stringify({cmd:'echo CODEX_MESSAGES_OK'});
    return startFrame('msg_round_1')
        + frame('content_block_start', {index:0, content_block:{type:'tool_use', id:'call_msg_1', name:'exec_command', input:{}}})
        + frame('content_block_delta', {index:0, delta:{type:'input_json_delta', partial_json:args}})
        + frame('content_block_stop', {index:0})
        + frame('message_delta', {delta:{stop_reason:'tool_use', stop_sequence:null}, usage:{output_tokens:9}})
        + frame('message_stop', {});
}

/** Round two: the terminal text, in the same dialect. */
function textReply() {
    return startFrame('msg_round_2')
        + frame('content_block_start', {index:0, content_block:{type:'text', text:''}})
        + frame('content_block_delta', {index:0, delta:{type:'text_delta', text:ANSWER}})
        + frame('content_block_stop', {index:0})
        + frame('message_delta', {delta:{stop_reason:'end_turn', stop_sequence:null}, usage:{output_tokens:5}})
        + frame('message_stop', {});
}

const state = {requests:0, bodies:[], errors:[], cliText:''};
const fixture = http(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/messages') { res.writeHead(404); res.end(); return; }
    const bytes = [];
    for await (const chunk of req) bytes.push(chunk);
    const raw = Buffer.concat(bytes).toString('utf8');
    state.requests += 1;
    state.bodies.push({raw, body:JSON.parse(raw), headers:{...req.headers}});
    res.writeHead(200, {'content-type':'text/event-stream'});
    res.end(state.requests === 1 ? toolReply() : textReply());
});
await new Promise(done => fixture.listen(0,'127.0.0.1',done));
const fixturePort = fixture.address().port;

/** A stand-in for the product gateway: the real exchange, minus the governed Magpie hop. */
const gateway = http(async (req, res) => {
    try {
        if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404); res.end(); return; }
        if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401); res.end(); return; }
        const bytes = [];
        for await (const chunk of req) bytes.push(chunk);
        const body = Buffer.concat(bytes).toString('utf8');
        const exchange = createCliExecutorExchange({route, role:'executor', accounts,
            limits:{model, maxInputTokens:1048576, maxOutputTokens:512},
            assertCurrent(){}, assertSafe(){}, signal:AbortSignal.timeout(120000)});
        const prepared = exchange.prepare({method:'POST', path:'/v1/responses',
            contentType:String(req.headers['content-type']), body});
        const upstream = await fetch('http://127.0.0.1:' + fixturePort + '/v1/messages', {method:'POST',
            headers:{'content-type':'application/json','anthropic-version':'2023-06-01'}, body:prepared.body});
        const done = await prepared.complete(upstream);
        state.cliText = done.sse;
        res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-store'});
        res.end(done.sse);
    } catch (error) {
        state.errors.push({code:String(error?.code ?? error), message:String(error?.message ?? '').slice(0,300)});
        if (!res.headersSent) res.writeHead(502, {'content-type':'application/json'});
        res.end(JSON.stringify({error:String(error?.code ?? error)}));
    }
});
await new Promise(done => gateway.listen(0,'127.0.0.1',done));
const address = {url:'http://127.0.0.1:' + gateway.address().port, token:TOKEN};

const base = resolve('.runtime/test-temp');
mkdirSync(base,{recursive:true});
const root = mkdtempSync(join(base,'codex-executor-messages-harness-'));
const workspace = join(root,'workspace'), profile = join(root,'profile'), dataDir = join(root,'data');
const out = {runtime:'codex', outlet:'anthropic-messages', mode:'HARNESS_ONLY_NO_MAGPIE_HOP', cli:{path:CODEX, sha256:CODEX_SHA}};
try {
    for (const dir of [workspace, profile, dataDir, join(profile,'AppData/Roaming'), join(profile,'AppData/Local'), join(dataDir,'cache'), join(dataDir,'state'), join(root,'.runtime')]) mkdirSync(dir,{recursive:true});
    writeFileSync(join(workspace,'seed.txt'), 'seed\n');
    // The owned-process wrapper compiles this from the controller root at spawn time.
    mkdirSync(join(root,'scripts','isolation'),{recursive:true});
    copyFileSync(resolve('scripts/isolation/windows-owned-job.cs'), join(root,'scripts','isolation','windows-owned-job.cs'));
    const observation = await runCliExecutorTurn({runtime:'codex', commandRef:{path:CODEX, sha256:CODEX_SHA},
        controllerRoot:root, workspace, gatewayUrl:address.url, gatewayToken:address.token, model,
        prompt:PROMPT, signal:AbortSignal.timeout(180000), timeoutMs:120000, maxOutputTokens:512, assertCurrent:() => {}});
    const first = state.bodies[0]?.body ?? {}, second = state.bodies[1]?.body ?? {};
    const firstKeys = state.bodies.length ? Object.keys(first).sort() : [];
    const blocks = (body) => (Array.isArray(body.messages) ? body.messages : [])
        .flatMap(message => (Array.isArray(message.content) ? message.content : []).map(block => ({role:message.role, ...block})));
    const asked = blocks(second).filter(block => block.type === 'tool_use');
    const answered = blocks(second).filter(block => block.type === 'tool_result');
    const checks = {
        twoRounds: state.requests === 2 && observation.modelResponses === 2,
        messagesBodyShape: JSON.stringify(firstKeys) === JSON.stringify(['max_tokens','messages','model','stream','system','tools']),
        schemaDeclarations: (first.tools ?? []).every(tool => tool.input_schema && tool.parameters === undefined),
        toolsVisible: (first.tools ?? []).map(tool => tool.name).includes('exec_command'),
        callReplayed: asked.some(block => block.name === 'exec_command') && answered.length >= 1,
        resultAnswersTheCall: answered.every(block => asked.some(call => call.id === block.tool_use_id)),
        cliToolRan: observation.toolUses >= 1 && observation.toolResults >= 1,
        exitCodeZero: observation.exitCode === 0,
        textAnswer: observation.text.trim() === ANSWER,
        noUpstreamError: state.errors.length === 0,
    };
    Object.assign(out, {pass:Object.values(checks).every(Boolean), checks, text:observation.text,
        modelResponses:observation.modelResponses, toolUses:observation.toolUses, toolResults:observation.toolResults,
        requestTools:(first.tools ?? []).map(tool => tool.name), firstRequestBodyKeys:firstKeys,
        firstBodyBlocks:blocks(first).map(block => block.role + ':' + block.type),
        secondBodyBlocks:blocks(second).map(block => block.role + ':' + block.type + (block.name ? ':' + block.name : '')),
        asked, answered, errors:state.errors, commandLine:observation.commandLine,
        cliEventTypes:[...new Set((state.cliText.match(/^event: (.+)$/gm) ?? []).map(line => line.slice(7)))],
        physical:{requests:state.requests, network:'127.0.0.1 only'}});
} catch (error) {
    Object.assign(out, {pass:false, error:String(error?.code ?? error), message:String(error?.message ?? '').slice(0,400), errors:state.errors,
        physical:{requests:state.requests}});
} finally {
    await new Promise(done => gateway.close(done));
    await new Promise(done => fixture.close(done));
    try { rmSync(root,{recursive:true, force:true}); } catch {}
}
mkdirSync(resolve(OUT,'..'),{recursive:true});
writeFileSync(OUT, JSON.stringify({schema:'dream-maker.codex-executor-messages-harness.v1', paidCalls:0,
    network:'127.0.0.1 only', registersDigest:false, codex:out}, null, 2) + '\n');
console.log('CODEX_MESSAGES_HARNESS ' + JSON.stringify(out));
process.exit(out.pass ? 0 : 1);
