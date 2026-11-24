import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,ready} from '../helpers.mjs';
import {hash} from '../../dist/server/security.js';
import {flowCatalog} from '../../dist/server/flows.js';
import {fixedControllerCapacity} from '../fixtures/controller-capacity.mjs';

test('new Engine Flows freeze classic separately from Demo/Live and the approved plan',async t=>{
 const h=harness(t);fixedControllerCapacity(h.engine);const {p,s}=await ready(h);
 const r=h.engine.create(p.id,s.hash,true);
 assert.equal(r.flowName,'classic');
 assert.equal(r.flowConfig.schema,'dream-maker.flow-config.v1');
 assert.equal(r.flowConfig.mode,'classic');
 assert.equal(r.flowConfig.laya.enabled,false);
 assert.equal(r.flowConfig.plan.versionId,s.id);
 assert.equal(r.flowConfig.plan.contentHash,h.store.planVersion(s.id).contentHash);
 assert.equal(r.flowConfig.roles.planner2.runtime,'codex-app-server');
 assert.equal(r.flowConfig.roles.reviewer.runtime,'codex-app-server');
 assert.equal(r.flowConfig.roles.executors[0].runtime,'dsh');
 assert.equal(r.flowConfig.roles.planner2.serviceIdentity,'NOT_VERIFIED');
 assert.equal(r.flowConfig.magpie,null);
 assert.equal(r.flowConfigHash,hash(r.flowConfig));
 assert.equal(h.store.run(r.id).mode,'demo');
});
test('the production mode catalog has only classic and custom; custom stays closed before a secure gateway',t=>{
 const h=harness(t);const modes=flowCatalog(h.config);
 assert.deepEqual(modes.map(x=>x.name),['classic','custom']);
 assert.equal(modes[1].blockedBy,'CUSTOM_MAGPIE_SECURITY_REQUIRED');
 assert.equal(modes[1].setupAllowed,false);
 assert.equal(modes[1].layaMode,'off');
});
test('a connected Custom controller exposes configuration preparation but never grants execution',t=>{
 const h=harness(t),modes=flowCatalog(h.config,{},()=>({connected:true})),custom=modes.find(x=>x.name==='custom');
 assert.equal(custom.blockedBy,'CUSTOM_ROLE_QUALIFICATION_REQUIRED');
 assert.equal(custom.setupAllowed,true);
 assert.equal(custom.liveAllowed,false);
 assert.match(custom.reason,/账户|角色|模型/);
});
test('Custom readiness fails closed for a missing, malformed or throwing controller callback',t=>{
 const h=harness(t);
 for(const callback of [()=>false,()=>true,()=>({}),()=>({connected:'yes'}),()=>{throw new Error('OFFLINE_CALLBACK_FAILURE');}]){
  const custom=flowCatalog(h.config,{},callback).find(x=>x.name==='custom');
  assert.equal(custom.blockedBy,'CUSTOM_MAGPIE_SECURITY_REQUIRED');
  assert.equal(custom.setupAllowed,false);
  assert.equal(custom.liveAllowed,false);
 }
});
test('Engine reports connected Custom only from its owned factory shape',t=>{
 const h=harness(t);
 assert.equal(h.engine.flowOptions().find(x=>x.name==='custom').setupAllowed,false);
 h.engine.nativeExecution={assertReady(){},executor(){throw new Error('OFFLINE_NOT_USED');},verify:async()=>({}),close:async()=>{},assertCustomReady(){},custom(){throw new Error('OFFLINE_NOT_USED');}};
 const custom=h.engine.flowOptions().find(x=>x.name==='custom');
 assert.equal(custom.blockedBy,'CUSTOM_ROLE_QUALIFICATION_REQUIRED');
 assert.equal(custom.setupAllowed,true);
 assert.equal(custom.liveAllowed,false);
});
test('custom cannot silently use native classic execution or acquire a workspace',async t=>{
 const h=harness(t),{p,s}=await ready(h);const before=h.store.runs(p.id).length;
 assert.throws(()=>h.engine.create(p.id,s.hash,true,false,'custom'),e=>e.code==='CUSTOM_MAGPIE_SECURITY_REQUIRED');
 assert.equal(h.store.runs(p.id).length,before);
 assert.equal(h.store.db.prepare('SELECT count(*) n FROM workspace_leases').get().n,0);
});
test('historical flow names remain history and cannot approve a newly created mode',async t=>{
 const h=harness(t),{p,s}=await ready(h);
 for(const name of ['dreamflow','dreamflow-laya'])assert.throws(()=>h.engine.create(p.id,s.hash,true,false,name),e=>e.code==='LEGACY_FLOW_REQUIRES_MODE_CONFIRMATION');
 assert.equal(h.store.runs(p.id).length,0);
});
test('the frozen engineering hash excludes unrelated P1 choices but detects engineering changes',async t=>{
 const h=harness(t);fixedControllerCapacity(h.engine);const {p,s}=await ready(h);const r=h.engine.create(p.id,s.hash,true);
 h.config.planner1.model='another-p1-model';
 assert.doesNotThrow(()=>h.engine.assertBinding(r));
 h.config.codex.model='changed-after-approval';
 assert.throws(()=>h.engine.assertBinding(r),e=>e.code==='RUN_CONFIG_CHANGED');
});
test('original SQLite refuses replacing or removing the frozen Flow configuration',async t=>{
 const h=harness(t);fixedControllerCapacity(h.engine);const {p,s}=await ready(h);const r=h.engine.create(p.id,s.hash,true);
 assert.ok(r.flowConfig);
 await h.engine.settled(r.id);
 const forged=structuredClone(h.store.run(r.id));forged.flowConfig.mode='custom';forged.flowConfigHash=hash(forged.flowConfig);
 assert.throws(()=>h.store.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(forged),r.id),/IMMUTABLE_FLOW_CONFIG/);
 delete forged.flowConfig;delete forged.flowConfigHash;
 assert.throws(()=>h.store.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(forged),r.id),/IMMUTABLE_FLOW_CONFIG/);
 assert.throws(()=>h.store.db.prepare('INSERT OR REPLACE INTO runs VALUES(?,?,?,?)').run(r.id,p.id,forged.version,JSON.stringify(forged)),/IMMUTABLE_FLOW_CONFIG/);
 assert.throws(()=>h.store.db.prepare('DELETE FROM runs WHERE id=?').run(r.id),/IMMUTABLE_FLOW_CONFIG/);
 assert.equal(h.store.run(r.id).flowConfigHash,r.flowConfigHash);
});

