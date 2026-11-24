// Only synthetic application state; original user database is never opened/copied.
import test from 'node:test';import assert from 'node:assert/strict';
import {resolve} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {harness,ready} from '../helpers.mjs';
import {StateMaintenance} from '../../dist/server/maintenance.js';
test('PW schema9 snapshot and restore rehearsal preserve immutable Prework records',async t=>{
 const h=harness(t),{p}=await ready(h);
 const id=h.store.record('PreworkContract',p.id,null,{scope:'SYNTHETIC_BACKUP_RECORD_NOT_LIVE',contract:{contractId:'synthetic-contract'}});
 const service=new StateMaintenance({store:h.store,data:h.dir,isBusy:()=>false});
 const snapshot=service.create('OFFLINE_PREWORK_SNAPSHOT');assert.equal(snapshot.status,'VERIFIED');
 const rehearsal=service.rehearse(snapshot.id,'OFFLINE_PREWORK_REHEARSAL');assert.equal(rehearsal.engineStarted,false);
 const copy=new DatabaseSync(resolve(h.dir,'controller/state-backups',snapshot.id,'application.sqlite'),{readOnly:true});
 try{
  assert.equal(copy.prepare('SELECT max(version) v FROM schema_versions').get().v,9);
  assert.equal(copy.prepare('SELECT id FROM records WHERE id=?').get(id).id,id);
  assert.equal(copy.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'prework_record_%'").get().n,4);
  assert.equal(copy.prepare('SELECT record_id FROM prework_record_identities WHERE record_id=?').get(id).record_id,id);
 }finally{copy.close();}
 assert.equal(h.store.records(p.id,'PreworkContract')[0].id,id);
});
