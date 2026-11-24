// Real SQLite in-memory only; no project data, model call or Native evidence.
import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../../dist/server/store.js';
const kinds=['PreworkContract','PreworkPackageResult','PreworkCloseout'];
const data=(key='SYNTHETIC_KEY')=>({scope:'SYNTHETIC_IMMUTABILITY_TEST_ONLY',contract:{contractId:key},dispatchId:key});
function setup(t,kind){const store=new Store(':memory:');t.after(()=>store.close());const id=store.record(kind,'SYNTHETIC_PROJECT','SYNTHETIC_RUN',data());const row=store.db.prepare('SELECT rowid,* FROM records WHERE id=?').get(id);return{store,row};}
for(const kind of kinds)test(`PW immutable ${kind} cannot be replaced through rowid with another id/kind`,t=>{
 const{store,row}=setup(t,kind);
 assert.throws(()=>store.db.prepare('INSERT OR REPLACE INTO records(rowid,id,kind,project_id,run_id,data,at) VALUES(?,?,?,?,?,?,?)').run(row.rowid,'SYNTHETIC_REPLACEMENT','OrdinaryRecord',row.project_id,row.run_id,'{}',row.at),/PREWORK_RECORD_IMMUTABLE/);
 assert.deepEqual(store.db.prepare('SELECT rowid,* FROM records WHERE id=?').get(row.id),row);
});
for(const kind of ['PreworkContract','PreworkPackageResult'])test(`PW immutable ${kind} cannot be replaced through its unique business key`,t=>{
 const{store,row}=setup(t,kind);
 assert.throws(()=>store.db.prepare('INSERT OR REPLACE INTO records(id,kind,project_id,run_id,data,at) VALUES(?,?,?,?,?,?)').run('SYNTHETIC_REPLACEMENT',kind,row.project_id,row.run_id,row.data,row.at),/PREWORK_RECORD_IMMUTABLE/);
 assert.deepEqual(store.db.prepare('SELECT rowid,* FROM records WHERE id=?').get(row.id),row);
});
for(const kind of kinds)for(const column of ['rowid','id'])test(`PW ordinary UPDATE OR REPLACE cannot delete ${kind} through ${column}`,t=>{
 const{store,row}=setup(t,kind),other=store.record('OrdinaryRecord',null,null,{});
 assert.throws(()=>store.db.prepare(`UPDATE OR REPLACE records SET ${column}=? WHERE id=?`).run(row[column],other),/PREWORK_RECORD_IMMUTABLE/);
 assert.deepEqual(store.db.prepare('SELECT rowid,* FROM records WHERE id=?').get(row.id),row);
 assert.ok(store.db.prepare('SELECT id FROM records WHERE id=?').get(other));
});
test('PW immutable protection still permits distinct append-only results and ordinary legacy replacements',t=>{
 const{store}=setup(t,'PreworkPackageResult');store.record('PreworkPackageResult','SYNTHETIC_PROJECT','SYNTHETIC_RUN',data('SYNTHETIC_SECOND'));
 assert.equal(store.records('SYNTHETIC_PROJECT','PreworkPackageResult').length,2);
 const id=store.record('OrdinaryRecord',null,null,{});
 store.db.prepare("INSERT OR REPLACE INTO records(id,kind,data,at) VALUES(?,'OrdinaryRecord','{}','SYNTHETIC_TIME')").run(id);
 assert.equal(store.db.prepare('SELECT at FROM records WHERE id=?').get(id).at,'SYNTHETIC_TIME');
});

test('PW a protected negative rowid neither blocks unrelated automatic IDs nor permits replacement',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 store.db.prepare("INSERT INTO records(rowid,id,kind,data,at) VALUES(-1,'SYNTHETIC_NEGATIVE','PreworkCloseout','{}','SYNTHETIC_TIME')").run();
 const ordinary=store.record('OrdinaryRecord',null,null,{});
 const appended=store.record('PreworkCloseout','SYNTHETIC_PROJECT','SYNTHETIC_RUN',data());
 assert.ok(store.db.prepare('SELECT id FROM records WHERE id=?').get(ordinary));
 assert.ok(store.db.prepare('SELECT id FROM records WHERE id=?').get(appended));
 assert.throws(()=>store.db.prepare("INSERT OR REPLACE INTO records(rowid,id,kind,data,at) VALUES(-1,'SYNTHETIC_OTHER','OrdinaryRecord','{}','SYNTHETIC_TIME')").run(),/PREWORK_RECORD_IMMUTABLE/);
 assert.equal(store.db.prepare('SELECT id FROM records WHERE rowid=-1').get().id,'SYNTHETIC_NEGATIVE');
});
test('PW protected record identity anchors are immutable and cannot be redirected',t=>{
 const{store,row}=setup(t,'PreworkContract');
 const before=store.db.prepare('SELECT * FROM prework_record_identities').all();
 assert.throws(()=>store.db.prepare('UPDATE prework_record_identities SET record_rowid=99').run(),/PREWORK_RECORD_IMMUTABLE/);
 assert.throws(()=>store.db.prepare('DELETE FROM prework_record_identities').run(),/PREWORK_RECORD_IMMUTABLE/);
 assert.throws(()=>store.db.prepare('INSERT OR REPLACE INTO prework_record_identities(record_id,record_rowid) VALUES(?,?)').run(row.id,99),/PREWORK_RECORD_IMMUTABLE/);
 assert.deepEqual(store.db.prepare('SELECT * FROM prework_record_identities').all(),before);
});
