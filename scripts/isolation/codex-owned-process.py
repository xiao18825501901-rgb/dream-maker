"""Trusted controller process-group marker. Not an OS sandbox, model probe or permission grant.
exec writes a private marker before execve; status only reads it and /proc. Nothing is killed.
The caller must pin the marker bytes before using a later status as recovery evidence.
"""
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

ROOT = '/opt/dream-maker-controller/'
SCHEMA = 'dream-maker.owned-codex.v1'
PROXY_KEYS = ('HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy')
PROXY_PATTERN = re.compile(r'^http://([^/:]+):([1-9][0-9]{0,4})/$')

def safe_path(value):
    if not isinstance(value,str) or not value.startswith(ROOT) or len(value)>700 or not re.fullmatch(r'[A-Za-z0-9_/@.+-]+',value):
        raise ValueError('CONTROLLER_PATH_REQUIRED')
    if any(part in ('','.','..') for part in value[1:].split('/')):
        raise ValueError('CONTROLLER_PATH_REQUIRED')
    return value

def marker_name(value):
    if not isinstance(value,str) or not re.fullmatch(r'owned_codex_[a-f0-9]{20}',value):
        raise ValueError('PROCESS_MARKER_ID_REQUIRED')
    return value+'.json'

def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':')).encode('utf-8')

def boot_id():
    return pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()

def process_stat(pid):
    text=pathlib.Path('/proc',str(pid),'stat').read_text()
    values=text[text.rfind(')')+2:].split()
    return {'groupId':int(values[2]),'sessionId':int(values[3]),'startTicks':values[19]}

def cleanup_proven(marker,*,expected_hash,actual_hash,boot_id,members,pid_namespace=None):
    if not expected_hash or not re.fullmatch(r'[a-f0-9]{64}',expected_hash) or expected_hash!=actual_hash:
        return {'proven':False,'reason':'MARKER_NOT_PREVIOUSLY_PINNED_OR_CHANGED'}
    if marker.get('schema')!=SCHEMA or any(type(marker.get(key)) is not int or marker[key]<1 for key in ('pid','groupId','sessionId')) or marker['pid']!=marker['groupId'] or marker['pid']!=marker['sessionId'] or not str(marker.get('startTicks','')).isdigit() or not marker.get('bootId'):
        return {'proven':False,'reason':'PROCESS_MARKER_INVALID'}
    marker_name(marker.get('markerId'))
    if boot_id!=marker['bootId']:
        return {'proven':True,'reason':'PREVIOUS_KERNEL_ENDED'}
    if not marker.get('pidNamespace') or pid_namespace!=marker['pidNamespace']:
        return {'proven':False,'reason':'PROCESS_NAMESPACE_UNVERIFIED_OR_CHANGED'}
    if members:
        return {'proven':False,'reason':'SCOPED_PROCESS_GROUP_STILL_ACTIVE'}
    return {'proven':True,'reason':'SCOPED_PROCESS_GROUP_EMPTY'}

def private_directory(value,create=False):
    value=safe_path(value)
    if create: os.makedirs(value,mode=0o700,exist_ok=True)
    if os.path.realpath(value)!=value or not stat.S_ISDIR(os.lstat(value).st_mode):
        raise ValueError('PRIVATE_CONTROLLER_DIRECTORY_REQUIRED')
    return value

def _private_ipv4(value):
    parts=value.split('.')
    if len(parts)!=4 or any(not re.fullmatch(r'[0-9]{1,3}',part) for part in parts):
        return False
    numbers=[int(part) for part in parts]
    if any(number<0 or number>255 for number in numbers):
        return False
    return numbers[0]==10 or (numbers[0]==172 and 16<=numbers[1]<=31) or (numbers[0]==192 and numbers[1]==168)

def proxy_environment(source=None):
    """Copy only the controller-supplied WSL gateway proxy tuple.

    The helper is launched under `env -i`; without this explicit copy the
    Linux Codex process silently loses the outbound route.
    """
    source = os.environ if source is None else source
    raw = {key: source.get(key) for key in PROXY_KEYS if source.get(key) is not None}
    if not raw:
        return {}
    if len(raw) != len(PROXY_KEYS):
        raise ValueError('WSL_PROXY_ENVIRONMENT_INCOMPLETE')
    values = set(raw.values())
    if len(values) != 1:
        raise ValueError('WSL_PROXY_ENVIRONMENT_MISMATCH')
    value = next(iter(values))
    match=PROXY_PATTERN.fullmatch(value)
    if match is None or not _private_ipv4(match.group(1)):
        raise ValueError('WSL_PROXY_ENVIRONMENT_INVALID')
    port = int(match.group(2))
    if not 1 <= port <= 65535:
        raise ValueError('WSL_PROXY_ENVIRONMENT_INVALID')
    bypass = source.get('NO_PROXY')
    if bypass != 'localhost,127.0.0.1,::1,[::1]' or source.get('no_proxy') != bypass:
        raise ValueError('WSL_PROXY_BYPASS_INVALID')
    return raw | {'NO_PROXY': bypass, 'no_proxy': bypass}

