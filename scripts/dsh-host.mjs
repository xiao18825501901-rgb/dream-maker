// Dream Maker's own bridge protocol, NOT the DSH SDK wire protocol.
// The operator-selected adapter is loaded in an owned child, never from generated project text.
import { pathToFileURL } from 'node:url';
import { resolve, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
const path = process.argv[2];
if (!path || !isAbsolute(path))
    throw Error('ABSOLUTE_ADAPTER_PATH_REQUIRED');
const adapter = await import(pathToFileURL(resolve(path)).href);
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
let running = false;
const control = new AbortController();
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
    if (line.length > 1000000) {
        process.exitCode = 1;
        break;
    }
    let msg;
    try {
        msg = JSON.parse(line);
    }
    catch {
        continue;
    }
    const { id, method, params } = msg;
    if (method === 'dm/initialize') {
        send({ id, result: { protocol: 'dream-maker.bridge.v1', runner: 'dsh', nativeTools: typeof adapter.run === 'function', capabilities: typeof adapter.capabilities === 'function' ? await adapter.capabilities() : { verified: false } } });
        continue;
    }
    if (running) {
        send({ id, error: { code: -32001, message: 'ONE_ACTIVE_RUN_ONLY' } });
        continue;
    }
    if (!['dm/run', 'dm/verify'].includes(method)) {
        send({ id, error: { code: -32601, message: 'UNSUPPORTED' } });
        continue;
    }
    const fn = method === 'dm/run' ? adapter.run : adapter.verify;
    if (typeof fn !== 'function') {
        send({ id, error: { code: -32601, message: 'NATIVE_VERIFIER_NOT_IMPLEMENTED' } });
        continue;
    }
    running = true;
    Promise.resolve().then(() => fn(params, e => send({ method: 'dm/event', params: { event: e } }), control.signal)).then(result => send({ id, result })).catch(error => send({ id, error: { code: -32000, message: String(error.message).slice(0, 2000) } })).finally(() => { running = false; });
}
control.abort();
if (typeof adapter.close === 'function')
    await adapter.close();