test('SQLite cannot turn a frozen snapshot into a string and then relabel it as legacy',async t=>{
 const h=harness(t);fixedControllerCapacity(h.engine);const {p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);await h.engine.settled(r.id);
 const original=h.store.run(r.id),changed=structuredClone(original);changed.flowConfig=JSON.stringify(original.flowConfig);
 h.store.db.exec('SAVEPOINT snapshot_type_probe');
 try{assert.throws(()=>h.store.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(changed),r.id),/IMMUTABLE_FLOW_CONFIG/);}
 finally{h.store.db.exec('ROLLBACK TO snapshot_type_probe; RELEASE snapshot_type_probe');}
 assert.deepEqual(h.store.run(r.id).flowConfig,original.flowConfig);
});

test('SQLite conflict UPDATE and explicit rowid REPLACE cannot evict a frozen Flow with recursive triggers off',async t=>{
 const h=harness(t);fixedControllerCapacity(h.engine);const {p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);await h.engine.settled(r.id);
 const legacy={...h.store.run(r.id),id:'legacy-rowid-probe',flowName:'dreamflow',configFingerprint:hash(h.config)};delete legacy.flowConfig;delete legacy.flowConfigHash;h.store.insertRun(legacy);
 const rowid=h.store.db.prepare('SELECT rowid n FROM runs WHERE id=?').get(r.id).n;
 h.store.db.exec('PRAGMA recursive_triggers=OFF');
 for(const attack of [()=>h.store.db.prepare('UPDATE OR REPLACE runs SET id=? WHERE id=?').run(r.id,legacy.id),
  ()=>h.store.db.prepare('INSERT OR REPLACE INTO runs(rowid,id,project_id,version,data) VALUES(?,?,?,?,?)').run(rowid,'replacement-id',p.id,1,JSON.stringify(legacy))]){
  h.store.db.exec('SAVEPOINT snapshot_conflict_probe');
  try{assert.throws(attack,/IMMUTABLE_FLOW_CONFIG/);}
  finally{h.store.db.exec('ROLLBACK TO snapshot_conflict_probe; RELEASE snapshot_conflict_probe');}
 }
 assert.equal(h.store.run(r.id).flowConfigHash,r.flowConfigHash);assert.equal(h.store.run(legacy.id).flowName,'dreamflow');
});

test('SQLite rejects duplicate top-level snapshot keys before JSON.parse could select another approved-looking value',async t=>{
 const h=harness(t);fixedControllerCapacity(h.engine);const {p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);await h.engine.settled(r.id);
 const original=h.store.run(r.id),forged=structuredClone(original.flowConfig);forged.roles.planner2.model='forged-model';
 const raw=JSON.stringify(original).slice(0,-1)+',"flowConfig":'+JSON.stringify(forged)+',"flowConfigHash":'+JSON.stringify(hash(forged))+'}';
 assert.equal(JSON.parse(raw).flowConfig.roles.planner2.model,'forged-model');
 h.store.db.exec('SAVEPOINT duplicate_json_probe');
 try{assert.throws(()=>h.store.db.prepare('UPDATE runs SET data=? WHERE id=?').run(raw,r.id),/FLOW_CONFIG_JSON_AMBIGUOUS/);}
 finally{h.store.db.exec('ROLLBACK TO duplicate_json_probe; RELEASE duplicate_json_probe');}
 assert.equal(h.store.run(r.id).flowConfigHash,r.flowConfigHash);
});
