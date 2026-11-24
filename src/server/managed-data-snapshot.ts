import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {decodeManagedVersion} from './managed-data.js';
import {FIXED_DEMO_DATA_KIND,type ManagedDataCounts} from '../shared/managed-data.js';
import {DomainError} from './security.js';
import {decodeJsonVersion} from './json-data.js';
import {JSON_DATA_KIND} from '../shared/json-data.js';
import {decodeSqliteVersion} from './sqlite-data.js';
import {SQLITE_DATA_KIND} from '../shared/sqlite-data.js';
const fail=():never=>{throw new DomainError('MANAGED_DATA_INTEGRITY_FAILED',409);};
const sha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** Streams bounded rows from a previously byte-bounded readonly SQLite snapshot. */
export function inspectManagedData(db:DatabaseSync):ManagedDataCounts{
 const counts:Record<string,number>={};for(const table of ['managed_dataset_versions','managed_dataset_heads','managed_dataset_operations','state_snapshot_anchors']){const n=Number(db.prepare('SELECT count(*) n FROM '+table).get()!.n);if(n>100000)fail();counts[table]=n;}
 if(db.prepare('SELECT 1 FROM managed_dataset_versions WHERE length(CAST(data_json AS BLOB))>100000 LIMIT 1').get())fail();
 const roots=new Map<string,{revision:number;hash:string}>(),digest=createHash('sha256');
 for(const row of db.prepare('SELECT * FROM managed_dataset_versions ORDER BY project_id,kind,revision LIMIT 100001').iterate()){
   const v=row.kind===JSON_DATA_KIND?decodeJsonVersion(row):row.kind===SQLITE_DATA_KIND?decodeSqliteVersion(row):decodeManagedVersion(row),key=JSON.stringify([v.projectId,v.kind]),old=roots.get(key);
  if(!old&&v.revision!==1||old&&(v.revision!==old.revision+1||v.parentHash!==old.hash))fail();
  roots.set(key,{revision:v.revision,hash:v.contentHash});digest.update(JSON.stringify(['version',v.projectId,v.kind,v.revision,v.contentHash])+'\n');
 }
 for(const row of db.prepare('SELECT * FROM managed_dataset_heads ORDER BY project_id,kind LIMIT 100001').iterate()){
   const key=JSON.stringify([row.project_id,row.kind]),last=roots.get(key);if(![FIXED_DEMO_DATA_KIND,JSON_DATA_KIND,SQLITE_DATA_KIND].includes(String(row.kind))||!last||last.revision!==Number(row.revision))fail();
  roots.delete(key);digest.update(JSON.stringify(['head',row.project_id,row.kind,row.revision])+'\n');
 }
 if(roots.size)fail();
 for(const row of db.prepare('SELECT * FROM managed_dataset_operations ORDER BY operation_hash LIMIT 100001').iterate()){
   if(![FIXED_DEMO_DATA_KIND,JSON_DATA_KIND,SQLITE_DATA_KIND].includes(String(row.kind))||!sha(row.operation_hash)||!sha(row.input_hash)||!Number.isSafeInteger(Number(row.applied_revision))||Number(row.applied_revision)<1||!Number.isFinite(Date.parse(String(row.at))))fail();
  digest.update(JSON.stringify(['operation',row.operation_hash,row.project_id,row.kind,row.input_hash,row.applied_revision,row.at])+'\n');
 }
 for(const row of db.prepare('SELECT * FROM state_snapshot_anchors LIMIT 100001').iterate())if(typeof row.snapshot_id!=='string'||!/^snapshot_[a-f0-9]{32}$/.test(row.snapshot_id)||!sha(row.manifest_hash)||!Number.isFinite(Date.parse(String(row.created_at))))fail();
 return {datasets:counts.managed_dataset_heads,versions:counts.managed_dataset_versions,operations:counts.managed_dataset_operations,rootHash:digest.digest('hex')};
}
