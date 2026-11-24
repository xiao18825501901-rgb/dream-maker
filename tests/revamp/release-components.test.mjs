// Offline release checklist/readonly metadata tests. Fixtures never certify a real distribution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {harness} from '../helpers.mjs';
import {qualifyDistribution,REQUIRED_CORE_COMPONENTS} from '../../dist/server/release/component-inventory.mjs';
import {observeInstalledPackage,observeComponentFile,observeExpectedPackage,projectWslConfiguration} from '../../dist/server/release/local-component.js';
test('the reused release checklist never qualifies a missing-runtime shell or treats it as an installer',()=>{
 const none=qualifyDistribution({components:[],variant:'INSTALLER'});assert.equal(none.completeCore,false);assert.equal(none.problems.length,REQUIRED_CORE_COMPONENTS.length);assert.equal(none.scope,'RELEASE_CHECKLIST_NOT_INSTALLER');
 const present=qualifyDistribution({components:REQUIRED_CORE_COMPONENTS.map(id=>({id,bundled:true,artifactHash:'a'.repeat(64)})),variant:'PORTABLE'});assert.equal(present.completeCore,false);assert.ok(present.problems.some(problem=>problem.code==='CLEAN_WINDOWS_NOT_VERIFIED'));assert.ok(present.problems.some(problem=>problem.code==='REDISTRIBUTION_UNVERIFIED'));
});
test('invalid or unrelated entries cannot inherit a working directory package identity as Codex',t=>{
 const h=harness(t),entry=resolve(h.dir,'tool.js');writeFileSync(entry,'// unrelated entry');writeFileSync(resolve(h.dir,'package.json'),JSON.stringify({name:'unrelated-project',version:'9.9.9',license:'UNLICENSED'}));
 for(const value of ['app-server',resolve(h.dir,'missing.js')]){const result=observeExpectedPackage(value,'@openai/codex');assert.equal(result.status,'ENTRY_UNVERIFIED');assert.equal(result.version,null);assert.equal(result.name,null);}
 const wrong=observeExpectedPackage(entry,'@openai/codex');assert.equal(wrong.status,'PACKAGE_ID_MISMATCH');assert.equal(wrong.name,null);assert.equal(wrong.version,null);assert.equal(wrong.declaredLicense,null);
 for(let i=0;i<33;i++)writeFileSync(resolve(h.dir,'LICENSE.'+i),'OFFLINE_NOT_A_LICENSE_GRANT');
 const partial=observeExpectedPackage(entry,'@openai/codex');assert.equal(partial.status,'FILE_LIMIT');assert.equal(partial.name,null);assert.equal(partial.version,null);assert.equal(partial.declaredLicense,null);
});
test('WSL configuration fields are filtered observations and cannot leak secret strings as inventory paths',()=>{
 const value=projectWslConfiguration({wslDistro:'sk-EXAMPLEONLYNOTREAL12345',wslBinary:'/opt/sk-EXAMPLEONLYNOTREAL12345/codex'});assert.equal(value.distro,null);assert.equal(value.binary,null);assert.ok(!JSON.stringify(value).includes('EXAMPLEONLYNOTREAL12345'));
 const valid=projectWslConfiguration({wslDistro:'DreamMaker-Acceptance-20261011',wslBinary:'/opt/dream-maker-controller/codex/node_modules/@openai/bin/codex'});assert.equal(valid.distro,'DreamMaker-Acceptance-20261011');assert.equal(valid.inventory,'CONFIGURED_NOT_OBSERVED');assert.equal(valid.authQueried,false);
});
test('installed package metadata and license bytes do not become redistribution, bundling or role proof',t=>{
 const h=harness(t),folder=resolve(h.dir,'package');mkdirSync(folder);writeFileSync(resolve(folder,'package.json'),JSON.stringify({name:'@example/local-tool',version:'1.2.3',license:'MIT',privateSecret:'DO_NOT_RETURN_THIS_FIELD'}));writeFileSync(resolve(folder,'LICENSE'),'OFFLINE LICENSE TEXT NOT A REAL GRANT');writeFileSync(resolve(folder,'tool.js'),'// offline component');
 const observed=observeInstalledPackage(resolve(folder,'package.json'),resolve(folder,'tool.js'));assert.equal(observed.status,'METADATA_PRESENT');assert.equal(observed.name,'@example/local-tool');assert.equal(observed.declaredLicense,'MIT');assert.equal(observed.licenseFiles.length,1);assert.equal(observed.bundled,false);assert.equal(observed.redistributionReviewed,false);assert.equal(observed.cleanMachineRunVerified,false);assert.equal(observed.roleAcceptance,'NOT_RUN');assert.ok(!JSON.stringify(observed).includes('DO_NOT_RETURN_THIS_FIELD'));
});
test('metadata readers refuse redirected or oversized files before reporting identity and never inspect credential directories',t=>{
 const h=harness(t),folder=resolve(h.dir,'package'),other=resolve(h.dir,'OTHER');mkdirSync(folder);mkdirSync(other);writeFileSync(resolve(other,'package.json'),'{}');symlinkSync(other,resolve(folder,'redirect'),process.platform==='win32'?'junction':'dir');
 assert.equal(observeInstalledPackage(resolve(folder,'redirect/package.json')).status,'LINK_DENIED');
 writeFileSync(resolve(folder,'package.json'),' '.repeat(128001));assert.equal(observeInstalledPackage(resolve(folder,'package.json')).status,'FILE_LIMIT');
 const credentials=resolve(h.dir,'kimi-credentials');mkdirSync(credentials);writeFileSync(resolve(credentials,'auth.json'),'SYNTHETIC_NOT_REAL');assert.equal(observeComponentFile(resolve(credentials,'auth.json')).status,'SENSITIVE_PATH_DENIED');
 const untrusted=resolve(h.dir,'sk-EXAMPLEONLYNOTREAL12345');const denied=observeComponentFile(untrusted);assert.equal(denied.status,'SENSITIVE_PATH_DENIED');assert.ok(!JSON.stringify(denied).includes('EXAMPLEONLYNOTREAL12345'));
});
