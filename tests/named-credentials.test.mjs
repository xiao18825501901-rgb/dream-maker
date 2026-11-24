import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaults, parseConfig, Settings } from '../dist/server/config.js';
import { harness } from './helpers.mjs';
import { redact, childEnv } from '../dist/server/security.js';
test('operator-selected mixed-case environment references are valid without storing credentials',()=>{
    const c=structuredClone(defaults);
    c.planner1.keyEnv='Dream_Maker_codex'; c.dsh.keyEnv='Dream_Maker_dsh';
    assert.equal(parseConfig(c).planner1.keyEnv,'Dream_Maker_codex');
    for(const invalid of ['bad name','bad;name','bad=name','$KEY']) {
        c.planner1.keyEnv=invalid;
        assert.throws(()=>parseConfig(c),{code:'INVALID_ENV_NAME'});
    }
});
test('configured credentials are masked even when their environment names do not end in KEY or TOKEN',t=>{
    const value='synthetic-opaque-custom-provider-value';
    process.env.DM_CUSTOM_PROVIDER=value;
    t.after(()=>delete process.env.DM_CUSTOM_PROVIDER);
    const c=structuredClone(defaults); c.planner1.keyEnv='DM_CUSTOM_PROVIDER'; parseConfig(c);
    assert.equal(redact({stdout:value}).includes(value),false);
    assert.equal(childEnv().DM_CUSTOM_PROVIDER,undefined);
});
test('editing a model retains its operator-selected credential reference for the same provider',t=>{
    const h=harness(t), path=resolve(h.dir,'operator-settings.json'), c=structuredClone(defaults);
    c.planner1.keyEnv='Dream_Maker_codex'; c.dsh.keyEnv='Dream_Maker_dsh';
    writeFileSync(path,JSON.stringify(c));
    const settings=new Settings(path);
    settings.updateUI({planner1:{protocol:'openai-responses',model:'OFFLINE_MODEL'}});
    assert.equal(settings.value.planner1.keyEnv,'Dream_Maker_codex');
    assert.equal(settings.value.dsh.keyEnv,'Dream_Maker_dsh');
});
