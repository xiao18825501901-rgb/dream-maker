// OFFLINE admission proof. This test never starts Codex, a shell, a model or a network request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {NativeOwner} from '../../dist/server/native-owner.js';
import {harness} from '../helpers.mjs';

function fakeCodex(h,options={}) {
    const runtime=resolve(h.dir,'runtime/node.exe');
    const packageRoot=resolve(h.dir,'npm/node_modules/@openai/codex');
    const entry=resolve(packageRoot,'bin/codex.js');
    mkdirSync(dirname(runtime),{recursive:true});
    mkdirSync(dirname(entry),{recursive:true});
    writeFileSync(runtime,'OFFLINE_NODE_FIXTURE');
    writeFileSync(entry,'OFFLINE_CODEX_ENTRY_FIXTURE');
    writeFileSync(resolve(packageRoot,'package.json'),JSON.stringify({
        name:options.packageName??'@openai/codex',
        version:'0.162.0',
        bin:{codex:options.bin??'bin/codex.js'}
    }));
    return {runtime,entry};
}

function assertAdmission(owner,config) {
    const check=Reflect.get(owner,'assertIndependentCodex');
    assert.equal(typeof check,'function');
    return check.call(owner,config);
}

test('an independent official Codex package may use a pinned Node that differs from the DM process runtime',t=>{
    const h=harness(t),owner=new NativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,product:'dreamflow'});
    const {runtime,entry}=fakeCodex(h);
    const config=structuredClone(h.config);
    config.codex={...config.codex,command:runtime,args:[entry,'app-server'],transport:'stdio'};
    t.after(()=>owner.close());

    assert.doesNotThrow(()=>assertAdmission(owner,config));
});

test('the independent CLI admission still rejects a non-official package and a non-bin entry',t=>{
    const h=harness(t),owner=new NativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,product:'dreamflow'});
    const {runtime,entry}=fakeCodex(h,{packageName:'not-openai-codex'});
    const config=structuredClone(h.config);
    config.codex={...config.codex,command:runtime,args:[entry,'app-server'],transport:'stdio'};
    t.after(()=>owner.close());

    assert.throws(()=>assertAdmission(owner,config),{code:'INDEPENDENT_CODEX_CLI_REQUIRED'});

    const second=harness(t),secondOwner=new NativeOwner({root:second.dir,store:second.store,getConfig:()=>second.config,product:'dreamflow'});
    const files=fakeCodex(second,{bin:'bin/another.js'});
    const changed=structuredClone(second.config);
    changed.codex={...changed.codex,command:files.runtime,args:[files.entry,'app-server'],transport:'stdio'};
    t.after(()=>secondOwner.close());
    assert.throws(()=>assertAdmission(secondOwner,changed),{code:'INDEPENDENT_CODEX_CLI_REQUIRED'});
});

test('the independent CLI admission rejects relative runtime, relative entry and missing app-server',t=>{
    const h=harness(t),owner=new NativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,product:'dreamflow'});
    const {runtime,entry}=fakeCodex(h);
    t.after(()=>owner.close());

    for(const codex of [
        {command:'node.exe',args:[entry,'app-server'],transport:'stdio'},
        {command:runtime,args:['relative/codex.js','app-server'],transport:'stdio'},
        {command:runtime,args:[entry],transport:'stdio'}
    ]) {
        const config=structuredClone(h.config);
        config.codex={...config.codex,...codex};
        assert.throws(()=>assertAdmission(owner,config),{code:'INDEPENDENT_CODEX_CLI_REQUIRED'});
    }
});
