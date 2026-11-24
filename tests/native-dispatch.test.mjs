// Offline envelope validation. No host, SDK, model or audit promotion.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {harness} from './helpers.mjs';
import {hash} from '../dist/server/security.js';
import {dispatchConfiguration} from '../adapters/archon-dsh-native.mjs';
test('per-dispatch envelope preserves the audited template and rejects host overrides, wrong hash and foreign path',t=>{
 const h=harness(t),config=resolve(h.dir,'config');mkdirSync(config);
 const template=resolve(config,'template.json');writeFileSync(template,JSON.stringify({hostModule:'OFFLINE_FROZEN_HOST',profile:'sdk',patches:[],reasoningEffort:'off',maxTokens:128}));
 const ref={path:template,sha256:hash(readFileSync(template))},audit={status:'OFFLINE_NOT_LIVE',evidenceFiles:[ref]};
 const directory=resolve(h.dir,'.runtime/native-dispatches/owned-ABC123');mkdirSync(directory,{recursive:true});
 const path=resolve(directory,'dispatch-binding.json');
 const envelope={schema:'dream-maker.archon-dispatch.v1',runId:'offline_run',specHash:'a'.repeat(64),template:ref,
  launch:{dshHome:resolve(directory,'home'),controlRoot:directory,profileManifestPath:resolve(directory,'manifest.json'),profileManifestSha256:'b'.repeat(64)}};
 function write(){writeFileSync(path,JSON.stringify(envelope));return hash(readFileSync(path));}
 const sha=write(),result=dispatchConfiguration(h.dir,path,sha,audit);
 assert.equal(result.hostModule,'OFFLINE_FROZEN_HOST');assert.equal(result.runBinding.runId,'offline_run');
 assert.throws(()=>dispatchConfiguration(h.dir,path,'c'.repeat(64),audit),{code:'NATIVE_DISPATCH_BINDING_CHANGED'});
 envelope.launch.hostModule='UNAPPROVED_HOST_OVERRIDE';const changed=write();
 assert.throws(()=>dispatchConfiguration(h.dir,path,changed,audit),{code:'NATIVE_DISPATCH_BINDING_INVALID'});
 assert.throws(()=>dispatchConfiguration(h.dir,template,ref.sha256,audit),{code:'NATIVE_DISPATCH_PATH_DENIED'});
});

test('Custom v2 dispatch carries the exact frozen role while v1 cannot carry a role grant',t=>{
 const h=harness(t),template=resolve(h.dir,'template.json');writeFileSync(template,JSON.stringify({profile:'sdk',hostModule:'OFFLINE_PINNED_HOST'}));
 const ref={path:template,sha256:hash(readFileSync(template))},audit={evidenceFiles:[ref]},directory=resolve(h.dir,'.runtime/native-dispatches/owned-ROLE17');mkdirSync(directory,{recursive:true});
 const path=resolve(directory,'dispatch-binding.json'),envelope={schema:'dream-maker.archon-dispatch.v2',runId:'offline_run',specHash:'a'.repeat(64),template:ref,launch:{controlRoot:directory},roleBinding:{role:'reviewer',roleId:'reviewer',configurationHash:'b'.repeat(64)}};
 const write=()=>{writeFileSync(path,JSON.stringify(envelope));return hash(readFileSync(path));};
 assert.deepEqual(dispatchConfiguration(h.dir,path,write(),audit).runBinding,{runId:'offline_run',specHash:envelope.specHash,...envelope.roleBinding});
 envelope.roleBinding={role:'executor',roleId:'execA',configurationHash:'b'.repeat(64)};assert.equal(dispatchConfiguration(h.dir,path,write(),audit).runBinding.roleId,'execA');
 for(const bad of [{role:'executor',roleId:'reviewer',configurationHash:'b'.repeat(64),permissions:['source_write']},{role:'reviewer',roleId:'planner2',configurationHash:'b'.repeat(64)},{role:'planner1',roleId:'planner1',configurationHash:'b'.repeat(64)}]){envelope.roleBinding=bad;assert.throws(()=>dispatchConfiguration(h.dir,path,write(),audit),{code:'NATIVE_DISPATCH_ROLE_INVALID'});}
 envelope.roleBinding={role:'reviewer',roleId:'reviewer',configurationHash:'b'.repeat(64)};envelope.schema='dream-maker.archon-dispatch.v1';assert.throws(()=>dispatchConfiguration(h.dir,path,write(),audit),{code:'NATIVE_DISPATCH_BINDING_INVALID'});
});
