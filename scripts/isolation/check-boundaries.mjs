// Real OS boundaries; direct project execution only, NOT model/DSH Live acceptance.
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,writeFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WslSandbox, WSL_ENVIRONMENT } from '../../dist/server/wsl-sandbox.js';
import { capture } from '../../dist/server/process.js';
import { childEnv,id } from '../../dist/server/security.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(process.argv[2]!=='--real-os')throw Error('EXPLICIT_REAL_OS_CHECK_REQUIRED');
const runtime=resolve(root,'.runtime/isolation-boundaries');mkdirSync(runtime,{recursive:true});
const data=mkdtempSync(resolve(runtime,'actual-')),sandbox=new WslSandbox(root),checks=[];
let canary,owner,lastResult,canaryIdentity,ownerClosed,canaryClosed,ownerEnded=false,canaryEnded=false;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function linux(code,args=[]){const r=await capture('wsl.exe',['-d',WSL_ENVIRONMENT,'--exec','python3','-c',code,...args],{cwd:root,timeoutMs:10000});if(r.code!==0)throw Error('READ_ONLY_WSL_INSPECTION_FAILED');return JSON.parse(r.stdout);}
async function run(name,code,opts={}){const workspace=resolve(data,name);mkdirSync(workspace);writeFileSync(resolve(workspace,'main.py'),code);const result=await sandbox.run(workspace,{runtime:'python',entry:'main.py',args:[],stdin:''},{wallSeconds:5,...opts});lastResult=result;return result;}
function pass(name,result){checks.push({name,result:'PASS',evidence:result});}
try{
    const canaryCode="import os,sys,json,select,time,pathlib;print(json.dumps({'pid':os.getpid(),'start':pathlib.Path('/proc/self/stat').read_text().split()[21]}),flush=True);until=time.monotonic()+180\nwhile time.monotonic()<until:\n r,_,_=select.select([sys.stdin.fileno()],[],[],.1)\n if r and not os.read(sys.stdin.fileno(),1):break";
    canary=spawn('wsl.exe',['-d',WSL_ENVIRONMENT,'--exec','python3','-c',canaryCode],{cwd:root,env:childEnv(),stdio:['pipe','pipe','pipe'],windowsHide:true});
    canaryClosed=new Promise(res=>canary.once('close',()=>{canaryEnded=true;res();}));
    canaryIdentity=await new Promise((res,rej)=>{let data='';canary.stdout.on('data',b=>{data+=b.toString();if(data.includes('\n')){try{res(JSON.parse(data.split('\n')[0]));}catch(e){rej(e);}}});canary.once('error',rej);});
    const boundary=await run('boundaries',`import os,socket,pathlib,json,subprocess
assert os.getuid()==34271
assert set(os.environ).issubset({'PATH','HOME','LC_CTYPE','PWD'}),sorted(os.environ)
assert os.environ['PWD']=='/workspace'
for p in ['/mnt','/init','/sys','/run','/root','/opt','/var/run/docker.sock']:
 assert not pathlib.Path(p).exists(),p
try:
 pathlib.Path('/source/main.py').write_text('changed');raise AssertionError('source writable')
except OSError:pass
pathlib.Path('/workspace/own.txt').write_text('own output')
denied=[]
for family,target in [(socket.AF_INET,('1.1.1.1',443)),(socket.AF_INET6,('2606:4700:4700::1111',443))]:
 s=socket.socket(family);s.settimeout(.2)
 try:s.connect(target);raise AssertionError('public network reached')
 except OSError as e:denied.append({'target':str(target),'errno':e.errno})
try:
 socket.getaddrinfo('api.openai.com',443);raise AssertionError('public DNS resolved')
except OSError as e:denied.append({'target':'api.openai.com','errno':e.errno})
for family in [socket.AF_VSOCK,socket.AF_NETLINK,socket.AF_PACKET]:
 try:socket.socket(family,socket.SOCK_STREAM);raise AssertionError('management socket available')
 except OSError:pass
status=pathlib.Path('/proc/self/status').read_text()
assert 'CapEff:\t0000000000000000' in status and 'Seccomp:\t2' in status and 'NoNewPrivs:\t1' in status
assert subprocess.run(['unshare','--user','true'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
print(json.dumps({'uid':os.getuid(),'denied':denied,'status':status,'mounts':pathlib.Path('/proc/mounts').read_text()}))
`);
    assert.equal(boundary.exitCode,0);assert.equal(boundary.status,'EXECUTED');pass('filesystem/credentials/IPv4/IPv6/DNS/management capabilities denied',boundary);
    const memory=await run('memory',"x=bytearray(900*1024*1024);print('UNEXPECTED')\n");assert.equal(memory.status,'MEMORY_LIMIT');assert.doesNotMatch(memory.stdout,/UNEXPECTED/);pass('actual512MB cgroup memory boundary',memory);
    const pids=await run('pids',`import subprocess
children=[]
try:
 for _ in range(90):children.append(subprocess.Popen(['sleep','30']))
except OSError:print('PID_LIMIT_ENFORCED')
finally:
 for p in children:p.terminate()
 for p in children:p.wait()
`);assert.match(pids.stdout,/PID_LIMIT_ENFORCED/);assert.match(pids.resourceEvents['pids.events'],/max [1-9]/);pass('actual64 PID boundary',pids);
    const timeout=await run('timeout',"import subprocess,time\nsubprocess.Popen(['sh','-c','sleep 60 & wait']);time.sleep(60)\n",{wallSeconds:1});assert.equal(timeout.status,'TIMED_OUT');pass('wall deadline kills detached descendants',timeout);
    const cancelled=new AbortController();const cancelPromise=run('cancel',"import time\ntime.sleep(60)\n",{signal:cancelled.signal,wallSeconds:60});setTimeout(()=>cancelled.abort(),1500);const cancel=await cancelPromise;assert.equal(cancel.status,'CANCELLED');pass('controller cancel obtains real cleanup receipt',cancel);
    const workspace=resolve(data,'parent-death');mkdirSync(workspace);writeFileSync(resolve(workspace,'sleep.py'),"import subprocess,time\nsubprocess.Popen(['sh','-c','sleep 60 & wait']);time.sleep(60)\n");
    const jobId=id('wsl_job_death');
    owner=spawn(process.execPath,[resolve(root,'tests/fixtures/wsl-owner.mjs'),workspace,jobId,resolve(data,'normal-only.json')],{cwd:root,env:childEnv(),stdio:['ignore','pipe','pipe'],windowsHide:true});
    ownerClosed=new Promise(res=>owner.once('close',()=>{ownerEnded=true;res();}));
    const probe="import pathlib,json,sys,re; j=sys.argv[1]; assert re.fullmatch('wsl_job_[a-z0-9_-]{1,80}',j);p=pathlib.Path('/sys/fs/cgroup')/j/'cgroup.procs';print(json.dumps({'active':p.exists() and bool(p.read_text().strip())}))";
    let started=false;for(let i=0;i<25;i++){if((await linux(probe,[jobId])).active){started=true;break;}await wait(100);}
    assert.ok(started,'must observe a live owned Linux group before killing controller');
    owner.kill();await ownerClosed;
    const recover="import pathlib,json,sys,re; j=sys.argv[1];assert re.fullmatch('wsl_job_[a-z0-9_-]{1,80}',j);p=pathlib.Path('/opt/dream-maker-acceptance-20261011')/j/'result.json';print(p.read_text() if p.exists() else '{}')";
    let recovered;for(let i=0;i<25;i++){recovered=await linux(recover,[jobId]);if(recovered.cleanup)break;await wait(100);}
    assert.equal(recovered.status,'CANCELLED');assert.equal(recovered.cleanup.groupRemoved,true);assert.deepEqual(recovered.cleanup.remainingPids,[]);assert.equal(recovered.cleanup.delegationRestored,true);pass('actual controller death uses EOF cancellation and persists outside-namespace recovery evidence',recovered);
    assert.equal(canary.exitCode,null);
    const still=await linux("import pathlib,json,sys;p=pathlib.Path('/proc')/sys.argv[1]/'stat';print(json.dumps({'sameOwner':p.exists() and p.read_text().split()[21]==sys.argv[2]}))",[String(canaryIdentity.pid),canaryIdentity.start]);assert.equal(still.sameOwner,true);
    pass('unrelated canary remained alive throughout owned cleanup',{windowsConnectorPid:canary.pid,...canaryIdentity});
    const final=await linux("import pathlib,json; p=pathlib.Path('/sys/fs/cgroup');print(json.dumps({'groups':[x.name for x in p.iterdir() if x.is_dir()],'delegation':(p/'cgroup.subtree_control').read_text().split()}))");assert.deepEqual(final.groups,[]);assert.deepEqual(final.delegation,[]);pass('dedicated environment has no leaked groups and delegation is restored',final);
}catch(error){checks.push({name:'real OS boundary sequence',result:'FAIL',code:error.code??error.message,detail:error.message,lastResult});process.exitCode=1;}
finally{
    if(owner&&!ownerEnded){owner.kill();await ownerClosed;}
    if(canary&&!canaryEnded){canary.stdin.end();await canaryClosed;}
    const evidence=resolve(root,'docs/native-isolation/evidence');mkdirSync(evidence,{recursive:true});const output=resolve(evidence,'boundaries-'+Date.now()+'.json');
    writeFileSync(output,JSON.stringify({schema:'dream-maker.wsl-boundaries.v1',at:new Date().toISOString(),environment:WSL_ENVIRONMENT,evidenceClass:'REAL_OS_EXECUTION_NOT_LIVE_AGENT',modelCalls:0,checks},null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({checks:checks.map(({name,result,code,detail,lastResult})=>({name,result,code,detail,stderr:lastResult?.stderr})),evidence:output}));
}
