// OFFLINE receipt validation; these objects are never product evidence or model answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOwnedCodexStatus,OwnedCodexSession } from '../../dist/server/providers/codex-owned.js';
import { hash } from '../../dist/server/security.js';
import { harness,root } from '../helpers.mjs';
const binding={markerId:'owned_codex_'+'a'.repeat(20),home:'/opt/dream-maker-controller/codex-home',cwd:'/opt/dream-maker-controller/codex-work',binarySha256:'b'.repeat(64)};
function receipt(){const marker={schema:'dream-maker.owned-codex.v1',markerId:binding.markerId,pid:123,groupId:123,sessionId:123,startTicks:'456',bootId:'offline-boot',pidNamespace:'pid:[1]',homeSha256:hash(binding.home),cwdSha256:hash(binding.cwd),binarySha256:binding.binarySha256};
 return{schema:'dream-maker.owned-codex-status.v1',marker,markerSha256:hash(marker),members:[],cleanup:{proven:true,reason:'SCOPED_PROCESS_GROUP_EMPTY'},readOnly:true,modelTurnsRequested:0};}
test('cleanup validates the pinned actual controller marker and requires empty group',()=>{
 const value=receipt();assert.equal(validateOwnedCodexStatus(value,binding,value.markerSha256,true).members.length,0);
 for(const mutate of [v=>v.members.push(123),v=>v.cleanup.proven=false,v=>v.marker.homeSha256='f'.repeat(64),v=>v.marker.pidNamespace=null,v=>v.marker.binarySha256='f'.repeat(64),v=>v.markerSha256='f'.repeat(64),v=>v.readOnly=false,v=>v.modelTurnsRequested=1]){
  const changed=structuredClone(value);mutate(changed);assert.throws(()=>validateOwnedCodexStatus(changed,binding,value.markerSha256,true));
 }
 assert.throws(()=>validateOwnedCodexStatus(value,binding,undefined,true),{code:'PROCESS_CLEANUP_UNPROVEN'});
});
test('owned transport stays in the dedicated controller and never imports the Windows home',t=>{
 const h=harness(t),c=h.config;c.codex={...c.codex,args:['app-server'],transport:'wsl',wslDistro:'DreamMaker-Acceptance-F-20261101-R2',wslHome:binding.home,wslCwdRoot:binding.cwd,wslBinary:'/opt/dream-maker-controller/pinned/codex'};
 const session=new OwnedCodexSession(c,root,h.dir);assert.equal(session.launch.transport,'wsl');assert.equal(session.launch.args.at(-1),'app-server');
 assert.equal(session.launch.args.includes(h.dir),false);assert.ok(session.launch.args.includes('PATH=/usr/bin:/bin'));
 c.codex.wslDistro='DreamMaker-Acceptance-20261011';assert.throws(()=>new OwnedCodexSession(c,root,h.dir),{code:'CODEX_OWNED_CONTROLLER_SCOPE_REQUIRED'});c.codex.wslDistro='DreamMaker-Acceptance-F-20261101-R2';
 c.codex.wslHome='/tmp/shared';assert.throws(()=>new OwnedCodexSession(c,root,h.dir),{code:'CODEX_OWNED_CONTROLLER_SCOPE_REQUIRED'});
});
