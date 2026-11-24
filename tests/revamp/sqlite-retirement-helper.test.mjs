// Actual dedicated Linux filesystem with synthetic resource/commit metadata; NOT Native role or business proof.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
import {root} from '../helpers.mjs';import {childEnv,hash} from '../../dist/server/security.js';import {WSL_ENVIRONMENT} from '../../dist/server/wsl-sandbox.js';
test('fixed retirement helper releases only a committed closed container and preserves all original evidence',()=>{
 const helper=readFileSync(root+'/scripts/isolation/sqlite-retire.py','utf8');
 const tests=String.raw`
import hashlib,json,os,pathlib,shutil,tempfile
ns={'__name__':'offline_retirement_helper'}
exec(compile(SOURCE,'<fixed-controller-helper>','exec'),ns)
parent=pathlib.Path('/opt/dream-maker-acceptance-20261011/.retire-helper-tests');parent.mkdir(mode=0o700,exist_ok=True)
checks=[]
def digest(v): return hashlib.sha256(json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def fixture(base):
 job=base/'wsl_job_offline_retirement';job.mkdir(mode=0o711)
 raw=b'{"entries":[],"schema":"offline-manifest"}';(job/'retention.json').write_bytes(raw)
 reservation={'jobId':job.name,'sourceHash':'a'*64,'workerHash':'b'*64,'reservedBytes':805306368};(job/'sqlite-reserved.json').write_text(json.dumps(reservation))
 with (job/'retained.bin').open('wb') as f: f.truncate(536870912)
 result={'schema':'dream-maker.wsl-result.v1','jobId':job.name,'sourceHash':'a'*64,'workerHash':'b'*64,'environment':'DreamMaker-Acceptance-F-20261101-R2','status':'EXECUTED','exitCode':0,'stdout':'OFFLINE_PRIVATE_BUSINESS_VALUE','stderr':'','cleanup':{'remainingPids':[],'groupRemoved':True,'delegationRestored':True,'sourceUnchanged':True},'sqlite':{'inputHash':'c'*64,'expectedRevision':0,'snapshotStatus':'READY','snapshot':{'schema':'dream-maker.sqlite-snapshot.v1','bytes':8192,'sha256':'d'*64,'integrity':'ok'},'retention':{'state':'RETAINED','manifestHash':hashlib.sha256(raw).hexdigest(),'containerBytes':536870912}}}
 (job/'result.json').write_text(json.dumps(result))
 for name in ['result.json','retention.json','sqlite-reserved.json','retained.bin']: (job/name).chmod(0o600)
 final={'schema':'dream-maker.wsl-resource-final.v1','environment':'DreamMaker-Acceptance-F-20261101-R2','jobId':job.name,'sourceHash':'a'*64,'workerHash':'b'*64,'resourceHelperHash':'e'*64,'resultHash':digest(result)}
 basis={'schema':'dream-maker.sqlite-retirement-basis.v1','projectId':'OFFLINE_PROJECT','runId':'OFFLINE_RUN','specHash':'f'*64,'operationHash':'1'*64,'revision':1,'versionHash':'2'*64,'jobId':job.name,'sourceHash':'a'*64,'inputHash':'c'*64,'resultHash':digest(result),'manifestHash':hashlib.sha256(raw).hexdigest(),'workerHash':'b'*64,'resourceHelperHash':'e'*64,'resourceFinalHash':digest(final),'imageHash':'d'*64,'imageBytes':8192,'parentOperationHash':None,'parentImageHash':None,'parentImageBytes':0,'committedRecordId':'rec_offline_commit','requestedRecordId':'rec_offline_request','closedRecordId':'rec_offline_closed','cleanupRecordId':'rec_offline_cleanup','grantRecordId':'rec_offline_grant','originalDispatchId':'dispatch_offline'}
 basis['authorityHash']=digest(basis)
 def reader(_job): return {'result':result,'observation':{'final':final,'observed':{'scopeAbsent':True,'parentAbsent':True,'childAbsent':True}}}
 return job,basis,reader,result
def case(name,fn):
 with tempfile.TemporaryDirectory(prefix='case-',dir=parent) as folder:
  base=pathlib.Path(folder);assert base.resolve().parent==parent.resolve();job,basis,reader,result=fixture(base);fn(base,job,basis,reader,result);checks.append(name)
def valid(base,job,b,reader,result):
 original={n:(job/n).read_bytes() for n in ['result.json','retention.json','sqlite-reserved.json']}
 r=ns['retire_committed'](b,reader,base=base,parent_gone=lambda:False)
 assert r['retired'] and r['containerBytesAfter']==0 and (job/'retained.bin').stat().st_size==0
 assert not (job/'sqlite-reserved.json').exists() and (job/'sqlite-reservation-retired.json').read_bytes()==original['sqlite-reserved.json']
 for n in ['result.json','retention.json']: assert (job/n).read_bytes()==original[n]
 again=ns['retire_committed'](b,reader,base=base,parent_gone=lambda:False);assert again['retired'] and again['replayed']
case('EXACT_TRUNCATION_PRESERVES_EVIDENCE_AND_REPLAY',valid)
def deny(base,job,b,reader,result,change):
 change(base,job,b,result)
 b['authorityHash']=digest({k:v for k,v in b.items() if k!='authorityHash'})
 try: ns['retire_committed'](b,reader,base=base,parent_gone=lambda:False)
 except Exception: pass
 else: raise AssertionError('UNSAFE_RETIREMENT_ACCEPTED')
 assert (job/'retained.bin').stat().st_size==536870912 and (job/'sqlite-reserved.json').exists()
case('WRONG_RESULT_HASH',lambda *v:deny(*v,lambda base,job,b,result:b.update(resultHash='0'*64)))
case('CHANGED_MANIFEST',lambda *v:deny(*v,lambda base,job,b,result:(job/'retention.json').write_bytes(b'changed')))
case('FOREIGN_JOB',lambda *v:deny(*v,lambda base,job,b,result:b.update(jobId='wsl_job_other')))
def active(base,job,b,reader,result):
 def live(j):
  value=reader(j);value['observation']['observed']['scopeAbsent']=False;return value
 try: ns['retire_committed'](b,live,base=base,parent_gone=lambda:False)
 except Exception: pass
 else: raise AssertionError('ACTIVE_SCOPE_ACCEPTED')
 assert (job/'retained.bin').stat().st_size==536870912
case('ACTIVE_OLD_SCOPE_REFUSED',active)
def cancelled(base,job,b,reader,result):
 try: ns['retire_committed'](b,reader,base=base,parent_gone=lambda:True)
 except Exception: pass
 else: raise AssertionError('CANCEL_ACCEPTED')
 assert (job/'retained.bin').stat().st_size==536870912
case('PARENT_CANCEL_BEFORE_EFFECT',cancelled)
def link(base,job,b,reader,result):
 outside=base/'outside.bin';outside.write_bytes(b'OFFLINE_OUTSIDE_UNTOUCHED');(job/'retained.bin').unlink();(job/'retained.bin').symlink_to(outside)
 try: ns['retire_committed'](b,reader,base=base,parent_gone=lambda:False)
 except Exception: pass
 else: raise AssertionError('SYMLINK_ACCEPTED')
 assert outside.read_bytes()==b'OFFLINE_OUTSIDE_UNTOUCHED'
case('SYMLINK_NEVER_TRUNCATES_OTHER_FILE',link)

def pending_record(job,b,state):
 reservation_hash=hashlib.sha256((job/'sqlite-reserved.json').read_bytes()).hexdigest()
 return {'schema':'dream-maker.sqlite-retirement.v1','jobId':b['jobId'],'authorityHash':b['authorityHash'],'resultHash':b['resultHash'],'manifestHash':b['manifestHash'],'reservationHash':reservation_hash,'metadataBytes':65536,'state':state}

def interrupted(base,job,b,reader,result):
 original={n:(job/n).read_bytes() for n in ['result.json','retention.json','sqlite-reserved.json']}
 started=pending_record(job,b,'STARTED');(job/'retirement.json').write_text(json.dumps(started));(job/'retirement.json').chmod(0o600)
 with (job/'retained.bin').open('r+b') as f:f.truncate(0);f.flush();os.fsync(f.fileno())
 finished={**started,'state':'RETIRED'};(job/'retirement.json.next').write_text(json.dumps(finished));(job/'retirement.json.next').chmod(0o600)
 r=ns['retire_committed'](b,reader,base=base)
 assert r['retired'] and r['reservationReleased'] and (job/'retained.bin').stat().st_size==0 and not (job/'retirement.json.next').exists()
 assert (job/'sqlite-reservation-retired.json').read_bytes()==original['sqlite-reserved.json']
 for n in ['result.json','retention.json']:assert (job/n).read_bytes()==original[n]
case('RECOVER_FSYNCED_RETIRED_TEMP_AFTER_TRUNCATE',interrupted)

def interrupted_start(base,job,b,reader,result):
 (job/'retirement.json.next').write_text(json.dumps(pending_record(job,b,'STARTED')));(job/'retirement.json.next').chmod(0o600)
 r=ns['retire_committed'](b,reader,base=base);assert r['retired'] and r['reservationReleased'] and not (job/'retirement.json.next').exists()
case('RECOVER_FSYNCED_START_TEMP_BEFORE_TRUNCATE',interrupted_start)

def reservation_replay(base,job,b,reader,result):
 (job/'retirement.json').write_text(json.dumps(pending_record(job,b,'RETIRED')));(job/'retirement.json').chmod(0o600)
 with (job/'retained.bin').open('r+b') as f:f.truncate(0);f.flush();os.fsync(f.fileno())
 def observe_cancel():
  assert json.loads((job/'retirement.json').read_text())['state']=='RETIRED','COMPLETED_TOMBSTONE_REGRESSED'
  return False
 r=ns['retire_committed'](b,reader,base=base,parent_gone=observe_cancel);assert r['reservationReleased']
case('COMPLETED_TOMBSTONE_NOT_DOWNGRADED_ON_RESERVATION_REPLAY',reservation_replay)

def contradictory_temp(base,job,b,reader,result):
 pending=pending_record(job,b,'RETIRED');(job/'retirement.json.next').write_text(json.dumps(pending));(job/'retirement.json.next').chmod(0o600)
 try:ns['retire_committed'](b,reader,base=base)
 except Exception:pass
 else:raise AssertionError('CONTRADICTORY_TEMP_ACCEPTED')
 assert (job/'retained.bin').stat().st_size==536870912 and (job/'sqlite-reserved.json').exists() and (job/'retirement.json.next').exists()
case('RETIRED_TEMP_WITH_UNTRUNCATED_CONTAINER_REFUSED',contradictory_temp)

def foreign_temp(base,job,b,reader,result):
 pending=pending_record(job,b,'STARTED');pending['authorityHash']='0'*64
 (job/'retirement.json.next').write_text(json.dumps(pending));(job/'retirement.json.next').chmod(0o600)
 try:ns['retire_committed'](b,reader,base=base)
 except Exception:pass
 else:raise AssertionError('FOREIGN_TEMP_ACCEPTED')
 assert (job/'retained.bin').stat().st_size==536870912 and (job/'retirement.json.next').exists()
case('FOREIGN_TEMP_NOT_DISCARDED_OR_PROMOTED',foreign_temp)

def outcome(base,job,b,reader,result):
 attempt='retire_attempt_'+'a'*32;helper_hash=hashlib.sha256(SOURCE.encode()).hexdigest()
 saved=ns['execute_retirement'](b,attempt,helper_hash,reader,base=base)
 assert saved['status']=='RETIRED' and saved['result']['reservationReleased']
 observed=ns['read_retirement_state'](b,attempt,helper_hash,base=base)
 assert observed['helperAbsent'] is False and observed['outcome']==saved
 assert 'OFFLINE_PRIVATE_BUSINESS_VALUE' not in json.dumps(saved) and 'stdout' not in json.dumps(observed)
case('DURABLE_OUTCOME_EXCLUDES_PRIVATE_RESULT_BYTES',outcome)

def cancelled_outcome(base,job,b,reader,result):
 attempt='retire_attempt_'+'b'*32;helper_hash=hashlib.sha256(SOURCE.encode()).hexdigest()
 saved=ns['execute_retirement'](b,attempt,helper_hash,reader,base=base,parent_gone=lambda:True)
 assert saved['status']=='FAILED' and saved['result'] is None and saved['errorCode']=='SQLITE_RETIREMENT_CANCELLED'
 assert (job/'retained.bin').stat().st_size==536870912 and (job/'sqlite-reserved.json').exists()
 assert ns['read_retirement_state'](b,attempt,helper_hash,base=base)['outcome']==saved
case('CANCELLED_ATTEMPT_PERSISTED_WITHOUT_SIDE_EFFECT',cancelled_outcome)
print(json.dumps({'checks':checks,'count':len(checks),'scope':'REAL_LINUX_SYNTHETIC_RESOURCE_OBSERVER_NOT_NATIVE','paidModelCalls':0}))
`;
 const script='SOURCE='+JSON.stringify(helper)+'\n'+tests,result=spawnSync('wsl.exe',['-d',WSL_ENVIRONMENT,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-c','import sys;exec(compile(sys.stdin.read(),"<controller-test>","exec"))'],{cwd:root,env:childEnv(),input:script,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:128000});
 assert.equal(result.status,0,result.stderr?.replaceAll('\0','').slice(-1500));const report=JSON.parse(result.stdout.trim());assert.equal(report.count,14);assert.equal(report.paidModelCalls,0);assert.equal(hash(helper).length,64);
});
