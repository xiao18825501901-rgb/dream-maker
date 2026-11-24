// OFFLINE private-operator selection. Synthetic bytes cannot become an approved native program.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
import {NativeOwner} from '../../dist/server/native-owner.js';import {hash} from '../../dist/server/security.js';import {harness} from '../helpers.mjs';
import {REVIEWED_MAGPIE_BUILD_SHA256,REVIEWED_CUSTOM_MAGPIE_BUILD_SHA256} from '../../dist/server/magpie-owned.js';
const reviewed=REVIEWED_MAGPIE_BUILD_SHA256;
function owner(t,candidate){let o;t.after(()=>o?.close());const h=harness(t);mkdirSync(join(h.dir,'config'));const authority={scopeId:'OFFLINE_MAGPIE_REF',authorizationHash:'OFFLINE',totalMicros:50000000,probeMicros:5000000,warningMicros:40000000,maxInFlight:1,maxRepairs:2},bytes=JSON.stringify(authority),path=join(h.dir,'authority.json');writeFileSync(path,bytes);
 writeFileSync(join(h.dir,'config/native-owner.local.json'),JSON.stringify({schema:'dream-maker.native-owner.v1',scopeRoot:h.dir,authority:{path,sha256:hash(bytes)},prices:{},maxOutputTokens:128,maxRequests:8,magpieCandidate:candidate}));let secretReads=0;o=new NativeOwner({root:h.dir,store:h.store,getConfig:()=>h.config,getSecret:()=>{secretReads++;throw Error('SECRET_NOT_ALLOWED');}});return{h,o,reads:()=>secretReads};}
test('private operator cannot select another binary digest, shared drive, or widened candidate shape',async t=>{
 for(const candidate of [{path:'F:/DreamMakerSuite/runtime/unapproved.exe',sha256:'a'.repeat(64)},{path:'C:/shared/magpie.exe',sha256:reviewed},{path:'F:/OTHER/magpie.exe',sha256:reviewed},{path:'F:/DreamMakerSuite/runtime/unapproved.exe',sha256:reviewed,bootstrapAccounts:[]}]){const f=owner(t,candidate);await assert.rejects(f.o.inspectMagpieIngress(),{code:'MAGPIE_CANDIDATE_BINDING_REQUIRED'});assert.equal(f.reads(),0);}
});
test('uncertain NativeOwner cleanup blocks another local process before reading credentials',async t=>{
 const f=owner(t,{path:'F:/DreamMakerSuite/runtime/unapproved.exe',sha256:reviewed});f.o.cleanupUncertain=true;await assert.rejects(f.o.inspectMagpieIngress(),{code:'NATIVE_OWNER_CLEANUP_UNCERTAIN'});assert.equal(f.reads(),0);f.o.cleanupUncertain=false;
});
test('a durable unknown Magpie check quarantines all native role admission after owner recreation',async t=>{
 const f=owner(t,{path:'F:/DreamMakerSuite/runtime/unapproved.exe',sha256:reviewed});f.h.store.record('MagpieIngressCheckIntent',null,null,{operationHash:'OFFLINE_INTERRUPTED_CONTROL'});
 assert.throws(()=>f.o.assertReady('planner2'),{code:'NATIVE_OWNER_CLEANUP_UNCERTAIN'});
 f.o.probes={codexAccountFingerprint:()=> 'a'.repeat(64),close:async()=>{}};
 const input={role:'planner2',workspace:f.h.dir,runId:'OFFLINE',specHash:'OFFLINE',prompt:'OFFLINE',model:'OFFLINE',signal:new AbortController().signal};
 await assert.rejects(async()=>f.o.codex(input).run(input,()=>{}),{code:'NATIVE_OWNER_CLEANUP_UNCERTAIN'});assert.equal(f.reads(),0);
});

test('string-capable Magpie build is selectable only at the dedicated Custom instance path',t=>{
 const path='E:/DreamMakerSuite/custom-mvp/runtime/magpie/string-r2/dream-maker-magpie.exe';
 const sha256=REVIEWED_CUSTOM_MAGPIE_BUILD_SHA256;
 const allowed=owner(t,{path,sha256});
 assert.deepEqual(allowed.o.reviewedMagpieCandidate(),{path,sha256});
 for(const candidate of [{path,sha256:'d9c2c4dc1d61c2620a9447200bef04e0c064b02a2d845a61b66d503e2f2c976c'},{path,sha256:'f7ca4dbe973ebedd3e12051701471e8590b3cbf3afc6e3211907df4bc5f51433'},{path,sha256:reviewed},{path:path.replace('custom-mvp','classic-laya-mvp'),sha256},{path:path.replace('string-r2','elsewhere'),sha256},{path:'F:/DreamMakerSuite/runtime/another.exe',sha256}]){
  assert.throws(()=>owner(t,candidate).o.reviewedMagpieCandidate(),{code:'MAGPIE_CANDIDATE_BINDING_REQUIRED'});
 }
});
