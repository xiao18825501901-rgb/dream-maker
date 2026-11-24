// OFFLINE: filesystem only, no CLI, process, account, or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { harness } from '../helpers.mjs';
import {
    codexSubscriptionModelCatalogJson,
    writeCodexSubscriptionModelCatalog
} from '../../dist/server/providers/codex-magpie-catalog.js';
import { codexSubscriptionGatewayArgs } from '../../dist/server/providers/codex-magpie-config.js';

test('the Custom subscription catalog is local, bounded, and model-specific', t => {
    const h = harness(t);
    const catalog = writeCodexSubscriptionModelCatalog(join(h.dir, 'context'), 'gpt-6-luna');
    assert.equal(catalog.path, resolve(h.dir, 'context', 'codex-model-catalog.json'));
    const parsed = JSON.parse(readFileSync(catalog.path, 'utf8'));
    assert.deepEqual(parsed.models.map(model => model.slug), ['gpt-6-luna']);
    assert.equal('model_messages' in parsed.models[0], false);
    assert.match(parsed.models[0].base_instructions, /Dream Maker controlled role/);
    assert.equal(catalog.sha256.length, 64);
});

test('the CLI receives the local catalog as a config override', t => {
    const h = harness(t);
    const catalog = writeCodexSubscriptionModelCatalog(join(h.dir, 'context'), 'gpt-6-luna');
    const args = codexSubscriptionGatewayArgs('gpt-6-luna', 'http://127.0.0.1:45678/backend-api/codex', catalog.path);
    const at = args.indexOf('model_catalog_json=' + JSON.stringify(catalog.path));
    assert.ok(at > 0);
    assert.equal(args[at - 1], '-c');
});

test('unsupported models and invalid catalog paths fail closed', t => {
    const h = harness(t);
    assert.throws(() => codexSubscriptionModelCatalogJson('gpt-6-other'), { code: 'CODEX_MODEL_CATALOG_INVALID' });
    assert.throws(() => writeCodexSubscriptionModelCatalog('relative', 'gpt-6-luna'), { code: 'CODEX_MODEL_CATALOG_INVALID' });
    assert.throws(() => codexSubscriptionGatewayArgs('gpt-6-luna', 'http://127.0.0.1:45678/backend-api/codex', 'relative.json'), { code: 'CODEX_MAGPIE_CONFIG_INVALID' });
    assert.equal(existsSync(join(h.dir, 'context', 'codex-model-catalog.json')), false);
});
