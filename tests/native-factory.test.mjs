// Offline negative admission tests. Synthetic audit is NEVER real Live evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {harness,ready,root,bindKimi} from './helpers.mjs';
import {Engine} from '../dist/server/engine.js';
import {nativeReadiness} from '../dist/server/providers/dsh.js';
import {hash,DomainError} from '../dist/server/security.js';
import {runDeadline,taskDeadlineWaiverEvidence} from '../dist/server/review-window.js';
import {Store} from '../dist/server/store.js';

async function fixture(t){
 const h=harness(t);h.config.codex.home=h.dir;h.config.codex.model='OFFLINE_ONLY';
 h.config.dsh.modulePath=resolve(root,'tests/fixtures/dsh-adapter.mjs');
 const proof=resolve(h.dir,'offline-proof.txt');writeFileSync(proof,'SYNTHETIC NEGATIVE TEST ONLY, NO LIVE QUALIFICATION');
 h.config.nativeAuditPath=resolve(h.dir,'offline-audit.json');
 writeFileSync(h.config.nativeAuditPath,JSON.stringify({configurationHash:nativeReadiness(h.config).configurationHash,status:'LIVE_READY',osIsolationVerified:true,secretIsolationVerified:true,
  noImplicitLayaVerified:true,verifierImplemented:true,sandboxExecutionVerified:true,expiresAt:new Date(Date.now()+60000).toISOString(),moduleSha256:hash(readFileSync(h.config.dsh.modulePath)),evidenceFiles:[{path:proof,sha256:hash(readFileSync(proof))}]}));
 bindKimi(h.config);
 const {p,s}=await ready(h,'live');return{h,p,s};
}
test('an otherwise accepted offline audit cannot dispatch without the controlled execution factory',async t=>{
 const {h,p,s}=await fixture(t);
 h.engine.launch=()=>{throw new DomainError('OFFLINE_DISPATCH_REACHED');};
 assert.throws(()=>h.engine.create(p.id,s.hash,true),{code:'NATIVE_RUNTIME_FACTORY_REQUIRED'});
 assert.equal(h.store.runs().length,0);assert.equal(h.store.approved(p.id,s.hash,'BUILD'),false);
});

test('app execution diagnostics cannot report ready on audit fields alone',async t=>{
 const {h}=await fixture(t);const readiness=h.engine.executionReadiness();
 assert.equal(readiness.ok,false);assert.ok(readiness.reasons.includes('NATIVE_RUNTIME_FACTORY_REQUIRED'));
});
test('Classic persists an owner no-deadline approval before launch using its original admission',async t=>{
 const {h,p,s}=await fixture(t),admitted=[];
 h.engine.nativeExecution={assertReady:role=>{admitted.push(role);},executor(){throw Error('MODEL_FORBIDDEN');},async verify(){throw Error('MODEL_FORBIDDEN');},async close(){}};
 let checked=false;h.engine.launch=id=>{const other=new Store(h.store.path);try{
  const r=other.run(id);assert.equal(runDeadline(other,r),Infinity);assert.equal(taskDeadlineWaiverEvidence(other,r).flowName,'classic');checked=true;
 }finally{other.close();}};
 const r=h.engine.create(p.id,s.hash,true,false,'classic',{taskDeadline:null},'local-session:'+'b'.repeat(64));
 assert.equal(checked,true);assert.deepEqual(admitted,['build']);assert.equal(r.calls,0);
});
test('factory preflight rejection occurs before lease, build approval, workspace or model dispatch',async t=>{
 const {h,p,s}=await fixture(t),calls=[];
 const factory={assertReady:role=>{calls.push(role);throw new DomainError('NATIVE_PRICE_UNKNOWN');},executor:()=>{throw Error('MUST_NOT_CALL');},verify:async()=>{throw Error('MUST_NOT_CALL');},close:async()=>{}};
 const engine=new Engine(h.store,h.laya,()=>h.config,root,h.dir,0,factory);t.after(()=>engine.close());
 engine.launch=()=>{throw new DomainError('OFFLINE_DISPATCH_REACHED');};
 assert.throws(()=>engine.create(p.id,s.hash,true),{code:'NATIVE_PRICE_UNKNOWN'});
 assert.deepEqual(calls,['build']);assert.equal(h.store.runs().length,0);
 assert.equal(h.store.db.prepare('SELECT count(*) n FROM workspace_leases').get().n,0);
 assert.equal(h.store.approved(p.id,s.hash,'BUILD'),false);
});
test('route admission failure blocks a created Live run before any role dispatch',async t=>{
 const {h,p,s}=await fixture(t),calls=[];
 const factory={assertReady:role=>calls.push(role),executor:()=>{throw Error('MUST_NOT_CALL');},verify:async()=>{throw Error('MUST_NOT_CALL');},close:async()=>{}};
 const route={async withRun(){throw new DomainError('CLASH_CONTROLLER_NETWORK_ERROR',502);},childEnvironment(){throw Error('MUST_NOT_CALL');}};
 const engine=new Engine(h.store,h.laya,()=>h.config,root,h.dir,0,factory,route);t.after(()=>engine.close());
 const run=engine.create(p.id,s.hash,true);await engine.settled(run.id);
 const stored=h.store.run(run.id);assert.equal(stored.state,'BLOCKED');assert.equal(stored.reason,'CLASH_CONTROLLER_NETWORK_ERROR');
 assert.deepEqual(calls,['build']);
});
