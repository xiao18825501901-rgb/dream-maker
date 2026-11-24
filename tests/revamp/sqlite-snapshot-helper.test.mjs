// Trusted fixture-created databases only. Production parsing must stay in the isolated WSL worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {root} from '../helpers.mjs';
import {childEnv} from '../../dist/server/security.js';
const program=String.raw`import hashlib,json,pathlib,runpy,sqlite3,sys
helper=runpy.run_path(sys.argv[1]); folder=pathlib.Path(sys.argv[2]); mode=sys.argv[3]
path=folder/'project.sqlite'; writer=sqlite3.connect(str(path))
writer.execute('PRAGMA journal_mode=WAL'); writer.execute('PRAGMA wal_autocheckpoint=0')
writer.execute('CREATE TABLE items(value TEXT)'); writer.execute("INSERT INTO items VALUES ('committed')"); writer.commit()
writer.execute("INSERT INTO items VALUES ('pending')")
if mode=='extra': (folder/'unknown.bin').write_bytes(b'keep untouched')
if mode=='collision': (folder/'.dm-snapshot.sqlite').write_bytes(b'keep old partial snapshot')
if mode=='total':
    writer.rollback();writer.close();writer=None
    for name,size in [('project.sqlite',64*1024*1024),('project.sqlite-wal',64*1024*1024),('project.sqlite-journal',2*1024*1024)]:
        with open(folder/name,'ab') as file: file.truncate(size)
before=hashlib.sha256(path.read_bytes()).hexdigest()
if mode=='total': print('TOTAL_FIXTURE_READY',file=sys.stderr,flush=True)
try:
    if mode in ['extra','collision','total']:
        try: helper['create_snapshot'](folder)
        except RuntimeError as error: print(json.dumps({'denied':str(error),'sourceUnchanged':hashlib.sha256(path.read_bytes()).hexdigest()==before}))
        else: raise AssertionError('unsafe input accepted')
    else:
        result=helper['create_snapshot'](folder)
        check=sqlite3.connect(str(folder/'.dm-snapshot.sqlite'))
        try:
            assert check.execute('SELECT count(*) FROM items').fetchone()[0]==1
            assert check.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        finally: check.close()
        assert not (folder/'.dm-snapshot.sqlite-wal').exists()
        assert not (folder/'.dm-snapshot.sqlite-shm').exists()
        assert writer.execute('SELECT count(*) FROM items').fetchone()[0]==2
        print(json.dumps(result))
finally:
    if writer is not None: writer.rollback();writer.close()
`;
for(const mode of ['normal','extra','collision','total'])test('fixed SQLite snapshot helper '+mode+' handles actual WAL/transactions without claiming source or role acceptance',t=>{
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const directory=mkdtempSync(join(parent,'sqlite-snapshot-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const result=spawnSync('python',['-I','-c',program,join(root,'scripts/isolation/sqlite-snapshot.py'),directory,mode],{cwd:root,env:childEnv({TEMP:directory,TMP:directory}),encoding:'utf8',timeout:mode==='total'?60000:15000,windowsHide:true,maxBuffer:128000});
 assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout);
 if(mode==='normal'){assert.equal(value.integrity,'ok');assert.ok(value.bytes>0);assert.match(value.sha256,/^[a-f0-9]{64}$/);assert.equal(value.schema,'dream-maker.sqlite-snapshot.v1');}
 else{assert.equal(value.sourceUnchanged,true);assert.match(value.denied,mode==='extra'?/SQLITE_DATA_UNDECLARED_FILE/:mode==='total'?/SQLITE_DATA_TOTAL_LIMIT/:/SQLITE_SNAPSHOT_ALREADY_EXISTS/);}
});
