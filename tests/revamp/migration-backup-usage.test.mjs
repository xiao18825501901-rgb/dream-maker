// Real SQLite staging sizes and exclusive publication on either filesystem, only owned temporary copies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,unlinkSync,readdirSync,lstatSync,writeFileSync,readFileSync,linkSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {migrationBackup} from '../../dist/server/migration-backup.js';
import {root} from '../helpers.mjs';
function setup(t){const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const dir=mkdtempSync(resolve(parent,'bu-')),path=resolve(dir,'state.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE journal(id TEXT PRIMARY KEY, data TEXT); INSERT INTO journal VALUES(\'one\',\'preserved\')');t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});return {dir,path,db};}
test('a verified stage resumes exclusive publication without rebuilding or deleting the stage',t=>{
 const {dir,path,db}=setup(t),probe=resolve(dir,'link-capability'),alias=resolve(dir,'link-alias');writeFileSync(probe,'filesystem capability');let hardLinks=false;
 try{linkSync(probe,alias);hardLinks=true;}catch(error){assert.ok(['EPERM','EACCES','ENOTSUP','EOPNOTSUPP','ENOSYS','EINVAL','EISDIR'].includes(error.code));}finally{if(existsSync(alias))unlinkSync(alias);unlinkSync(probe);}
 const first=migrationBackup(db,path,3),folder=resolve(dir,'migration-backups'),stage=resolve(folder,readdirSync(folder).find(n=>n.startsWith('stage-'))),before=lstatSync(stage,{bigint:true}),bytes=readFileSync(stage);
 unlinkSync(first);assert.equal(migrationBackup(db,path,3),first);assert.equal(readdirSync(folder).length,2);
 assert.equal(lstatSync(stage,{bigint:true}).ino,before.ino);assert.deepEqual(readFileSync(stage),bytes);assert.deepEqual(readFileSync(first),bytes);
 if(hardLinks){assert.equal(lstatSync(first,{bigint:true}).ino,before.ino);assert.equal(lstatSync(stage).nlink,2);}
 else{assert.equal(lstatSync(stage).nlink,1);assert.equal(lstatSync(first).nlink,1);}
});
test('reused logical copies use their actual physical size for the additional alias quota',t=>{
 const {dir,path,db}=setup(t),first=migrationBackup(db,path,3),folder=resolve(dir,'migration-backups'),stage=resolve(folder,readdirSync(folder).find(n=>n.startsWith('stage-')));
 unlinkSync(first);const copy=new DatabaseSync(stage);try{copy.exec('PRAGMA page_size=65536; VACUUM');}finally{copy.close();}
 const actual=lstatSync(stage).size,sourceBytes=Number(db.prepare('PRAGMA page_count').get().page_count)*Number(db.prepare('PRAGMA page_size').get().page_size);assert.ok(actual>sourceBytes+1024);
 assert.throws(()=>migrationBackup(db,path,3,actual+sourceBytes+1024),{code:'MIGRATION_BACKUP_LIMIT'});assert.equal(readdirSync(folder).length,1);
});
