"""Fixed outer owner for the existing worker; stdout remains the worker's original protocol."""
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import sys
import time

BASE = Path('/opt/dream-maker-acceptance-20261011')
ROOT = Path('/sys/fs/cgroup')
RECEIPTS = BASE / 'resource-contexts'
ENVIRONMENT = 'DreamMaker-Acceptance-F-20261101-R2'
REQUIRED = {'memory', 'pids', 'cpu'}


def scope_id(job):
    if not isinstance(job, str) or not re.fullmatch(r'wsl_job_[a-z0-9_-]{1,80}', job):
        raise RuntimeError('RESOURCE_JOB_ID_DENIED')
    return 'dm_scope_' + job


def identity(pid):
    raw = Path('/proc', str(pid), 'stat').read_text()
    return {'pid': pid, 'startTicks': raw[raw.rindex(')')+2:].split()[19]}


def read_record(path, limit=2000000):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_size > limit:
            raise RuntimeError('RESOURCE_RECORD_INVALID')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(limit+1)
        if len(raw) > limit:
            raise RuntimeError('RESOURCE_RECORD_LIMIT')
        return json.loads(raw)
    finally:
        os.close(fd)


def write_new(path, value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    if len(raw) > 16384:
        raise RuntimeError('RESOURCE_RECEIPT_LIMIT')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        with os.fdopen(os.dup(fd), 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(fd)
    folder = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(folder)
    finally:
        os.close(folder)


def trusted_directories():
    for path in [Path('/opt'), BASE, RECEIPTS]:
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('RESOURCE_OWNER_DIRECTORY_INVALID')


def read_resource_job(job):
    name = scope_id(job)
    trusted_directories()
    final = read_record(RECEIPTS / (name+'.final.json'), 16384)
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    def absent(value):
        if boot != final['bootId']:
            return True
        try:
            return identity(value['pid']) != value
        except FileNotFoundError:
            return True
    observation = {'final': final, 'observed': {'scopeAbsent': not (ROOT/name).exists(),
                   'parentAbsent': absent(final['parent']), 'childAbsent': absent(final['child'])}}
    return {'result': read_record(BASE/job/'result.json'), 'observation': observation}


def exit_worker_child(code):
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except BaseException:
        code = 7
    finally:
        os._exit(code)


def wait_worker(child, read_fd, deadline, stopping):
    raw, reading = bytearray(), True
    while True:
        if reading:
            readable, _, _ = select.select([read_fd], [], [], .05)
            if readable:
                part = os.read(read_fd, 8193)
                raw.extend(part)
                reading = bool(part)
        else:
            time.sleep(.05)
        if len(raw) > 8192:
            raise RuntimeError('RESOURCE_STATUS_LIMIT')
        pid, status = os.waitpid(child, os.WNOHANG)
        if pid:
            if reading:
                while True:
                    part = os.read(read_fd, 8193)
                    if not part:
                        break
                    raw.extend(part)
                    if len(raw) > 8192:
                        raise RuntimeError('RESOURCE_STATUS_LIMIT')
            return status, bytes(raw)
        if stopping() or time.monotonic() > deadline:
            raise RuntimeError('RESOURCE_WORKER_DEADLINE')


def enter_view(parent, status_fd):
    before = {key: os.readlink('/proc/self/ns/'+key) for key in ['mnt', 'cgroup']}
    # Anchor at the entire owned scope. Anchoring at worker-view would put the
    # supervisor outside its cgroup namespace and the kernel correctly refuses
    # later migrations of forked children from supervisor into worker jobs.
    (parent/'cgroup.procs').write_text(str(os.getpid()))
    back = os.open(parent/'supervisor'/'cgroup.procs', os.O_WRONLY | os.O_CLOEXEC)
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.unshare(0x02000000 | 0x00020000) != 0:
            raise RuntimeError('RESOURCE_NAMESPACE_DENIED')
        os.write(back, str(os.getpid()).encode())
    finally:
        os.close(back)
    (parent/'cgroup.subtree_control').write_text('+cpu +memory +pids')
    if libc.mount(None, b'/', None, (1 << 18) | 16384, None) != 0:
        raise RuntimeError('RESOURCE_PRIVATE_PROPAGATION_DENIED')
    if libc.mount(str(parent/'worker-view').encode(), str(ROOT).encode(), None, 4096 | 16384, None) != 0:
        raise RuntimeError('RESOURCE_VIEW_MOUNT_DENIED')
    if any(p.is_dir() for p in ROOT.iterdir()) or (ROOT/'cgroup.procs').read_text().strip():
        raise RuntimeError('RESOURCE_VIEW_NOT_EMPTY')
    # Close every inherited control/lock FD before any generated subprocess can start.
    for name in os.listdir('/proc/self/fd'):
        fd = int(name)
        if fd > 2 and fd != status_fd:
            try:
                os.close(fd)
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise
    result = {'before': before, 'after': {k: os.readlink('/proc/self/ns/'+k) for k in before},
              'supervisorCgroup': Path('/proc/self/cgroup').read_text().strip(),
              'workerViewInitiallyEmpty': True, 'controlFdsClosed': True}
    if result['supervisorCgroup'] != '0::/supervisor' or any(result['before'][k] == result['after'][k] for k in before):
        raise RuntimeError('RESOURCE_NAMESPACE_IDENTITY_UNPROVEN')
    os.write(status_fd, json.dumps({'identity': identity(os.getpid()), 'isolation': result}).encode())
    os.close(status_fd)


def remove_empty(path):
    deadline = time.monotonic()+2
    while True:
        empty = not (path/'cgroup.procs').read_text().strip() and not (path/'cgroup.threads').read_text().strip() and 'populated 1' not in (path/'cgroup.events').read_text()
        if empty:
            try:
                path.rmdir()
                return
            except OSError as error:
                if error.errno != errno.EBUSY:
                    raise
        if time.monotonic() >= deadline:
            raise RuntimeError('RESOURCE_GROUP_REMOVE_UNPROVEN')
        time.sleep(.02)


def run_resource_context(payload, worker, helper_hash, transport_tail):
    job = payload.get('jobId')
    name = scope_id(job)
    if os.getuid() != 0 or os.environ.get('WSL_DISTRO_NAME') != ENVIRONMENT:
        raise RuntimeError('RESOURCE_DISTRO_DENIED')
    BASE.mkdir(exist_ok=True, mode=0o755)
    RECEIPTS.mkdir(exist_ok=True, mode=0o700)
    trusted_directories()
    mutex = (BASE/'resource-context.lock').open('a')
    fcntl.flock(mutex, fcntl.LOCK_EX | fcntl.LOCK_NB)
    parent = ROOT/name
    # Unknown siblings remain forbidden. The only allowed sibling is the fixed DM P1 service.
    directories = {p.name for p in ROOT.iterdir() if p.is_dir()}
    if directories - {'dream-maker-kimi-services'}:
        raise RuntimeError('RESOURCE_UNKNOWN_SIBLING')
    if directories:
        p1 = ROOT/'dream-maker-kimi-services'
        for key, value in [('memory.max', '1073741824'), ('memory.swap.max', '0'), ('pids.max', '64'), ('cpu.max', '100000 100000')]:
            if (p1/key).read_text().strip() != value:
                raise RuntimeError('RESOURCE_P1_PARENT_UNPROVEN')
    before = set((ROOT/'cgroup.subtree_control').read_text().split())
    if not REQUIRED.issubset(set((ROOT/'cgroup.controllers').read_text().split())):
        raise RuntimeError('RESOURCE_CONTROLLERS_UNAVAILABLE')
    binding = {key: payload[key] for key in ['jobId', 'sourceHash', 'workerHash']}
    binding.update({'resourceHelperHash': helper_hash, 'scopeId': name, 'scopePath': str(parent),
                    'environment': ENVIRONMENT, 'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                    'parent': identity(os.getpid()), 'rootBefore': sorted(before), 'rootSiblings': sorted(directories)})
    write_new(RECEIPTS/(name+'.intent.json'), {'schema': 'dream-maker.wsl-resource-intent.v1', **binding})
    added, created, child, read_fd, write_fd = sorted(REQUIRED-before), [], None, None, None
    stopped = False
    def stop(_sig, _frame):
        nonlocal stopped
        stopped = True
    for sig in [signal.SIGTERM, signal.SIGHUP, signal.SIGINT]:
        signal.signal(sig, stop)
    final = {'schema': 'dream-maker.wsl-resource-final.v1', **binding, 'workerExitCode': -1, 'child': None,
             'resultHash': None, 'isolation': None, 'cleanup': {'remainingPids': [], 'scopeRemoved': False, 'rootRestored': False}}
    exit_code, status, raw_status = 7, None, bytearray()
    try:
        if added:
            (ROOT/'cgroup.subtree_control').write_text(' '.join('+'+key for key in added))
        parent.mkdir()
        created.append(parent)
        for key, value in [('memory.max', '1073741824'), ('memory.swap.max', '0'), ('pids.max', '96'), ('cpu.max', '100000 100000')]:
            (parent/key).write_text(value)
            if (parent/key).read_text().strip() != value:
                raise RuntimeError('RESOURCE_PARENT_LIMIT_UNPROVEN')
        for key in ['supervisor', 'worker-view']:
            (parent/key).mkdir()
            created.append(parent/key)
        read_fd, write_fd = os.pipe2(os.O_CLOEXEC)
        child = os.fork()
        if child == 0:
            os.close(read_fd)
            child_code = 7
            try:
                enter_view(parent, write_fd)
                exec(compile(worker, '<controller-owned-wsl-worker>', 'exec'), {'payload': payload, 'transport_tail': transport_tail})
                child_code = 0
            except SystemExit as error:
                child_code = error.code if type(error.code) is int else 7
            except BaseException:
                os.write(1, b'{"schema":"dream-maker.wsl-supervisor-error.v1","code":"RESOURCE_WORKER_FAILED"}\n')
            finally:
                exit_worker_child(child_code)
        os.close(write_fd)
        write_fd = None
        os.set_blocking(read_fd, False)
        deadline = time.monotonic()+payload['wallSeconds']+25
        status, raw_status = wait_worker(child, read_fd, deadline, lambda: stopped)
        final['workerExitCode'] = os.waitstatus_to_exitcode(status)
        child = None
        ready = json.loads(raw_status)
        final.update({'child': ready['identity'], 'isolation': ready['isolation']})
        result = read_record(BASE/job/'result.json')
        final['resultHash'] = hashlib.sha256(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        if final['workerExitCode'] == 0:
            exit_code = 0
    finally:
        for fd in [read_fd, write_fd]:
            if fd is not None:
                os.close(fd)
        try:
            if parent in created:
                (parent/'cgroup.kill').write_text('1')
            if child is not None:
                deadline = time.monotonic()+5
                while time.monotonic() < deadline:
                    pid, _ = os.waitpid(child, os.WNOHANG)
                    if pid:
                        child = None
                        break
                    time.sleep(.02)
                if child is not None:
                    raise RuntimeError('RESOURCE_CHILD_REAP_UNPROVEN')
            # Only exact paths created by this owner or the original worker may be removed.
            paths = ([parent/'worker-view'/job] if (parent/'worker-view'/job).exists() else [])+list(reversed(created))
            for path in paths:
                remove_empty(path)
            final['cleanup']['scopeRemoved'] = not parent.exists()
            current = set((ROOT/'cgroup.subtree_control').read_text().split())
            siblings = {p.name for p in ROOT.iterdir() if p.is_dir()}
            if current != before | set(added) or siblings != directories:
                raise RuntimeError('RESOURCE_ROOT_CHANGED')
            if added:
                (ROOT/'cgroup.subtree_control').write_text(' '.join('-'+key for key in added))
            final['cleanup']['rootRestored'] = set((ROOT/'cgroup.subtree_control').read_text().split()) == before
        except Exception as error:
            final['cleanup']['failureCode'] = 'RESOURCE_CLEANUP_UNPROVEN'
            final['cleanup']['errno'] = error.errno if isinstance(error, OSError) and type(error.errno) is int and 0 <= error.errno <= 4095 else None
            exit_code = 7
        write_new(RECEIPTS/(name+'.final.json'), final)
        mutex.close()
    if exit_code:
        raise SystemExit(7)
