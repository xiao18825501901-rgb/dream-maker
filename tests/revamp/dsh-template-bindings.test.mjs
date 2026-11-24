import test from 'node:test';import assert from 'node:assert/strict';import {resolve} from 'node:path';import * as binding from '../../dist/server/dsh-template-bindings.js';
const template=()=>({hostModule:resolve('host.mjs'),eventModule:resolve('events.mjs'),hostScript:resolve('sidecar.mjs'),dshBin:resolve('bin.js'),sdkRoot:resolve('sdk'),verifierModule:resolve('verifier.mjs'),patches:[],dependencyFiles:[resolve('policy.js')]});
test('the controller, audit and adapter roster includes the SDK entry under the actual template root',()=>{
 const value=template(),files=binding.dshTemplateBindingFiles(value);assert.ok(files.includes(resolve(value.sdkRoot,'lib/index.js')));assert.equal(files.length,7);
 const moved={...value,sdkRoot:resolve('another-sdk')};assert.ok(binding.dshTemplateBindingFiles(moved).includes(resolve(moved.sdkRoot,'lib/index.js')));assert.ok(!binding.dshTemplateBindingFiles(moved).includes(resolve(value.sdkRoot,'lib/index.js')));
});
test('malformed or relative SDK and dependency roots fail before any file or runtime is loaded',()=>{
 for(const change of [{sdkRoot:undefined},{sdkRoot:'relative'},{patches:null},{dependencyFiles:['relative']},{hostScript:'https://example.invalid/sidecar'}])
  assert.throws(()=>binding.dshTemplateBindingFiles({...template(),...change}),{code:'NATIVE_DSH_TEMPLATE_INVALID'});
});
