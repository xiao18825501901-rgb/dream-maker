"""Real native CLI canaries only. No auth, models, real credentials or host management."""
import datetime
import errno
import hashlib
import json
import os
import pathlib
import signal
import socket
import subprocess
import tempfile
import time
import sys
import tomllib

if sys.argv[1:] != ['--builtin'] and not (len(sys.argv)==3 and sys.argv[1]=='--narrow-scope'):
    raise RuntimeError('EXPLICIT_BOUNDARY_MODE_REQUIRED')

root=pathlib.Path('/opt/dream-maker-controller/codex-0.162.0')
binary=root/'launcher/package/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
if os.environ.get('WSL_DISTRO_NAME')!='DreamMaker-Acceptance-20261011' or hashlib.sha256(binary.read_bytes()).hexdigest()!='50ed828f357c655a3c82054d346cab8434f24901f14ec19b8267571bdd008b38':
    raise RuntimeError('ACTUAL_PINNED_CLI_REQUIRED')
parent=pathlib.Path('/opt/dream-maker-controller/qualification');parent.mkdir(mode=0o700,exist_ok=True)
data=pathlib.Path(tempfile.mkdtemp(prefix='dm-agent-boundary-',dir=parent));workspace=data/'workspace';control=data/'controller';home=data/'empty-codex-home'
for directory in [workspace,control,home]:directory.mkdir(mode=0o700)
profile=':read-only';policy_hash=None
if sys.argv[1]=='--narrow-scope':
    policy=sys.argv[2];parsed=tomllib.loads(policy);profile=parsed['default_permissions']
    if profile!='dream-maker-source-read':raise RuntimeError('EXPLICIT_NARROW_POLICY_REQUIRED')
    (home/'config.toml').write_text(policy);policy_hash=hashlib.sha256(policy.encode()).hexdigest()
(workspace/'own.txt').write_text('SYNTHETIC_OWN_SOURCE')
secret=control/'synthetic-secret.txt';secret.write_text('SYNTHETIC_NO_REAL_CREDENTIAL')
(workspace/'escape-link').symlink_to(secret)
script=workspace/'canary.py'
script.write_text('''import errno,json,pathlib,socket,sys,os
out={'ownRead':False,'workspaceWriteDenied':False,'controllerReadDenied':False,'tcpDenied':False,'unixControlDenied':False,'uid':os.getuid(),'errors':{}}
try:out['ownRead']=pathlib.Path('own.txt').read_text()=='SYNTHETIC_OWN_SOURCE'
except OSError as e:out['errors']['ownRead']=e.errno
try:pathlib.Path('unexpected-write.txt').write_text('SYNTHETIC')
except OSError as e:out['workspaceWriteDenied']=e.errno in [errno.EACCES,errno.EPERM,errno.EROFS];out['errors']['write']=e.errno
try:pathlib.Path(sys.argv[1]).read_bytes()
except OSError as e:out['controllerReadDenied']=e.errno in [errno.EACCES,errno.EPERM,errno.ENOENT];out['errors']['controller']=e.errno
out['symlinkEscapeDenied']=False;out['procEscapeDenied']=False
try:pathlib.Path('escape-link').read_bytes()
except OSError as e:out['symlinkEscapeDenied']=e.errno in [errno.EACCES,errno.EPERM,errno.ENOENT]
denials=[]
for pid in ['1',sys.argv[4]]:
 try:pathlib.Path('/proc/'+pid+'/root'+sys.argv[1]).read_bytes();denials.append(False)
 except OSError as e:denials.append(e.errno in [errno.EACCES,errno.EPERM,errno.ENOENT])
out['procEscapeDenied']=all(denials)
for key,family,address in [('tcpDenied',socket.AF_INET,('127.0.0.1',int(sys.argv[2]))),('unixControlDenied',socket.AF_UNIX,sys.argv[3])]:
 try:
  with socket.socket(family,socket.SOCK_STREAM) as client:client.settimeout(.5);client.connect(address)
 except OSError as e:out[key]=e.errno in [errno.EACCES,errno.EPERM];out['errors'][key]=e.errno
status=pathlib.Path('/proc/self/status').read_text()
out['capabilitiesDropped']='CapEff:\\t0000000000000000' in status
out['seccompActive']='Seccomp:\\t2' in status
out['noNewPrivileges']='NoNewPrivs:\\t1' in status
print(json.dumps(out))
''')
tcp=socket.socket();tcp.bind(('127.0.0.1',0));tcp.listen(2)
unix=socket.socket(socket.AF_UNIX);unix_path=control/'synthetic-control.sock';unix.bind(str(unix_path));unix.listen(2)
env={'PATH':'/usr/bin:/bin','HOME':str(data),'CODEX_HOME':str(home)}
proc=subprocess.Popen(['/usr/bin/node',str(root/'launcher/package/bin/codex.js'),'sandbox','-P',profile,'-C',str(workspace),'--',
                       '/usr/bin/python3',str(script),str(secret),str(tcp.getsockname()[1]),str(unix_path),str(os.getpid())],env=env,
                      stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
timed_out=False
try:
    try:stdout,stderr=proc.communicate(timeout=15)
    except subprocess.TimeoutExpired:
        timed_out=True;os.killpg(proc.pid,signal.SIGKILL);stdout,stderr=proc.communicate(timeout=5)
finally:
    if proc.poll() is None:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=5)
    try:os.killpg(proc.pid,signal.SIGKILL)
    except ProcessLookupError:pass
    tcp.close();unix.close()
observed=None
try:observed=json.loads(stdout)
except (ValueError,UnicodeError):pass
expected=['ownRead','workspaceWriteDenied','controllerReadDenied','symlinkEscapeDenied','procEscapeDenied','tcpDenied','unixControlDenied','capabilitiesDropped','seccompActive','noNewPrivileges']
passed=proc.returncode==0 and not timed_out and secret.is_file() and observed and all(observed.get(key) is True for key in expected)
report={'schema':'dream-maker.actual-linux-cli-boundaries.v1','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'distro':'DreamMaker-Acceptance-20261011','cliVersion':'0.162.0','profile':profile,'policySha256':policy_hash,
        'evidenceClass':'REAL_SYNTHETIC_OS_CANARIES_NOT_MODEL_ACCEPTANCE','ownedDirectory':str(data),
        'exitCode':proc.returncode,'timedOut':timed_out,'observed':observed,'result':'PASS' if passed else 'BOUNDARY_NOT_QUALIFIED',
        'diagnostic':stderr.decode('utf-8','replace')[:2000],'modelCalls':0,'realCredentialReads':False,
        'syntheticControllerFileStillPresent':secret.is_file(),
        'sourceSha256':hashlib.sha256(script.read_bytes()).hexdigest()}
output=data/'receipt.json';output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
if not passed:raise SystemExit(1)
