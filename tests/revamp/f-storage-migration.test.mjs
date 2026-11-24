// Actual F filesystem and authenticated local HTTP; no model, provider receipt or Live claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createApp} from '../../dist/server/http.js';
import {migrationBackup} from '../../dist/server/migration-backup.js';
import {treeHash} from '../../dist/server/workspace.js';
import {harness,ready,root} from '../helpers.mjs';

test('upgrade backup publishes a verified immutable copy on the project filesystem',t=>{
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});
 const dir=mkdtempSync(resolve(parent,'f-backup-')),path=resolve(dir,'state.sqlite'),db=new DatabaseSync(path);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 db.exec("CREATE TABLE original(id TEXT PRIMARY KEY,value TEXT); INSERT INTO original VALUES('one','保留的业务数据')");
 const copy=migrationBackup(db,path,3),bytes=readFileSync(copy);
 const inspected=new DatabaseSync(copy,{readOnly:true});try{assert.equal(inspected.prepare('SELECT value FROM original').get().value,'保留的业务数据');}finally{inspected.close();}
 assert.equal(migrationBackup(db,path,3),copy);assert.deepEqual(readFileSync(copy),bytes);
});

test('old workspaces cannot resume even with valid plan/config and a held lease',async t=>{
 const h=harness(t),{p,s}=await ready(h),r=h.engine.create(p.id,s.hash,true);
 h.engine.pause(r.id);await h.engine.settled(r.id);
 const old=resolve(h.dir,'old-workspaces',r.id);mkdirSync(old,{recursive:true});writeFileSync(resolve(old,'marker.txt'),'old output');
 const saved=h.store.run(r.id);saved.workspace=old;saved.treeHash=treeHash(old);h.store.saveRun(saved);
 assert.equal(h.store.owns(p.id,r.id),true);
 await assert.rejects(h.engine.resume(r.id),{code:'WORKSPACE_LOCATION_CHANGED'});
 assert.equal(readFileSync(resolve(old,'marker.txt'),'utf8'),'old output');
 assert.equal(h.store.run(r.id).workspace,old);
});

async function localHistory(t){
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(resolve(parent,'f-history-'));
 const denied=()=>{throw Error('NO_NATIVE_ROLE_IN_MIGRATION_TEST');};
 const app=await createApp({root,data,configPath:resolve(data,'config.json'),port:0,demoDelayMs:0,nativeExecution:{assertReady:denied,executor:denied,verify:denied,async close(){}}});
 t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const {p,s}=await ready({store:app.store,interviews:app.interviews}),created=app.engine.create(p.id,s.hash,true);
 app.engine.pause(created.id);await app.engine.settled(created.id);
 const old=resolve(data,'original-location',created.id);mkdirSync(old,{recursive:true});writeFileSync(resolve(old,'marker.txt'),'saved output');
 const run=app.store.run(created.id);run.workspace=old;run.treeHash=treeHash(old);app.store.saveRun(run);
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})});
 const cookie=login.headers.get('set-cookie').split(';')[0];await login.json();
 const read=async()=>{const response=await fetch(app.origin+'/api/runs/'+run.id+'/files?path=marker.txt',{headers:{cookie}});return {status:response.status,body:await response.json()};};
 return {app,data,old,run,read};
}

test('historical files fail closed without a verified relocation instead of reading the old root',async t=>{
 const {read}=await localHistory(t),response=await read();
 assert.equal(response.status,409);assert.equal(response.body.error,'WORKSPACE_LOCATION_CHANGED');
});

test('historical reads use the copied root, detect its changes, and never rewrite run provenance',async t=>{
 const {app,data,old,run,read}=await localHistory(t),target=resolve(data,'workspaces',run.id);
 writeFileSync(resolve(target,'marker.txt'),'saved output');
 // This test-only storage receipt grants no execution or acceptance; production uses the full F copy receipt.
 const receipt=resolve(data,'test-copy-receipt.json'),receiptBytes=Buffer.from(JSON.stringify({schema:'dream-maker.project-copy-receipt.v2',source:resolve(data,'original-location'),suite:resolve(data,'..'),allFileHashes:'PASS',sourceSecondPass:'PASS',sourceNamespaces:'PASS'}));writeFileSync(receipt,receiptBytes);
 writeFileSync(resolve(data,'workspace-relocations.json'),JSON.stringify({schema:'dream-maker.workspace-relocations.v1',dataRoot:data,copyReceipt:{path:receipt,sha256:createHash('sha256').update(receiptBytes).digest('hex')},provenance:'COPIED_BYTES_NOT_EXECUTION_PROOF',entries:[{runId:run.id,from:old,to:target,treeHash:treeHash(target),recordedTreeHash:run.treeHash}]}));
 writeFileSync(resolve(old,'marker.txt'),'must never read the old directory');
 const copied=await read();assert.equal(copied.status,200);assert.equal(copied.body.content,'saved output');
 assert.equal(app.store.run(run.id).workspace,old);assert.equal(app.store.run(run.id).treeHash,run.treeHash);
 writeFileSync(resolve(target,'marker.txt'),'modified copy');
 const changed=await read();assert.equal(changed.status,409);assert.equal(changed.body.error,'RELOCATED_WORKSPACE_CHANGED');
 assert.equal(readFileSync(resolve(old,'marker.txt'),'utf8'),'must never read the old directory');
});

test('storage scope rejects an old data root before creating it',async t=>{
 const {assertProjectStorage}=await import('../../dist/server/workspace-location.js');
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const dir=mkdtempSync(resolve(parent,'f-scope-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const suite=resolve(dir,'suite'),project=resolve(suite,'worktrees/project'),old=resolve(dir,'old-data');mkdirSync(project,{recursive:true});
 writeFileSync(resolve(suite,'workspace-storage.json'),JSON.stringify({schema:'dream-maker.workspace-storage.v1',suiteRoot:suite}));
 assert.throws(()=>assertProjectStorage(project,old),{code:'STORAGE_ROOT_CHANGED'});assert.equal(existsSync(old),false);
 assert.doesNotThrow(()=>assertProjectStorage(project,resolve(suite,'data/project')));
});

test('storage scope accepts only explicitly listed additional data roots',async t=>{
 const {assertProjectStorage}=await import('../../dist/server/workspace-location.js');
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const dir=mkdtempSync(resolve(parent,'f-additional-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const suite=resolve(dir,'suite'),project=resolve(suite,'worktrees/project'),external=resolve(dir,'custom-data');mkdirSync(project,{recursive:true});
 writeFileSync(resolve(suite,'workspace-storage.json'),JSON.stringify({schema:'dream-maker.workspace-storage.v1',suiteRoot:suite,additionalDataRoots:[external]}));
 assert.throws(()=>assertProjectStorage(project,external),{code:'STORAGE_ROOT_CHANGED'});
 assert.doesNotThrow(()=>assertProjectStorage(project,resolve(external,'data'),{allowAdditionalDataRoots:true}));
 assert.doesNotThrow(()=>assertProjectStorage(project,resolve(external,'nested'),{allowAdditionalDataRoots:true}));
 assert.throws(()=>assertProjectStorage(project,resolve(dir,'outside'),{allowAdditionalDataRoots:true}),{code:'STORAGE_ROOT_CHANGED'});
});
