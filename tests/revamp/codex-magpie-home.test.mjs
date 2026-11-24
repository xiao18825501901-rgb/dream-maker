// OFFLINE: filesystem only, no CLI, no process, no model.
import test from 'node:test';import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';import {join,resolve} from 'node:path';
import {prepareCodexMagpieHome} from '../../dist/server/providers/codex-magpie-home.js';
import {harness} from '../helpers.mjs';

const input = { model: 'deepseek-chat', baseUrl: 'http://127.0.0.1:45678/v1', envKey: 'DM_GATEWAY_TOKEN' };

test('a per-run Codex home carries exactly the Magpie provider block', t => {
    const h = harness(t);
    const home = prepareCodexMagpieHome(h.dir, 'run_fixture_1', input);
    assert.equal(home.dir, resolve(h.dir, '.runtime', 'custom-codex', 'run_fixture_1'));
    assert.equal(home.model, 'deepseek-chat');
    assert.equal(home.baseUrl, 'http://127.0.0.1:45678/v1');
    const text = readFileSync(join(home.dir, 'config.toml'), 'utf8');
    assert.match(text, /model_provider = "magpie"/);
    assert.match(text, /wire_api = "responses"/);
    assert.match(text, /env_key = "DM_GATEWAY_TOKEN"/);
});

test('the run id cannot escape the DM-owned base or name a foreign path', t => {
    const h = harness(t);
    for (const runId of ['', '../escape', 'a/b', 'a\\b', '.hidden', 'x'.repeat(81), 7, null])
        assert.throws(() => prepareCodexMagpieHome(h.dir, runId, input), { code: 'CODEX_MAGPIE_HOME_INVALID' }, String(runId));
    assert.equal(existsSync(resolve(h.dir, 'escape')), false);
});

test('a non-loopback gateway URL is refused before anything is written', t => {
    const h = harness(t);
    for (const baseUrl of ['https://api.openai.com/v1', 'http://localhost:45678/v1', 'http://127.0.0.1:45678/v2'])
        assert.throws(() => prepareCodexMagpieHome(h.dir, 'run_fixture_2', { ...input, baseUrl }), { code: 'CODEX_MAGPIE_CONFIG_INVALID' }, baseUrl);
    assert.equal(existsSync(resolve(h.dir, '.runtime', 'custom-codex', 'run_fixture_2')), false);
});
