"""Owned unauthenticated app-server initialization only; no thread/turn/model call."""
import datetime
import hashlib
import json
import os
import pathlib
import select
import signal
import subprocess
import time

root=pathlib.Path('/opt/dream-maker-controller/codex-0.162.0')
receipt=json.loads((root/'install-receipt.json').read_text())
binary=pathlib.Path(receipt['binary'])
if receipt['status']!='INSTALLED_VERSION_VERIFIED' or hashlib.sha256(binary.read_bytes()).hexdigest()!=receipt['binarySha256']:
    raise RuntimeError('QUALIFY_INSTALL_BINDING_CHANGED')
home=pathlib.Path(receipt['home'])
if (home/'auth.json').exists():raise RuntimeError('QUALIFY_EMPTY_HOME_REQUIRED')
env={'PATH':'/usr/bin:/bin','HOME':str(root),'CODEX_HOME':str(home)}
proc=subprocess.Popen(['/usr/bin/node',receipt['entry'],'app-server','--stdio'],
                      stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                      env=env,start_new_session=True)
out={'schema':'dream-maker.wsl-codex-startup.v1','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
     'evidenceClass':'ACTUAL_CLI_RPC_NO_MODEL_NOT_NATIVE_AUDIT','version':receipt['actualVersion'],
     'pid':proc.pid,'home':str(home),'authenticationImported':False,'modelTurnsRequested':0}
buffer=b''
def request(number,method,params):
    global buffer
    proc.stdin.write((json.dumps({'id':number,'method':method,'params':params})+'\n').encode());proc.stdin.flush()
    deadline=time.monotonic()+12
    while time.monotonic()<deadline:
        while b'\n' in buffer:
            line,buffer=buffer.split(b'\n',1)
            data=json.loads(line)
            if data.get('id')==number:
                if 'error' in data:raise RuntimeError('QUALIFY_RPC_REJECTED')
                return data['result']
        ready,_,_=select.select([proc.stdout],[],[],.2)
        if ready:
            value=os.read(proc.stdout.fileno(),65536)
            if not value:raise RuntimeError('QUALIFY_RPC_EOF')
            buffer+=value
            if len(buffer)>1048576:raise RuntimeError('QUALIFY_RPC_OUTPUT_LIMIT')
    raise RuntimeError('QUALIFY_RPC_TIMEOUT')
try:
    result=request(1,'initialize',{'clientInfo':{'name':'dream-maker-wsl-qualification','version':'0.1.0'},'capabilities':{'experimentalApi':True}})
    out['initializeAcknowledged']=isinstance(result,dict)
    proc.stdin.write(b'{"method":"initialized"}\n');proc.stdin.flush()
    profiles=request(2,'permissionProfile/list',{'cwd':str(root),'limit':20})
    out['profileIds']=[item.get('id') for item in profiles.get('data',[]) if isinstance(item,dict)]
    account=request(3,'account/read',{'refreshToken':False})
    out['accountPresent']=account.get('account') is not None
    if out['accountPresent']:raise RuntimeError('QUALIFY_UNEXPECTED_ACCOUNT')
    out['status']='INITIALIZED_UNAUTHENTICATED_NO_MODEL'
except Exception as error:
    out['status']='FAILED';out['code']=str(error) if isinstance(error,RuntimeError) else 'QUALIFY_OPERATION_FAILED'
finally:
    proc.stdin.close()
    try:proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid,signal.SIGTERM)
        try:proc.wait(timeout=3)
        except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=3)
    try:os.killpg(proc.pid,signal.SIGKILL)
    except ProcessLookupError:pass
    remaining=[]
    for path in pathlib.Path('/proc').iterdir():
        if not path.name.isdigit():continue
        try:
            if os.getpgid(int(path.name))==proc.pid:remaining.append(int(path.name))
        except ProcessLookupError:pass
    out['exitCode']=proc.returncode;out['remainingOwnedGroupPids']=remaining
    out['homeStillUnauthenticated']=not (home/'auth.json').exists()
    if remaining or not out['homeStillUnauthenticated']:out['status']='FAILED_CLEANUP_OR_AUTH_UNPROVEN'
    report=root/('startup-'+str(int(time.time()*1000))+'.json')
    report.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
    proc.stdout.close();proc.stderr.close()
if out['status']!='INITIALIZED_UNAUTHENTICATED_NO_MODEL':raise SystemExit(1)
