// Actual SQLite/file substitution in owned test directories, never a native model proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {StateMaintenance} from '../../dist/server/maintenance.js';
import {ManagedDatasets} from '../../dist/server/managed-data.js';
import {hash} from '../../dist/server/security.js';
import {harness,ready,root} from '../helpers.mjs';
test('restore cannot take rows from a valid database swapped after prior path verification',async t=>{
 const h=harness(t,0);
 // This file tests a storage race, not OS capacity. Only its fixed Demo uses a deterministic
 // logical scheduler sample; production and measured Engine integration tests stay unchanged.
 h.engine.dispatch.binding.measure=()=>({cpu:2,memoryMiB:1024,availableMemoryMiB:2048,sampledAt:new Date().toISOString()});
 const {p,s}=await ready(h),created=h.engine.create(p.id,s.hash,true);await h.engine.settled(created.id);const run=h.store.run(created.id),data=new ManagedDatasets(h.store,root),maintenance=new StateMaintenance({store:h.store,data:h.dir,isBusy:()=>false}),actor='local-session:'+'a'.repeat(64),tasks=title=>[{id:'t1',title,done:false}];
 data.importBrowser(run.id,run.treeHash,tasks('原副本内容'),true,hash('race-import'),actor);const a=maintenance.create('race-a'),rehearsal=maintenance.rehearse(a.id,'race-rehearsal');
 data.writePreview(run.id,run.treeHash,tasks('后来的有效内容'),1,hash('race-edit'),actor);const b=maintenance.create('race-b');
 const originalClose=DatabaseSync.prototype.close;let closes=0,swapped=false;
 const hook=t.mock.method(DatabaseSync.prototype,'close',function(){const result=Reflect.apply(originalClose,this,[]);if(++closes===2){copyFileSync(resolve(h.dir,'controller/state-backups',b.id,'application.sqlite'),resolve(h.dir,'controller/state-rehearsals',rehearsal.id,'application.sqlite'));swapped=true;}return result;});
 try{assert.throws(()=>data.restoreFromRehearsal(p.id,2,()=>maintenance.managedDataSource(a.id,rehearsal.id,p.id),hash('race-restore'),actor),{code:'MAINTENANCE_REHEARSAL_CHANGED'});}
 finally{hook.mock.restore();}
 assert.equal(swapped,true);assert.equal(data.read(p.id).revision,2);assert.equal(h.store.records(p.id,'ManagedDataRestore').length,0);
});
