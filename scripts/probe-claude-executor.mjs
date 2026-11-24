#!/usr/bin/env node
// Reproduce the Claude Code executor evidence recorded in docs/CLI_EXECUTOR_FEASIBILITY.md.
//
//   node scripts/probe-claude-executor.mjs --claude <path/to/claude.exe> [--workspace <dir>]
//
// The harness starts a stub Anthropic Messages server on 127.0.0.1 (its only network peer),
// points the real CLI at it, and asks the model to make exactly one tool call. Scenarios:
//
//   write   the CLI must create a file inside its working directory
//   bash    the CLI must run a shell command inside its working directory
//   escape  a write one level above cwd must be refused, and the file must not exist
//   push    a git push must be refused by --disallowedTools
//
// Each result carries the process exit code, so 'the exit code is trustworthy' stays a measured
// claim. Nothing here reaches a model provider and nothing is charged.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf('--' + name); return i === -1 ? undefined : argv[i + 1]; };
const CLAUDE = opt('claude');
if (!CLAUDE || !existsSync(CLAUDE)) { console.error('usage: node scripts/probe-claude-executor.mjs --claude <claude.exe> [--workspace <dir>]'); process.exit(2); }
const BASE = resolve(opt('workspace') ?? join(tmpdir(), 'dm-claude-executor-probe'));
const SCENARIOS = ['write', 'bash', 'escape', 'push'];
const DENY = 'WebFetch WebSearch Bash(git push:*)';

function frame(type, data) { return 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n'; }
function sse(res, frames) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const f of frames) res.write(frame(f.type, f));
    res.end();
}
const start = (model, turn) => ({ type: 'message_start', message: { id: 'msg_stub_' + turn, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 1 } } });
const block = (i, b) => ({ type: 'content_block_start', index: i, content_block: b });
const delta = (i, d) => ({ type: 'content_block_delta', index: i, delta: d });
const stopBlock = (i) => ({ type: 'content_block_stop', index: i });
const endMsg = (reason) => ({ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 21 } });

function runScenario(scenario) {
    return new Promise((resolvePromise) => {
        const ws = join(BASE, scenario);
        rmSync(ws, { recursive: true, force: true });
        mkdirSync(ws, { recursive: true });
        writeFileSync(join(ws, 'seed.txt'), 'seed\n');
        const home = join(ws, '.home');
        for (const d of ['config', 'tmp']) mkdirSync(join(home, d), { recursive: true });
        let turn = 0, requests = [], toolFrames = [], written = null, bashOut = null, denied = null;
        const server = createServer(async (req, res) => {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            let body = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* keep going */ }
            const model = typeof body.model === 'string' ? body.model : 'claude-sonnet-5';
            const names = (body.tools || []).map((t) => t.name);
            const hasToolResult = JSON.stringify(body.messages || []).includes('tool_result');
            turn += 1;
            requests.push({ turn, path: req.url, model, tools: names, hasToolResult });
            if (!hasToolResult) {
                const toolName = scenario === 'bash' || scenario === 'push' ? 'Bash' : 'Write';
                if (!names.includes(toolName)) {
                    sse(res, [start(model, turn), block(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'tool not offered: ' + toolName }), stopBlock(0), endMsg('end_turn'), { type: 'message_stop' }]);
                    return;
                }
                const input = toolName === 'Bash'
                    ? { command: scenario === 'push' ? 'git push origin main' : 'echo executed-by-stub > bash-out.txt', description: 'probe' }
                    : { file_path: scenario === 'escape' ? join(ws, '..', 'escape-outside.txt') : join(ws, 'written-by-claude.txt'), content: 'hello from stub\n' };
                sse(res, [start(model, turn),
                    block(0, { type: 'tool_use', id: 'toolu_stub_1', name: toolName, input: {} }),
                    delta(0, { type: 'input_json_delta', partial_json: JSON.stringify(input) }),
                    stopBlock(0), endMsg('tool_use'), { type: 'message_stop' }]);
                return;
            }
            sse(res, [start(model, turn), block(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'EXECUTOR_TURN_COMPLETE' }), stopBlock(0), endMsg('end_turn'), { type: 'message_stop' }]);
        });
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            const env = {
                ...process.env,
                ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + port,
                ANTHROPIC_API_KEY: 'sk-ant-stub-0000000000000000',
                CLAUDE_CONFIG_DIR: join(home, 'config'), HOME: home, USERPROFILE: home,
                TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'),
                DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
                CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048',
                HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
                NO_PROXY: '127.0.0.1,localhost',
            };
            const args = ['-p', '--tools', 'Read,Edit,Write,Bash', '--disallowedTools', DENY,
                '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
                '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
                '--setting-sources', '', '--settings', '{}', '--no-session-persistence',
                '--disable-slash-commands', '--output-format', 'stream-json', '--verbose',
                '--model', 'claude-sonnet-5', '--add-dir', ws];
            const child = spawn(CLAUDE, args, { cwd: ws, env, stdio: ['pipe', 'pipe', 'pipe'] });
            let stdout = '', stderr = '';
            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', (d) => { stderr += d.toString(); });
            child.stdin.end('Use the requested tool once, then stop.');
            const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 120000);
            child.on('exit', (code, signal) => {
                clearTimeout(timer);
                server.close();
                for (const line of stdout.split(/\r?\n/)) {
                    if (!line.includes('"tool_result"')) continue;
                    try {
                        const row = JSON.parse(line), part = row.message.content[0];
                        toolFrames.push({ isError: part.is_error === true, text: String(part.content).slice(0, 120), decision: (row.tool_result_meta || [{}])[0].permission_decision });
                        if (part.is_error === true) denied = String(part.content);
                    } catch { /* a non-JSON line is not evidence */ }
                }
                written = existsSync(join(ws, 'written-by-claude.txt')) ? readFileSync(join(ws, 'written-by-claude.txt'), 'utf8') : null;
                bashOut = existsSync(join(ws, 'bash-out.txt')) ? readFileSync(join(ws, 'bash-out.txt'), 'utf8') : null;
                const outside = existsSync(join(ws, '..', 'escape-outside.txt'));
                resolvePromise({ scenario, exit: { code, signal }, requests, toolFrames, written, bashOut, escapedOutsideCwd: outside, denied, stderr: stderr.slice(0, 400) });
            });
        });
    });
}

const results = [];
mkdirSync(BASE, { recursive: true });
for (const scenario of SCENARIOS) results.push(await runScenario(scenario));
console.log(JSON.stringify({ claude: CLAUDE, workspace: BASE, results }, null, 2));
const failed = results.filter((r) => r.exit.code !== 0);
if (failed.length) { console.error('scenarios with a non-zero exit: ' + failed.map((r) => r.scenario).join(',')); process.exit(1); }
