#!/usr/bin/env node
/**
 * Archon Agent Desk — DSH Node sidecar host.
 *
 * Why this file exists: @deepseek-ai/dsh-sdk-client always spawns process.execPath as the runtime
 * command (packages/sdk/client/src/launch.ts). Under Archon that process is Bun, and the pinned DSH
 * runtime then fails to boot its native require-builtin addon ("Unsupported/no-context",
 * has_v8_context:false). This host runs under a REAL node.exe, drives the SDK there, and speaks a
 * small, stable NDJSON protocol to Archon so the Bun side never touches DSH wire formats.
 *
 * stdout = Agent Desk protocol ONLY (one JSON object per line).
 * stderr = diagnostics, never protocol.
 *
 * usage: node dsh-node-host.mjs <config.json>
 *   config = {cwd,dshHome,profile,patches,dshBin,sdkRoot,provider,model,reasoningEffort,maxTokens,
 *             prompt,sessionId,timeoutMs,closeTimeoutMs,env}
 */
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import path from 'node:path';

// ---- fail closed: this host must be a real Node process ------------------------------------------
if (process.release?.name !== 'node' || !process.versions?.node || process.versions?.bun) {
  process.stderr.write(
    'FATAL node-host-not-real-node release=' + String(process.release?.name) +
    ' node=' + String(process.versions?.node) + ' bun=' + String(process.versions?.bun) + '\n');
  process.exit(78);
}
const SCHEMA_VERSION = 1;
function emit(type, fields = {}) {
  // Never leak a secret through the protocol.
  if (typeof fields.text === 'string') fields.text = redact(fields.text);
  process.stdout.write(JSON.stringify({schemaVersion: SCHEMA_VERSION, type, at: new Date().toISOString(), ...fields}) + '\n');
}
function redact(value) {
  return String(value)
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .replace(/(DEEPSEEK_API_KEY\s*[=:]\s*)\S+/gi, '$1***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer ***');
}
function diagnostic(message) {
  process.stderr.write(redact(String(message)).slice(0, 4000) + '\n');
}
// ---- input ----------------------------------------------------------------------------------------
const configFile = process.argv[2];
if (!configFile) { emit('error', {code: 'HOST_CONFIG', message: 'missing config path'}); process.exit(2); }
let config;
try { config = JSON.parse(await readFile(configFile, 'utf8')); }
catch (error) { emit('error', {code: 'HOST_CONFIG', message: 'unreadable config: ' + String(error.message)}); process.exit(2); }
const sdkRoot = config.sdkRoot;
// Resolve sibling packages through Node's own resolver instead of guessing a relative layout: the
// SDK root may be the linked source tree (packages/sdk/client), where @deepseek-ai/dsh-llm lives in
// packages/sdk/client/node_modules, not in a sibling directory of the same parent.
function resolveFromSdk(specifier) {
  try { return pathToFileURL(createRequire(path.join(sdkRoot, 'package.json')).resolve(specifier)).href; }
  catch (error) {
    const fallback = path.join(sdkRoot, '..', path.basename(specifier), 'lib', 'index.js');
    if (existsSync(fallback)) return pathToFileURL(fallback).href;
    throw new Error('cannot resolve ' + specifier + ' from SDK root ' + sdkRoot + ': ' + String(error?.message ?? error));
  }
}
let sdkEntry, llmEntry;
try { sdkEntry = pathToFileURL(path.join(sdkRoot, 'lib/index.js')).href; llmEntry = resolveFromSdk('@deepseek-ai/dsh-llm'); }
catch (error) { emit('error', {code: 'HOST_SDK_LAYOUT', message: String(error?.message ?? error)}); process.exit(3); }
if (!existsSync(path.join(sdkRoot, 'lib/index.js'))) { emit('error', {code: 'HOST_SDK_LAYOUT', message: 'SDK entry missing under ' + sdkRoot}); process.exit(3); }
const {DeepSeekHarness} = await import(sdkEntry);
const {ReasoningEffortId} = await import(llmEntry);

