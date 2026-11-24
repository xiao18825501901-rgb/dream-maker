#!/usr/bin/env node
// Measure what \`codex exec --json\` emits and what it posts, against a loopback Responses stub.
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {capture} from '../dist/server/process.js';
import {childEnv} from '../dist/server/security.js';
import {responsesEvents} from '../dist/server/flow/responses-wire.js';
const EXE = process.argv[2];
const model = 'claude-sonnet-5';
const root = mkdtempSync('E:/DreamMakerSuite/custom-mvp/parallel/codex-probe-');
const workspace = join(root,'workspace'); mkdirSync(workspace,{recursive:true});
const seen = [];
const server = createServer(async (req,res) => {
    let raw=''; for await (const chunk of req) raw += chunk;
    seen.push({url:req.url, bytes:raw.length, keys:Object.keys(JSON.parse(raw||'{}')).sort()});
    const reply = responsesEvents({id:'resp_probe_1', model, content:'CODEX_EXEC_REPLY', toolCalls:[], usage:{prompt_tokens:5, completion_tokens:3}});
    res.writeHead(200,{'content-type':'text/event-stream'}); res.end(reply);
});
await new Promise(done => server.listen(0,'127.0.0.1',done));
const base = 'http://127.0.0.1:' + server.address().port + '/v1';
const home = join(root,'home'); mkdirSync(home,{recursive:true});
const env = childEnv({HOME:home, USERPROFILE:home, APPDATA:home, LOCALAPPDATA:home, TEMP:join(root,'tmp'), TMP:join(root,'tmp'),
    XDG_CONFIG_HOME:join(home,'config'), CODEX_HOME:join(home,'codex'), DM_GATEWAY_TOKEN:'DM_SYNTHETIC_CODEX_TOKEN_0123456789',
    HTTPS_PROXY:'http://127.0.0.1:1', HTTP_PROXY:'http://127.0.0.1:1', ALL_PROXY:'http://127.0.0.1:1', NO_PROXY:'127.0.0.1,localhost'});
mkdirSync(join(root,'tmp'),{recursive:true}); mkdirSync(join(home,'config'),{recursive:true}); mkdirSync(join(home,'codex'),{recursive:true});
delete env.Path; env.PATH = join(process.env.SystemRoot ?? 'C:/Windows','System32');
const args = ['exec','--json','--skip-git-repo-check','--sandbox','workspace-write','-C',workspace,'--model',model,
    '-c','model_providers.dm={name="dm",base_url="'+base+'",env_key="DM_GATEWAY_TOKEN",wire_api="responses"}',
    '-c','model_provider="dm"','Reply with CODEX_EXEC_REPLY.'];
const started = Date.now();
const out = await capture(EXE, args, {cwd:workspace, env, timeoutMs:90000, maxBytes:4*1024*1024, input:'', maxInputBytes:4096}).catch(error => ({stdout:'', stderr:String(error?.code ?? error), code:-1}));
server.close();
console.log(JSON.stringify({elapsedMs:Date.now()-started, code:out.code, requests:seen, stdout:out.stdout.slice(0,6000), stderr:out.stderr.slice(0,1200)}, null, 1));
