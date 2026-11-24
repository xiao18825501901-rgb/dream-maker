// Real dedicated Linux process identity and filesystem; synthetic commit authority, NOT product-role evidence.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
import {root} from '../helpers.mjs';import {childEnv} from '../../dist/server/security.js';import {WSL_ENVIRONMENT} from '../../dist/server/wsl-sandbox.js';

test('retirement receipt distinguishes a live exact helper from a closed process and refuses substituted evidence',()=>{
 const helper=readFileSync(root+'/scripts/isolation/sqlite-retire.py','utf8');
 const script='SOURCE='+JSON.stringify(helper)+'\n'+String.raw`
import json,os,pathlib,subprocess,tempfile,hashlib
ns={'__name__':'offline_retirement_observer'};exec(compile(SOURCE,'<fixed-retirement>','exec'),ns)
parent=pathlib.Path('/opt/dream-maker-acceptance-20261011/.retire-observer-tests');parent.mkdir(mode=0o700,exist_ok=True)
checks=[]
with tempfile.TemporaryDirectory(prefix='case-',dir=parent) as folder:
 base=pathlib.Path(folder);job=base/'wsl_job_offline_observer';job.mkdir(mode=0o711)
 basis={'schema':'dream-maker.sqlite-retirement-basis.v1','projectId':'OFFLINE_PROJECT','runId':'OFFLINE_RUN','specHash':'f'*64,'operationHash':'1'*64,'revision':1,'versionHash':'2'*64,'jobId':job.name,'sourceHash':'a'*64,'inputHash':'c'*64,'resultHash':'3'*64,'manifestHash':'4'*64,'workerHash':'b'*64,'resourceHelperHash':'e'*64,'resourceFinalHash':'5'*64,'imageHash':'d'*64,'imageBytes':8192,'parentOperationHash':None,'parentImageHash':None,'parentImageBytes':0,'committedRecordId':'rec_commit','requestedRecordId':'rec_request','closedRecordId':'rec_closed','cleanupRecordId':'rec_cleanup','grantRecordId':'rec_grant','originalDispatchId':'dispatch_offline'}
 basis['authorityHash']=ns['digest'](basis)
 attempt='retire_attempt_'+'a'*32;source_hash=hashlib.sha256(SOURCE.encode()).hexdigest()
 receipt=ns['record_retirement_attempt'](basis,attempt,source_hash,base=base)
 seen=ns['observe_retirement_attempt'](basis,attempt,source_hash,ns['digest'](receipt),base=base)
 assert seen['helperAbsent'] is False and seen['attempt']==receipt
 checks.append('EXACT_LIVE_IDENTITY_NOT_CLEANUP')
 def denied(fn):
  try:fn()
  except Exception:return
  raise AssertionError('SUBSTITUTED_EVIDENCE_ACCEPTED')
 denied(lambda:ns['record_retirement_attempt'](basis,attempt,source_hash,base=base))
 denied(lambda:ns['observe_retirement_attempt'](basis,attempt,source_hash,'0'*64,base=base))
 denied(lambda:ns['observe_retirement_attempt'](basis,attempt,'0'*64,ns['digest'](receipt),base=base))
 changed=dict(basis);changed['operationHash']='9'*64;changed['authorityHash']=ns['digest']({k:v for k,v in changed.items() if k!='authorityHash'})
 denied(lambda:ns['observe_retirement_attempt'](changed,attempt,source_hash,ns['digest'](receipt),base=base))
 checks.append('DUPLICATE_OR_FOREIGN_AUTHORITY_REFUSED')
 # Child creates its own record before closing. The observer does not infer closure from a timer.
 code='SOURCE='+repr(SOURCE)+'\n'+'''import os,json,pathlib
n={'__name__':'offline_child'};exec(compile(SOURCE,'<fixed-retirement>','exec'),n)
q=json.loads(os.read(0,16384));r=n['record_retirement_attempt'](q['basis'],q['attempt'],q['sourceHash'],base=pathlib.Path(q['base']))
print(json.dumps(r),flush=True)
'''
 second='retire_attempt_'+'b'*32
 child=subprocess.run(['/usr/bin/python3','-c',code],input=json.dumps({'basis':basis,'attempt':second,'sourceHash':source_hash,'base':str(base)}),text=True,capture_output=True,timeout=10)
 assert child.returncode==0,child.stderr;closed=json.loads(child.stdout)
 assert closed['identity']['pid']!=os.getpid()
 seen=ns['observe_retirement_attempt'](basis,second,source_hash,ns['digest'](closed),base=base)
 assert seen['helperAbsent'] is True and seen['attempt']==closed
 checks.append('ACTUAL_CHILD_EXIT_FRESHLY_OBSERVED')
 target=job/(second+'.json');original=target.read_bytes();target.chmod(0o644)
 denied(lambda:ns['observe_retirement_attempt'](basis,second,source_hash,ns['digest'](closed),base=base))
 target.chmod(0o600);target.unlink();outside=base/'outside.json';outside.write_bytes(original);outside.chmod(0o600);target.symlink_to(outside)
 denied(lambda:ns['observe_retirement_attempt'](basis,second,source_hash,ns['digest'](closed),base=base))
 assert outside.read_bytes()==original
 checks.append('PUBLIC_OR_REDIRECTED_RECEIPT_REFUSED')
 denied(lambda:ns['observe_retirement_attempt'](basis,'../outside',source_hash,ns['digest'](closed),base=base))
 checks.append('PATH_INPUT_REFUSED')
print(json.dumps({'checks':checks,'count':len(checks),'modelCalls':0,'scope':'ACTUAL_LINUX_SYNTHETIC_COMMIT_AUTHORITY'}))
`;
 const result=spawnSync('wsl.exe',['-d',WSL_ENVIRONMENT,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-c','import sys;exec(compile(sys.stdin.read(),"<controller-test>","exec"))'],{cwd:root,env:childEnv(),input:script,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:128000});
 assert.equal(result.status,0,result.stderr?.replaceAll('\0','').slice(-1500));const report=JSON.parse(result.stdout.trim());assert.equal(report.count,5);assert.equal(report.modelCalls,0);
});