// ---- normalize a raw DSH notification into the stable Agent Desk event ----------------------------
// Unknown but well-formed subtypes are recorded as diagnostics and DROPPED, never fatal.
const state = {turns: 0, tools: new Map(), sawResult: false, stopReason: null, sessionId: config.sessionId ?? null, unknown: 0, lastSeq: -1, sawReceipt: false, sawIdle: false, assistantCount: 0};
function summarize(input) {
  if (input === undefined || input === null) return null;
  try {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    return text.length > 300 ? text.slice(0, 300) + '…' : text;
  } catch { return '[unserializable]'; }
}
// The pinned wire schema (verified in packages/sdk/client + session events):
//   params = {sessionId, event:{seq, type, data, ignorable?}}
//   turn/start{turn} · turn/end{reason:{kind}} · tool/call{callId,name,arguments(JSON string)}
//   tool/result{message:{callId,content[],isError}} · assistant/message{message:{content[]},interrupted}
// A legal subtype this host does not model is a diagnostic, never a protocol failure.
function textBlocks(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap(b => (typeof b === 'string' ? b : (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))).join('');
}
function normalize(notification) {
  if (!notification || typeof notification !== 'object' || typeof notification.method !== 'string') {
    emit('error', {code: 'MALFORMED_NOTIFICATION', message: 'notification without a method'}); return;
  }
  const params = notification.params && typeof notification.params === 'object' ? notification.params : {};
  if (notification.method === 'session.status') {
    const status = String(params.status ?? 'unknown');
    if (status === 'idle') state.sawIdle = true;
    emit('status', {status: status === 'idle' ? 'idle' : 'running', raw: status});
    return;
  }
  if (notification.method === 'subagent.started') { emit('status', {status: 'running', subagent: true}); return; }
  if (notification.method === 'subagent.finished') { emit('status', {status: 'running', subagent: false}); return; }
  if (notification.method !== 'session.event') {
    state.unknown += 1;
    diagnostic('unmodeled notification method: ' + notification.method);
    emit('status', {status: 'running', unmodeledNotification: notification.method});
    return;
  }
  if (!params.event || typeof params.event !== 'object') {
    emit('error', {code: 'MALFORMED_EVENT', message: 'session.event without an event object'}); return;
  }
  const event = params.event;
  if (typeof event.type !== 'string') { emit('error', {code: 'MALFORMED_EVENT', message: 'session event without a type'}); return; }
  if (Number.isSafeInteger(event.seq)) {
    if (event.seq <= state.lastSeq) return;   // duplicate/replay: ignore, never fatal
    state.lastSeq = event.seq;
  }
  if (params.sessionId && !state.sessionId) state.sessionId = String(params.sessionId);
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  switch (event.type) {
    case 'agent/inbox/spliced': { state.sawReceipt = true; emit('status', {status: 'running', phase: 'prompt accepted'}); return; }
    case 'turn/start': { state.turns += 1; emit('status', {status: 'running', turn: data.turn ?? state.turns}); return; }
    case 'turn/end': {
      const kind = data.reason && typeof data.reason === 'object' ? String(data.reason.kind ?? 'unknown') : 'unknown';
      state.stopReason = kind; state.sawIdle = true;
      emit('status', {status: 'idle', raw: 'turn ended: ' + kind});
      return;
    }
    case 'tool/call': {
      const tool = String(data.name ?? 'unknown'), callId = String(data.callId ?? '');
      state.tools.set(callId, tool);
      let summary = String(data.arguments ?? '');
      try { summary = JSON.stringify(JSON.parse(summary)); } catch { /* keep raw text */ }
      emit('tool_start', {tool, callId, inputSummary: summarize(summary)});
      return;
    }
    case 'tool/result': {
      const message = data.message && typeof data.message === 'object' ? data.message : {};
      const source = message.source && typeof message.source === 'object' ? message.source : {};
      // A ToolResultMessage answers a call through toolCallId (source.callId on older logs); without
      // it the result cannot be paired and the UI would report an unnamed tool.
      const callId = String(message.toolCallId ?? message.callId ?? source.callId ?? data.callId ?? '');
      const tool = state.tools.get(callId) ?? String(source.name ?? message.name ?? data.name ?? message.tool ?? 'unnamed-tool');
      const ok = message.isError !== true;
      state.tools.delete(callId);
      emit('tool_result', {tool, callId, ok, outputSummary: summarize(textBlocks(message.content))});
      return;
    }
    case 'assistant/message': {
      const message = data.message && typeof data.message === 'object' ? data.message : {};
      const text = textBlocks(message.content);
      if (data.interrupted === true) state.stopReason = 'interrupted';
      state.assistantCount += 1;
      // Preserve the observed assistant-message event even when its content is
      // only tool calls. Empty text records presence; it invents no prose.
      emit('assistant_text', {text});
      return;
    }
    default: {
      // Legal, unmodeled subtype (e.g. step/start, request/header, session/end-seed):
      // record a sanitized diagnostic and continue. This is NOT a protocol error.
      state.unknown += 1;
      if (state.unknown <= 80) diagnostic('unmodeled session event: ' + event.type + ' ignorable=' + String(event.ignorable) + ' ' + JSON.stringify(data).slice(0, 300));
      return;
    }
  }
}
// ---- test-only long-lived descendant ---------------------------------------------------------------
// A real DSH turn spawns short-lived shell children. Cancellation/close tests need one descendant that
// outlives the host on purpose, so a leaked process tree is detected instead of merely assumed away.
if (process.env.AGENT_DESK_TEST_LONG_CHILD === '1') {
  const {spawn: spawnChild} = await import('node:child_process');
  const {writeFile} = await import('node:fs/promises');
  // pwsh is the DSH tool NAME, not a guarantee that PowerShell 7 is installed; fall back to the
  // Windows PowerShell that every supported host has.
  const windows = process.platform === 'win32';
  const shell = windows ? 'pwsh.exe' : '/bin/sh';
  const args = windows ? ['-NoProfile', '-Command', 'Start-Sleep -Seconds 300'] : ['-c', 'sleep 300'];
  let longChild = spawnChild(shell, args, {stdio: 'ignore', windowsHide: true});
  longChild.once('error', () => {
    if (!windows || longChild.pid !== undefined) return;
    const fallback = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    longChild = spawnChild(fallback, args, {stdio: 'ignore', windowsHide: true});
    longChild.once('error', error => diagnostic('test long child failed to spawn: ' + String(error?.message ?? error)));
    longChild.once('spawn', () => { void writeFile(path.join(config.dshHome, 'long-child.pid'), String(longChild.pid)).catch(() => {}); });
    diagnostic('test long child pid=' + String(longChild.pid));
  });
  longChild.once('spawn', () => { void writeFile(path.join(config.dshHome, 'long-child.pid'), String(longChild.pid)).catch(() => {}); });
  await writeFile(path.join(config.dshHome, 'host.pid'), String(process.pid)).catch(() => {});
}
// ---- run ------------------------------------------------------------------------------------------
emit('ready', {node: process.versions.node, platform: process.platform, hostPid: process.pid});
let harness = null;
let closing = null;
async function close() {
  if (closing) return closing;
  closing = (async () => {
    const deadline = Date.now() + Number(config.closeTimeoutMs ?? 15000);
    try {
      await Promise.race([
        harness?.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('close deadline exceeded')), Math.max(1000, deadline - Date.now())))
      ]);
      return true;
    } catch (error) {
      diagnostic('graceful close failed: ' + String(error?.message ?? error));
      return false;
    }
  })();
  return closing;
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void close().finally(() => process.exit(0)); });
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { if (String(chunk).includes('"shutdown"')) void close().finally(() => process.exit(0)); });
try {
  harness = new DeepSeekHarness({
    cwd: config.cwd, processCwd: config.cwd, profile: config.profile ?? 'sdk', dshHome: config.dshHome,
    patches: config.patches ?? [], env: config.env ?? process.env,
    provider: config.provider ?? 'deepseek-official', model: config.model,
    reasoningEffort: ReasoningEffortId(config.reasoningEffort ?? 'high'), maxTokens: config.maxTokens,
    ...(config.dshBin ? {dshBin: config.dshBin} : {}),
    initializeTimeoutMs: Number(config.initializeTimeoutMs ?? 60000),
    shutdownTimeoutMs: Number(config.shutdownTimeoutMs ?? 10000),
    disposeEofGraceMs: Number(config.disposeEofGraceMs ?? 8000),
    disposeGraceMs: Number(config.disposeGraceMs ?? 5000)
  });
  emit('status', {status: 'running', phase: 'initialize'});
  const timer = setTimeout(() => { diagnostic('run timeout reached'); void close().finally(() => process.exit(0)); }, Number(config.timeoutMs ?? 600000));
  const result = await harness.run(config.prompt, {sessionId: config.sessionId ?? 'session-' + Date.now(), onNotification: normalize});
  clearTimeout(timer);
  state.sawResult = true;
  const closed = await close();
  emit('result', {stopReason: state.stopReason ?? 'completed', turns: state.turns, sessionId: result?.sessionId ?? state.sessionId ?? null, closed, unmodeledEvents: state.unknown, sawReceipt: state.sawReceipt, sawIdle: state.sawIdle, assistantMessages: state.assistantCount, openTools: state.tools.size});
  process.exit(closed ? 0 : 0);
} catch (error) {
  const closed = await close();
  emit('error', {code: 'HOST_RUN_FAILED', message: String(error?.message ?? error).slice(0, 2000), closed});
  process.exit(1);
}
