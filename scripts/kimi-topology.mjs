#!/usr/bin/env node
// Is the Kimi topology actually serving? Answer with checks, not with assumptions.
//
// Written after a wasted hour: inside the acceptance distro there is no ss, no netstat and no curl,
// so a pipeline like `ss -ltn | grep 58713 || echo none` reports "none" whether or not anything
// listens. The Kimi server also rewrites its process title to `kimi-code`, so `ps | grep main.mjs`
// finds nothing while the server is happily serving. Both false negatives made a live backend look
// dead. This script checks the things that cannot lie: a real HTTP answer from Windows, process
// titles read from /proc, and the credential/bridge state the running app reports.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const root = resolve('.');
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const port = flag('port', '58713');
const base = flag('url', 'http://127.0.0.1:4317');
const config = JSON.parse(readFileSync(resolve(root, 'config/local.json'), 'utf8'));
const distro = process.env.DM_KIMI_BRIDGE_DISTRO ?? 'DreamMaker-Acceptance-20261011';
const report = { at: new Date().toISOString(), port, base, distro, checks: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + ' - ' + detail); return ok; };

// 1) A real HTTP answer from Windows. 401/403 means "alive but I sent no token", the healthy case
//    for an unauthenticated probe. Connection refused or an empty code means dead.
function httpCode(url) {
    try { return execFileSync('curl.exe', ['-s', '-m', '5', '-o', 'NUL', '-w', '%{http_code}', url], { encoding: 'utf8' }).trim() || '000'; }
    catch { return '000'; }
}
const serverCode = httpCode('http://127.0.0.1:' + port + '/api/v1/auth');
check('kimiServerAnswers', ['200', '401', '403'].includes(serverCode), 'GET /api/v1/auth on ' + port + ' -> HTTP ' + serverCode);

// 2) Read process titles from /proc: the server renames itself, and the distro has no ps-field we can trust.
const PY = [
    "import glob, os",
    "out = []",
    "for d in glob.glob('/proc/[0-9]*'):",
    "    try:",
    "        comm = open(d + '/comm').read().strip()",
    "        cmd = open(d + '/cmdline').read().replace(chr(0), ' ')",
    "    except OSError:",
    "        continue",
    "    if comm in ('kimi-code', 'node', 'python3') or 'bridge.py' in cmd or 'connect.py' in cmd:",
    "        out.append(comm + ' | ' + cmd[:90])",
    "print(chr(10).join(out))",
].join('\n');
function wsl(script) {
    try { return execFileSync('wsl.exe', ['-d', distro, '-u', 'root', '--exec', '/usr/bin/python3', '-c', script], { encoding: 'utf8', timeout: 60000 }); }
    catch (error) { return String(error.stdout ?? ''); }
}
const titles = wsl(PY).trim();
const titlesOk = /kimi-code/.test(titles);
check('kimiServerProcess', titlesOk, titlesOk ? 'server runs under the title "kimi-code"' : 'no kimi-code process: ' + (titles.split('\n').filter(Boolean).slice(0, 3).join(' ; ') || 'none'));
const bridgeOk = /bridge\.py/.test(titles);
check('bridgeProcess', bridgeOk, bridgeOk ? 'bridge.py is supervising' : 'no bridge.py process');
const connectorOk = /connect\.py/.test(titles);
check('connectorProcess', connectorOk, connectorOk ? 'the Windows side is attached through connect.py' : 'no connect.py: the app is not attached to the bridge');

// 3) The token mirror the app sends must exist and look like a token; never print its value.
const mirror = config.kimi?.tokenFile ?? '';
let mirrorOk = false, mirrorDetail = 'not configured';
if (mirror) {
    try { const bytes = readFileSync(mirror, 'utf8').trim(); mirrorOk = bytes.length >= 32; mirrorDetail = 'present, ' + bytes.length + ' chars'; }
    catch (error) { mirrorDetail = 'unreadable: ' + String(error.code ?? error.message); }
}
check('tokenMirror', mirrorOk, mirrorDetail);

// 4) The app's own view: credential barrier, bridge ACKs and the four-role gate.
let session = null;
try { session = JSON.parse(readFileSync(resolve(root, '.runtime/session.json'), 'utf8')); } catch { }
if (!session?.cookie) check('appDiagnostics', false, 'no .runtime/session.json; bootstrap the app first');
else {
    const get = async path => { const response = await fetch(base + path, { headers: { cookie: session.cookie } }); return { status: response.status, body: await response.json().catch(() => null) }; };
    try {
        const status = await get('/api/kimi/status');
        const credentials = status.body?.credentials ?? {};
        check('credentialBarrier', credentials.barrier === 'READY' && credentials.state === 'OK', 'barrier=' + credentials.barrier + ' state=' + credentials.state + ' generation=' + credentials.generation);
        const native = await get('/api/native/probes');
        report.native = native.body;
        console.log('INFO native gate: ' + JSON.stringify(native.body?.roles ?? native.body));
    }
    catch (error) { check('appDiagnostics', false, 'app not reachable at ' + base + ' (' + String(error.code ?? error.message).slice(0, 60) + ')'); }
}
const failed = report.checks.filter(c => !c.ok);
console.log(failed.length === 0 ? 'TOPOLOGY_READY' : 'TOPOLOGY_NOT_READY - ' + failed.map(c => c.name).join(', '));
console.log(JSON.stringify(report));
process.exitCode = failed.length === 0 ? 0 : 1;
