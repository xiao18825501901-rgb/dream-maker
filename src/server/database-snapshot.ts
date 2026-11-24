import type {DatabaseSync} from 'node:sqlite';
import {lstatSync,chmodSync} from 'node:fs';
import {DomainError} from './security.js';
export const SNAPSHOT_FILE_LIMIT=256000000;
export function snapshotDatabaseBytes(db:DatabaseSync):number{
 const pages=Number(db.prepare('PRAGMA page_count').get()?.page_count),size=Number(db.prepare('PRAGMA page_size').get()?.page_size),bytes=pages*size;
 if(!Number.isSafeInteger(bytes)||bytes<1||bytes>SNAPSHOT_FILE_LIMIT)throw new DomainError('MAINTENANCE_FILE_DENIED',409);return bytes;
}
export function captureDatabaseState(db:DatabaseSync,path:string):void{
 snapshotDatabaseBytes(db);db.prepare('VACUUM INTO ?').run(path);
 const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>SNAPSHOT_FILE_LIMIT)throw new DomainError('MAINTENANCE_FILE_DENIED',409);
 try{chmodSync(path,0o600);}catch{/* Native Windows data-directory protection is checked independently. */}
}