def launch(marker_root,marker_id,binary,home,cwd,args):
    if not sys.platform.startswith('linux'): raise ValueError('LINUX_REQUIRED')
    marker_root=private_directory(marker_root,create=True)
    home=private_directory(home);cwd=private_directory(cwd);binary=safe_path(binary)
    if os.path.realpath(binary)!=binary or not stat.S_ISREG(os.lstat(binary).st_mode): raise ValueError('PINNED_REGULAR_CLI_REQUIRED')
    if args not in (['--version'],['app-server']): raise ValueError('BOUNDED_CLI_COMMAND_REQUIRED')
    name=marker_name(marker_id)
    if os.getsid(0)!=os.getpid(): os.setsid()
    current=process_stat(os.getpid())
    if current['groupId']!=os.getpid() or current['sessionId']!=os.getpid(): raise ValueError('OWNED_SESSION_REQUIRED')
    binary_hash=hashlib.sha256()
    with open(binary,'rb') as source:
        for chunk in iter(lambda:source.read(1048576),b''): binary_hash.update(chunk)
    marker={'schema':SCHEMA,'markerId':marker_id,'pid':os.getpid(),**current,'bootId':boot_id(),'pidNamespace':os.readlink('/proc/self/ns/pid'),
            'binarySha256':binary_hash.hexdigest(),
            'homeSha256':hashlib.sha256(home.encode()).hexdigest(),'cwdSha256':hashlib.sha256(cwd.encode()).hexdigest(),
            'scope':'DEDICATED_CONTROLLER_PROCESS_GROUP_NOT_OS_SANDBOX'}
    folder=os.open(marker_root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=folder)
        with os.fdopen(fd,'wb') as out: out.write(canonical(marker));out.flush();os.fsync(out.fileno())
        os.fsync(folder)
    finally: os.close(folder)
    os.chdir(cwd)
    # Process-scoped credentials home only. Never inherit unrelated model credentials or WSLENV.
    env={'PATH':'/usr/bin:/bin','HOME':home,'CODEX_HOME':home,'LANG':'C.UTF-8',**proxy_environment()}
    os.execve(binary,[binary,'-c','cli_auth_credentials_store="file"',*args],env)

def inspect(marker_root,marker_id,expected_hash=None):
    if not sys.platform.startswith('linux'): raise ValueError('LINUX_REQUIRED')
    marker_root=private_directory(marker_root);name=marker_name(marker_id)
    folder=os.open(marker_root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=folder)
        with os.fdopen(fd,'rb') as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode): raise ValueError('REGULAR_MARKER_REQUIRED')
            raw=source.read(4097)
    finally: os.close(folder)
    if len(raw)>4096: raise ValueError('MARKER_TOO_LARGE')
    marker=json.loads(raw)
    if marker.get('markerId')!=marker_id: raise ValueError('PROCESS_MARKER_SCOPE_CHANGED')
    digest=hashlib.sha256(raw).hexdigest();boot=boot_id();members=[]
    if boot==marker.get('bootId'):
        processes=list(pathlib.Path('/proc').glob('[0-9]*'))
        if len(processes)>8192: raise ValueError('PROCESS_CENSUS_LIMIT')
        for process in processes:
            try: value=process_stat(int(process.name))
            except (FileNotFoundError,ProcessLookupError): continue
            if value['groupId']==marker.get('groupId'): members.append(int(process.name))
    return {'schema':'dream-maker.owned-codex-status.v1','marker':marker,'markerSha256':digest,'currentBootId':boot,
            'members':sorted(members),'cleanup':cleanup_proven(marker,expected_hash=expected_hash,actual_hash=digest,boot_id=boot,members=members,pid_namespace=os.readlink('/proc/self/ns/pid')),
            'readOnly':True,'modelTurnsRequested':0}

def main(argv):
    if len(argv)<3: raise ValueError('OWNED_PROCESS_ACTION_REQUIRED')
    action,marker_root,marker_id,*rest=argv
    if action=='exec' and len(rest)>=4: launch(marker_root,marker_id,rest[0],rest[1],rest[2],rest[3:])
    elif action=='status' and len(rest)<=1: print(json.dumps(inspect(marker_root,marker_id,rest[0] if rest else None),separators=(',',':')))
    else: raise ValueError('OWNED_PROCESS_ACTION_DENIED')

if __name__=='__main__':
    try: main(sys.argv[1:])
    except Exception as error:
        code=str(error) if isinstance(error,ValueError) and re.fullmatch(r'[A-Z_]{1,100}',str(error)) else 'OWNED_PROCESS_OPERATION_UNVERIFIED'
        sys.stderr.write(code+'\n');sys.exit(75)
