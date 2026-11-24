"""Controller-owned WSL supervisor. Generated source is data, never supervisor code."""
import base64
import configparser
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import select
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time

ENVIRONMENT = 'DreamMaker-Acceptance-F-20261101-R2'
BASE = Path('/opt/dream-maker-acceptance-20261011')
LIMITS = {'memoryBytes': 536870912, 'pids': 64, 'cpuMax': '100000 100000',
          'wallSeconds': 30, 'fileBytes': 1048576, 'temporaryBytes': 33554432}


def validate_request(request):
    if request.get('schema') not in ['dream-maker.wsl-job.v1', 'dream-maker.wsl-job.v2']:
        raise RuntimeError('SANDBOX_REQUEST_SCHEMA_DENIED')
    job = request.get('jobId', '')
    if not re.fullmatch(r'wsl_job_[a-z0-9_-]{1,80}', job):
        raise RuntimeError('SANDBOX_JOB_ID_DENIED')
    if not all(re.fullmatch(r'[a-f0-9]{64}', request.get(k, '')) for k in ['sourceHash', 'workerHash']):
        raise RuntimeError('SANDBOX_HASH_BINDING_DENIED')
    wall = request.get('wallSeconds')
    if type(wall) is not int or not 1 <= wall <= 120:
        raise RuntimeError('SANDBOX_WALL_LIMIT_DENIED')
    command = request.get('command', {})
    entry = command.get('entry', '')
    if command.get('runtime') not in ['node', 'python'] or not re.fullmatch(r'[A-Za-z0-9_.\-/]{1,300}', entry):
        raise RuntimeError('SANDBOX_COMMAND_DENIED')
    if any(p in ['', '.', '..', '.git', 'node_modules'] or p.startswith('.env') for p in entry.split('/')):
        raise RuntimeError('SANDBOX_ENTRY_DENIED')
    args, stdin = command.get('args'), command.get('stdin')
    if not isinstance(args, list) or len(args) > 32 or any(not isinstance(a, str) or '\0' in a for a in args) or sum(len(a) for a in args) > 8192:
        raise RuntimeError('SANDBOX_ARGUMENTS_DENIED')
    if not isinstance(stdin, str) or len(stdin) > 65536:
        raise RuntimeError('SANDBOX_STDIN_DENIED')
    source = request.get('files')
    if not isinstance(source, list) or not source or len(source) > 2000:
        raise RuntimeError('SANDBOX_SOURCE_LIMIT_DENIED')
    names, total, catalog, decoded = set(), 0, [], []
    for item in source:
        name = item.get('path', '')
        if not re.fullmatch(r'[A-Za-z0-9_.\-/]{1,500}', name) or any(p in ['', '.', '..', '.git', 'node_modules'] or p.startswith('.env') for p in name.split('/')):
            raise RuntimeError('SANDBOX_FILE_PATH_DENIED')
        if name.lower() in names:
            raise RuntimeError('SANDBOX_SOURCE_COLLISION')
        names.add(name.lower())
        data = base64.b64decode(item.get('body', ''), validate=True)
        total += len(data)
        if len(data) != item.get('bytes') or len(data) > 2000000 or total > 20000000 or hashlib.sha256(data).hexdigest() != item.get('sha256'):
            raise RuntimeError('SANDBOX_SOURCE_BYTES_DENIED')
        catalog.append({k: item[k] for k in ['path', 'bytes', 'sha256']})
        decoded.append((name, data))
    digest = hashlib.sha256(json.dumps(catalog, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    if digest != request['sourceHash'] or entry not in [name for name, _ in decoded]:
        raise RuntimeError('SANDBOX_SOURCE_BINDING_DENIED')
    return decoded


def filter_fd():
    class Compare(ctypes.Structure):
        _fields_ = [('arg', ctypes.c_uint), ('op', ctypes.c_int), ('a', ctypes.c_uint64), ('b', ctypes.c_uint64)]
    lib = ctypes.CDLL('libseccomp.so.2')
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(0x7FFF0000)
    try:
        for name in ['mount', 'umount2', 'setns', 'unshare', 'ptrace', 'process_vm_readv',
                     'process_vm_writev', 'bpf', 'perf_event_open', 'keyctl', 'open_by_handle_at']:
            nr = lib.seccomp_syscall_resolve_name(name.encode())
            if nr >= 0 and lib.seccomp_rule_add(ctx, 0x00050001, nr, 0) != 0:
                raise RuntimeError('SECCOMP_RULE_FAILED')
        nr = lib.seccomp_syscall_resolve_name(b'socket')
        for domain in [40, 16, 17]:
            if lib.seccomp_rule_add(ctx, 0x00050001, nr, 1, Compare(0, 4, domain, 0)) != 0:
                raise RuntimeError('SECCOMP_SOCKET_RULE_FAILED')
        fd = os.memfd_create('dream-maker-seccomp', 0)
        if lib.seccomp_export_bpf(ctx, fd) != 0:
            os.close(fd)
            raise RuntimeError('SECCOMP_EXPORT_FAILED')
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    finally:
        lib.seccomp_release(ctx)


def remove_quiescent_group(group):
    # A reaped leader/empty cgroup.procs alone does not prove the kernel has
    # finished destroying all threads. EBUSY is retried only within this bound.
    deadline = time.monotonic()+2
    while True:
        empty = not (group/'cgroup.procs').read_text().strip() and not (group/'cgroup.threads').read_text().strip() and 'populated 1' not in (group/'cgroup.events').read_text()
        if empty:
            try:
                group.rmdir()
                return
            except OSError as error:
                if error.errno != errno.EBUSY:
                    raise
        if time.monotonic() >= deadline:
            raise RuntimeError('CGROUP_REMOVE_UNPROVEN')
        time.sleep(.02)


def execute(request):
    decoded = validate_request(request)
    config = configparser.ConfigParser()
    config.read('/etc/wsl.conf')
    if os.getuid() != 0 or os.environ.get('WSL_DISTRO_NAME') != ENVIRONMENT or any(
        config.get(section, key, fallback='') != 'false' for section, key in
        [('automount', 'enabled'), ('automount', 'mountFsTab'), ('interop', 'enabled'),
         ('interop', 'appendWindowsPath'), ('boot', 'systemd'), ('gpu', 'enabled')]):
        raise RuntimeError('DEDICATED_DISTRO_CONFIGURATION_UNPROVEN')
    BASE.mkdir(exist_ok=True, mode=0o755)
    lock = (BASE / 'controller.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise RuntimeError('DEDICATED_SANDBOX_BUSY')
    cgroot = Path('/sys/fs/cgroup')
    before = (cgroot / 'cgroup.subtree_control').read_text().split()
    if any(p.is_dir() for p in cgroot.iterdir()):
        lock.close()
        raise RuntimeError('CGROUP_ROOT_ALREADY_MANAGED')
    required = {'memory', 'pids', 'cpu'}
    if not required.issubset(set((cgroot / 'cgroup.controllers').read_text().split())):
        lock.close()
        raise RuntimeError('REQUIRED_CGROUP_CONTROLLERS_UNAVAILABLE')
    job = BASE / request['jobId']
    if job.exists() or job.is_symlink():
        lock.close()
        raise RuntimeError('OWN_JOB_PATH_ALREADY_EXISTS')
    job.mkdir(mode=0o755)
    # /source is the read-only proof tree: it is bound read-only and the controller re-hashes the
    # Windows directory after the run, so a case can never edit the workspace it was handed.
    source = job / 'source'
    source.mkdir(mode=0o755)
    for name, data in decoded:
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        path.write_bytes(data)
        path.chmod(0o444)
    # /workspace is the CWD, and it must hold the same files. It used to be an empty tmpfs, which made
    # every relative data path resolve to nothing: a fixture at sample.json was invisible to the program
    # (readdir('.') returned []) and the CLI answered ERROR NO_DATA for a file the verifier had just
    # staged. Writes stay harmless — the copy is world-writable, lives inside the job directory and dies
    # with the namespace, while /source keeps the read-only proof.
    run = job / 'run'
    run.mkdir(mode=0o777)
    for name, data in decoded:
        path = run / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    for path in [run, *run.rglob('*')]:
        path.chmod(0o777 if path.is_dir() else 0o666)
    group = cgroot / request['jobId']
    lost, finished = threading.Event(), threading.Event()
    for sig in [signal.SIGHUP, signal.SIGINT, signal.SIGTERM]:
        signal.signal(sig, lambda _sig, _frame: lost.set())
    # EOF on the exclusively owned transport also covers a dead Windows controller.
    def watch_parent():
        while not finished.is_set():
            readable, _, _ = select.select([sys.stdin.fileno()], [], [], .1)
            if readable and not os.read(sys.stdin.fileno(), 1):
                lost.set()
                break
    report = {'schema': 'dream-maker.wsl-result.v1', **{k: request[k] for k in ['jobId', 'sourceHash', 'workerHash']},
              'environment': ENVIRONMENT, 'status': 'EXECUTED', 'exitCode': -1, 'stdout': '', 'stderr': '',
              'limits': {**LIMITS, 'wallSeconds': request['wallSeconds']}, 'resourceEvents': {}, 'cleanup': {}}
    fd, child, watcher = None, None, None
    try:
        added = sorted(required - set(before))
        if added:
            (cgroot / 'cgroup.subtree_control').write_text(' '.join('+' + c for c in added))
        group.mkdir()
        for name, value in [('memory.max', '536870912'), ('memory.swap.max', '0'), ('pids.max', '64'),
                            ('cpu.max', '100000 100000'), ('memory.oom.group', '1')]:
            (group / name).write_text(value)
            if (group / name).read_text().strip() != value:
                raise RuntimeError('CGROUP_LIMIT_READBACK_FAILED')
        fd = filter_fd()
        args = ['bwrap', '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session',
                '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
                '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
                '--tmpfs', '/usr/lib/modules', '--tmpfs', '/lib/modules', '--proc', '/proc', '--dev', '/dev',
                '--ro-bind', str(source), '/source', '--bind', str(run), '/workspace',
                '--size', '33554432', '--tmpfs', '/tmp', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
                '--setenv', 'HOME', '/tmp', '--chdir', '/workspace', '--seccomp', str(fd)]
        c = request['command']
        launcher="import runpy,sys,os; p=sys.argv[1]; sys.path[:0]=[os.path.dirname(p),'/workspace']; sys.argv=sys.argv[1:]; runpy.run_path(p,run_name='__main__')"
        args += (['/usr/bin/node'] if c['runtime'] == 'node' else ['/usr/bin/python3', '-I', '-c', launcher])
        args += ['/workspace/' + c['entry'], *c['args']]
        report['command'] = args
        def enter():
            (group / 'cgroup.procs').write_text(str(os.getpid()))
            resource.setrlimit(resource.RLIMIT_FSIZE, (1048576, 1048576))
            resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            os.setgroups([])
            os.setgid(34271)
            os.setuid(34271)
        with tempfile.TemporaryFile(dir=job) as stdin, tempfile.TemporaryFile(dir=job) as stdout, tempfile.TemporaryFile(dir=job) as stderr:
            stdin.write(c['stdin'].encode('utf-8'))
            stdin.seek(0)
            child = subprocess.Popen(args, preexec_fn=enter, pass_fds=(fd,), stdin=stdin,
                                     stdout=stdout, stderr=stderr, env={'PATH': '/usr/bin:/bin'})
            watcher=threading.Thread(target=watch_parent, daemon=True)
            watcher.start()
            deadline = time.monotonic() + request['wallSeconds']
            while child.poll() is None:
                if lost.is_set() or time.monotonic() >= deadline:
                    report['status'] = 'CANCELLED' if lost.is_set() else 'TIMED_OUT'
                    (group / 'cgroup.kill').write_text('1')
                    break
                time.sleep(.02)
            child.wait(timeout=5)
            report['exitCode'] = child.returncode
            stdout.seek(0)
            stderr.seek(0)
            out, err = stdout.read(1048577), stderr.read(1048577)
            report['stdout'], report['stderr'] = out.decode('utf-8', errors='replace'), err.decode('utf-8', errors='replace')
            if len(out) >= 1048576 or len(err) >= 1048576:
                report['status'] = 'OUTPUT_LIMIT'
        report['resourceEvents'] = {name: (group / name).read_text() for name in ['memory.events', 'pids.events']}
        if re.search(r'^oom_kill [1-9]', report['resourceEvents']['memory.events'], re.M):
            report['status'] = 'MEMORY_LIMIT'
    finally:
        if group.exists():
            (group / 'cgroup.kill').write_text('1')
            if child:
                child.wait(timeout=5)
            for _ in range(100):
                if not (group / 'cgroup.procs').read_text().strip():
                    break
                time.sleep(.02)
            report['cleanup']['remainingPids'] = (group / 'cgroup.procs').read_text().split()
            remove_quiescent_group(group)
        if fd is not None:
            os.close(fd)
        report['cleanup']['groupRemoved'] = not group.exists()
        current = (cgroot / 'cgroup.subtree_control').read_text().split()
        if current != before and not any(p.is_dir() for p in cgroot.iterdir()):
            (cgroot / 'cgroup.subtree_control').write_text(' '.join('-' + c for c in current if c not in before))
        report['cleanup']['delegationRestored'] = (cgroot / 'cgroup.subtree_control').read_text().split() == before
        report['cleanup']['sourceUnchanged'] = all(hashlib.sha256((source / item['path']).read_bytes()).hexdigest() == item['sha256'] for item in request['files'])
        # Recovery evidence is outside the untrusted namespace, including after lost transport.
        record = job / 'result.json'
        record.write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')
        finished.set()
        if watcher:
            watcher.join(timeout=1)
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()
    print(json.dumps(report, ensure_ascii=False))


def copy_sparse_to_container(source_fd, target_fd, start, limit, dense=False):
    """Preserve holes as extent recipes, never expand an untrusted sparse length on disk."""
    info = os.fstat(source_fd)
    if not stat.S_ISREG(info.st_mode) or not 0 <= info.st_size <= 67108864:
        raise RuntimeError('SQLITE_RETENTION_FILE_DENIED')
    digest, extents, cursor, position = hashlib.sha256(), [], start, 0
    digest.update(('size:' + str(info.st_size) + '\n').encode())
    while position < info.st_size:
        try:
            first = position if dense else os.lseek(source_fd, position, os.SEEK_DATA)
        except OSError as error:
            if error.errno == errno.ENXIO:
                break
            raise RuntimeError('SQLITE_SPARSE_LAYOUT_UNPROVEN') from error
        last = info.st_size if dense else min(info.st_size, os.lseek(source_fd, first, os.SEEK_HOLE))
        if not position <= first < last <= info.st_size or cursor + last - first > limit:
            raise RuntimeError('SQLITE_RETENTION_BYTES_LIMIT')
        extents.append([first, last-first, cursor])
        digest.update((str(first) + ':' + str(last-first) + '\n').encode())
        for offset in range(first, last, 65536):
            body = os.pread(source_fd, min(65536, last-offset), offset)
            if len(body) != min(65536, last-offset):
                raise RuntimeError('SQLITE_RETENTION_SOURCE_CHANGED')
            digest.update(body)
            view = memoryview(body)
            while view:
                count = os.pwrite(target_fd, view, cursor)
                if count < 1:
                    raise RuntimeError('SQLITE_RETENTION_WRITE_FAILED')
                cursor += count
                view = view[count:]
        position = last
    return {'bytes': info.st_size, 'extentHash': digest.hexdigest(), 'extents': extents}, cursor


def send_bounded_output(fd, body, cancelled, deadline):
    os.set_blocking(fd, False)
    remaining = memoryview(body)
    while remaining:
        if cancelled.is_set():
            raise RuntimeError('SQLITE_OUTPUT_CANCELLED')
        if time.monotonic() >= deadline:
            raise RuntimeError('SQLITE_OUTPUT_TIMEOUT')
        _, writable, _ = select.select([], [fd], [], min(.1, max(0, deadline-time.monotonic())))
        if not writable:
            continue
        try:
            count = os.write(fd, remaining[:65536])
        except BlockingIOError:
            continue
        if count < 1:
            raise RuntimeError('SQLITE_OUTPUT_CHANNEL_FAILED')
        remaining = remaining[count:]


def preallocate_private(path, capacity):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.posix_fallocate(fd, 0, capacity)
        if os.fstat(fd).st_blocks * 512 < capacity:
            raise RuntimeError('SQLITE_PHYSICAL_RESERVATION_UNPROVEN')
        os.fsync(fd)
    finally:
        os.close(fd)


def padded_json_record(path, value, capacity, pad=True):
    body = json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
    if len(body) > capacity:
        raise RuntimeError('SQLITE_RESULT_METADATA_LIMIT')
    fd = os.open(path, os.O_WRONLY | os.O_NOFOLLOW)
    digest = hashlib.sha256()
    try:
        offset = 0
        for source in [body, b' ' * (capacity-len(body)) if pad else b'']:
            digest.update(source)
            view = memoryview(source)
            while view:
                count = os.pwrite(fd, view[:65536], offset)
                if count < 1:
                    raise RuntimeError('SQLITE_RETENTION_WRITE_FAILED')
                view = view[count:]
                offset += count
        if not pad:
            os.ftruncate(fd, len(body))
        os.fsync(fd)
    finally:
        os.close(fd)
    return digest.hexdigest()


def owned_allocated_bytes(job):
    total, stack = job.lstat().st_blocks * 512, [job]
    while stack:
        for path in stack.pop().iterdir():
            info = path.lstat()
            total += info.st_blocks * 512
            if stat.S_ISDIR(info.st_mode):
                stack.append(path)
    return total


def execute_sqlite(request):
    """The original owned WSL job, with a binary data channel and two quiesced stages.

    The root supervisor owns private quota mounts. Generated processes never see controller
    records, the input transport, credentials, cgroups, or a host management interface.
    """
    decoded = validate_request(request)
    source_dirs = {str(parent) for name, _body in decoded for parent in Path(name).parents if str(parent) != '.'}
    if len(source_dirs) > 4096:
        raise RuntimeError('SQLITE_SOURCE_DIRECTORY_LIMIT')
    exchange = request.get('sqlite', {})
    empty_hash = hashlib.sha256(b'').hexdigest()
    image_bytes, revision = exchange.get('imageBytes'), exchange.get('expectedRevision')
    if set(exchange) != {'schema', 'kind', 'inputHash', 'expectedRevision', 'imageBytes', 'imageHash', 'snapshotHelper', 'snapshotHelperHash'} or \
            exchange.get('schema') != 'dream-maker.sqlite-exchange.v1' or exchange.get('kind') != 'SQLITE_IMAGE_V1' or \
            type(image_bytes) is not int or not 0 <= image_bytes <= 67108864 or image_bytes % 512 or \
            type(revision) is not int or not 0 <= revision <= 9007199254740991 or \
            any(not isinstance(exchange.get(k), str) or not re.fullmatch(r'[a-f0-9]{64}', exchange[k]) for k in ['inputHash', 'imageHash', 'snapshotHelperHash']) or \
            image_bytes == 0 and (revision != 0 or exchange['imageHash'] != empty_hash):
        raise RuntimeError('SQLITE_INPUT_DESCRIPTOR_DENIED')
    helper = exchange['snapshotHelper']
    if not isinstance(helper, str) or len(helper.encode('utf-8')) > 65536 or hashlib.sha256(helper.encode('utf-8')).hexdigest() != exchange['snapshotHelperHash']:
        raise RuntimeError('SQLITE_SNAPSHOT_HELPER_BINDING_DENIED')
    config = configparser.ConfigParser()
    config.read('/etc/wsl.conf')
    if os.getuid() != 0 or os.environ.get('WSL_DISTRO_NAME') != ENVIRONMENT or any(
        config.get(s, k, fallback='') != 'false' for s, k in [('automount', 'enabled'), ('automount', 'mountFsTab'),
        ('interop', 'enabled'), ('interop', 'appendWindowsPath'), ('boot', 'systemd'), ('gpu', 'enabled')]):
        raise RuntimeError('DEDICATED_DISTRO_CONFIGURATION_UNPROVEN')
    BASE.mkdir(exist_ok=True, mode=0o755)
    lock = (BASE / 'controller.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise RuntimeError('DEDICATED_SANDBOX_BUSY')
    cgroot = Path('/sys/fs/cgroup')
    before = (cgroot / 'cgroup.subtree_control').read_text().split()
    required = {'memory', 'pids', 'cpu'}
    if any(p.is_dir() for p in cgroot.iterdir()) or not required.issubset(set((cgroot / 'cgroup.controllers').read_text().split())):
        lock.close()
        raise RuntimeError('CGROUP_ROOT_ALREADY_MANAGED')
    # Unknown/incomplete jobs consume a reservation too. Never delete them on a later run.
    if sum(1 for p in BASE.iterdir() if p.is_dir() and (p / 'sqlite-reserved.json').exists()) >= 4:
        lock.close()
        raise RuntimeError('SQLITE_UNRELEASED_JOB_LIMIT')
    reservation, container_size, manifest_size = 805306368, 536870912, 67108864
    disk = os.statvfs(BASE)
    padding = max(4096, disk.f_frsize) * (3*len(decoded)+3*len(source_dirs)+256)
    if container_size + manifest_size + 2000000 + 65536 + 20000000 + padding > reservation:
        lock.close()
        raise RuntimeError('SQLITE_RETENTION_FILESYSTEM_UNSUPPORTED')
    if disk.f_bavail * disk.f_frsize < reservation:
        lock.close()
        raise RuntimeError('SQLITE_RETENTION_SPACE_REQUIRED')
    job = BASE / request['jobId']
    if job.exists() or job.is_symlink():
        lock.close()
        raise RuntimeError('OWN_JOB_PATH_ALREADY_EXISTS')
    # bwrap drops to the generated uid before binding these known paths. Permit traversal,
    # while private input/retention records stay root-only and are never namespace mounts.
    job.mkdir(mode=0o711)
    identity = {k: request[k] for k in ['jobId', 'sourceHash', 'workerHash']}
    (job / 'sqlite-reserved.json').write_text(json.dumps({**identity, 'reservedBytes': reservation}), encoding='utf-8')
    (job / 'sqlite-reserved.json').chmod(0o600)
    source, run, data = job / 'source', job / 'run', job / 'data'
    source.mkdir(mode=0o755)
    run.mkdir()
    data.mkdir()
    for name, body in decoded:
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        path.chmod(0o444)
    helper_path = job / 'sqlite-snapshot.py'
    helper_path.write_text(helper, encoding='utf-8')
    helper_path.chmod(0o444)
    group = cgroot / request['jobId']
    lost, finished = threading.Event(), threading.Event()
    for sig in [signal.SIGHUP, signal.SIGINT, signal.SIGTERM]:
        signal.signal(sig, lambda _sig, _frame: lost.set())
    report = {'schema': 'dream-maker.wsl-result.v1', **identity, 'environment': ENVIRONMENT,
              'status': 'EXECUTED', 'exitCode': -1, 'stdout': '', 'stderr': '', 'cleanup': {},
              'limits': {**LIMITS, 'wallSeconds': request['wallSeconds'], 'fileBytes': 67108864}, 'resourceEvents': {}}
    detail = {'schema': 'dream-maker.sqlite-execution.v1', **{k: exchange[k] for k in
              ['kind', 'inputHash', 'expectedRevision', 'imageBytes', 'imageHash', 'snapshotHelperHash']},
              'snapshotStatus': 'NOT_RUN', 'snapshot': None, 'generatedPidsAfter': [], 'snapshotPidsAfter': [],
              'privateMountNamespace': False, 'runTmpfsBytes': 0, 'dataTmpfsBytes': 0,
              'mountsRemoved': False, 'inputReceived': False}
    report['sqlite'] = detail
    mounts, child, watcher, fd, snapshot_span = [], None, None, None, None
    deadline = time.monotonic() + request['wallSeconds']

    def bounded_command(args):
        subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       env={'PATH': '/usr/bin:/bin'}, timeout=5, check=True)

    def quiesce():
        if group.exists():
            (group / 'cgroup.kill').write_text('1')
            if child is not None:
                child.wait(timeout=5)
            for _ in range(250):
                if not (group / 'cgroup.procs').read_text().strip():
                    return []
                time.sleep(.02)
            raise RuntimeError('SQLITE_STAGE_CLEANUP_UNPROVEN')
        return []

    def watch_parent():
        while not finished.is_set():
            ready, _, _ = select.select([0], [], [], .1)
            if ready:
                # After exactly the declared input, any extra byte is a protocol violation.
                if os.read(0, 1):
                    detail['inputProtocolError'] = True
                lost.set()
                return

    def read_input():
        pending = globals().get('transport_tail', b'')
        digest, count = hashlib.sha256(), 0
        with (job / 'retained.bin').open('r+b', buffering=0) as original:
            with (data / 'project.sqlite').open('xb') as target:
                while count < image_bytes:
                    if lost.is_set() or time.monotonic() >= deadline:
                        raise RuntimeError('SQLITE_INPUT_TIMEOUT_OR_CANCELLED')
                    if pending:
                        body, pending = pending[:min(65536, image_bytes-count)], pending[min(65536, image_bytes-count):]
                    else:
                        ready, _, _ = select.select([0], [], [], .1)
                        if not ready:
                            continue
                        body = os.read(0, min(65536, image_bytes-count))
                    if not body:
                        raise RuntimeError('SQLITE_INPUT_TRUNCATED')
                    view = memoryview(body)
                    while view:
                        count_written = original.write(view)
                        if count_written < 1:
                            raise RuntimeError('SQLITE_RETENTION_WRITE_FAILED')
                        view = view[count_written:]
                    target.write(body)
                    count += len(body)
                    detail['inputActualBytes'] = count
                    digest.update(body)
                if pending or digest.hexdigest() != exchange['imageHash']:
                    raise RuntimeError('SQLITE_INPUT_BYTES_DENIED')
            original.flush()
            os.fsync(original.fileno())
        if image_bytes == 0:
            (data / 'project.sqlite').unlink()
        else:
            (data / 'project.sqlite').chmod(0o666)
        detail['inputReceived'] = True

    def phase(snapshot=False):
        nonlocal child
        # bwrap consumes the shared BPF descriptor. Each fresh namespace reads it from zero.
        os.lseek(fd, 0, os.SEEK_SET)
        args = ['bwrap', '--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session',
                '--cap-drop', 'ALL', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
                '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
                '--tmpfs', '/usr/lib/modules', '--tmpfs', '/lib/modules', '--proc', '/proc', '--dev', '/dev',
                '--ro-bind', str(source), '/source', '--bind', str(run), '/workspace', '--bind', str(data), '/data',
                '--size', '33554432', '--tmpfs', '/tmp', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
                '--setenv', 'HOME', '/tmp', '--chdir', '/tmp' if snapshot else '/workspace', '--seccomp', str(fd)]
        c = request['command']
        if snapshot:
            args += ['--dir', '/controller', '--ro-bind', str(helper_path), '/controller/sqlite-snapshot.py',
                     '/usr/bin/python3', '-I', '/controller/sqlite-snapshot.py']
        else:
            launcher = "import runpy,sys,os; p=sys.argv[1]; sys.path[:0]=[os.path.dirname(p),'/workspace']; sys.argv=sys.argv[1:]; runpy.run_path(p,run_name='__main__')"
            args += (['/usr/bin/node'] if c['runtime'] == 'node' else ['/usr/bin/python3', '-I', '-c', launcher])
            args += ['/workspace/' + c['entry'], *c['args']]
            report['command'] = args

        def enter():
            (group / 'cgroup.procs').write_text(str(os.getpid()))
            resource.setrlimit(resource.RLIMIT_FSIZE, (67108864, 67108864))
            resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            os.setgroups([])
            os.setgid(34271)
            os.setuid(34271)

        with tempfile.TemporaryFile(dir=run) as stdin, tempfile.TemporaryFile(dir=run) as stdout, tempfile.TemporaryFile(dir=run) as stderr:
            stdin.write(b'' if snapshot else c['stdin'].encode('utf-8'))
            stdin.seek(0)
            child = subprocess.Popen(args, preexec_fn=enter, pass_fds=(fd,), stdin=stdin, stdout=stdout, stderr=stderr,
                                     env={'PATH': '/usr/bin:/bin'})
            while child.poll() is None:
                if lost.is_set() or time.monotonic() >= deadline:
                    report['status'] = 'CANCELLED' if lost.is_set() else 'TIMED_OUT'
                    break
                time.sleep(.02)
            # Even when the root exits normally, descendants must be dead before reading data.
            pids = quiesce()
            detail['snapshotPidsAfter' if snapshot else 'generatedPidsAfter'] = pids
            stdout.seek(0)
            stderr.seek(0)
            out, err = stdout.read(1048577), stderr.read(1048577)
            if len(out) >= 1048576 or len(err) >= 1048576:
                report['status'] = 'OUTPUT_LIMIT'
            return child.returncode, out, err

    def retain():
        nonlocal snapshot_span
        # The full backing extent was allocated BEFORE generated code ran. Sparse recipes
        # prevent logical holes/hardlinks from expanding into unbounded persistent writes.
        entries, logical, cursor, inodes = [], image_bytes, image_bytes, {}
        target = os.open(job / 'retained.bin', os.O_RDWR | os.O_NOFOLLOW)
        try:
            for scope in [data, run]:
                root_id = len(entries)
                entries.append({'id': root_id, 'root': scope.name, 'kind': 'directory'})
                stack = [(os.open(scope, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW), root_id)]
                try:
                    while stack:
                        directory_fd, parent = stack.pop()
                        try:
                            for name in os.listdir(directory_fd):
                                if len(entries) >= 10000:
                                    raise RuntimeError('SQLITE_RETENTION_INODE_LIMIT')
                                info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                                index = len(entries)
                                entry = {'id': index, 'parent': parent, 'nameBase64': base64.b64encode(os.fsencode(name)).decode(), 'mode': stat.S_IFMT(info.st_mode)}
                                entries.append(entry)
                                if stat.S_ISDIR(info.st_mode):
                                    stack.append((os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd), index))
                                elif stat.S_ISREG(info.st_mode):
                                    key = (info.st_dev, info.st_ino)
                                    logical += info.st_size
                                    if key in inodes:
                                        entry['hardlinkId'] = inodes[key]
                                        continue
                                    is_snapshot = scope == data and parent == root_id and name == '.dm-snapshot.sqlite' and detail['snapshotStatus'] == 'READY'
                                    source_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
                                    try:
                                        first = cursor
                                        recipe, cursor = copy_sparse_to_container(source_fd, target, cursor, container_size, dense=is_snapshot)
                                    finally:
                                        os.close(source_fd)
                                    entry.update(recipe)
                                    inodes[key] = index
                                    if is_snapshot:
                                        snapshot_span = (first, info.st_size)
                                elif stat.S_ISLNK(info.st_mode):
                                    entry['linkBase64'] = base64.b64encode(os.fsencode(os.readlink(name, dir_fd=directory_fd))).decode()
                        finally:
                            os.close(directory_fd)
                finally:
                    for directory_fd, _parent in stack:
                        os.close(directory_fd)
            os.fsync(target)
        finally:
            os.close(target)
        manifest = {'schema': 'dream-maker.sqlite-retained-extents.v1', 'input': {'offset': 0, 'bytes': image_bytes,
                    'complete': detail['inputReceived'], 'sha256': exchange['imageHash']}, 'entries': entries}
        digest = padded_json_record(job / 'retention.json', manifest, manifest_size, pad=False)
        detail['retention'] = {'schema': 'dream-maker.sqlite-retention.v1', 'state': 'RETAINED', 'bytes': 0,
                              'logicalBytes': logical, 'usedContainerBytes': cursor, 'containerBytes': container_size,
                              'manifestHash': digest, 'snapshotSpan': snapshot_span}

    try:
        preallocate_private(job / 'retained.bin', container_size)
        preallocate_private(job / 'retention.json', manifest_size)
        preallocate_private(job / 'result.json', 2000000)
        preallocate_private(job / 'snapshot-stage.json', 65536)
        preallocate_private(job / 'transport.json', 4096)
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.unshare(0x00020000) != 0:
            raise RuntimeError('SQLITE_PRIVATE_MOUNT_NAMESPACE_REQUIRED')
        bounded_command(['mount', '--make-rprivate', '/'])
        detail['privateMountNamespace'] = True
        for path, size, inodes, field in [(run, 33554432, 8192, 'runTmpfsBytes'), (data, 218103808, 1024, 'dataTmpfsBytes')]:
            bounded_command(['mount', '-t', 'tmpfs', '-o', f'size={size},nr_inodes={inodes},nosuid,nodev,noexec', 'dream-maker-sqlite', str(path)])
            mounts.append(path)
            fields = next((line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4] == str(path)), None)
            if fields is None or fields[fields.index('-')+1] != 'tmpfs' or os.statvfs(path).f_blocks * os.statvfs(path).f_frsize != size:
                raise RuntimeError('SQLITE_TMPFS_QUOTA_READBACK_FAILED')
            detail[field] = size
            path.chmod(0o777)
            # Establish sparse semantics before handing this filesystem to generated code.
            probe = path / '.dm-sparse-capability'
            probe_fd = os.open(probe, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.ftruncate(probe_fd, 1048576)
                os.pwrite(probe_fd, b'x', 1048575)
                if os.lseek(probe_fd, 0, os.SEEK_DATA) < 1044480:
                    raise RuntimeError('SQLITE_SPARSE_LAYOUT_UNPROVEN')
            finally:
                os.close(probe_fd)
                probe.unlink()
        for name, body in decoded:
            path = run / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        for path in [run, *run.rglob('*')]:
            path.chmod(0o777 if path.is_dir() else 0o666)
        read_input()
        watcher = threading.Thread(target=watch_parent, daemon=True)
        watcher.start()
        added = sorted(required-set(before))
        if added:
            (cgroot / 'cgroup.subtree_control').write_text(' '.join('+'+c for c in added))
        group.mkdir()
        for name, value in [('memory.max', '536870912'), ('memory.swap.max', '0'), ('pids.max', '64'), ('cpu.max', '100000 100000'), ('memory.oom.group', '1')]:
            (group / name).write_text(value)
            if (group / name).read_text().strip() != value:
                raise RuntimeError('CGROUP_LIMIT_READBACK_FAILED')
        fd = filter_fd()
        code, out, err = phase()
        report.update({'exitCode': code, 'stdout': out.decode('utf-8', errors='replace')[:131072],
                       'stderr': err.decode('utf-8', errors='replace')[:131072],
                       'stdoutBytes': len(out), 'stderrBytes': len(err), 'logsTruncated': len(out) > 131072 or len(err) > 131072})
        report['resourceEvents'] = {name: (group / name).read_text() for name in ['memory.events', 'pids.events']}
        if re.search(r'^oom_kill [1-9]', report['resourceEvents']['memory.events'], re.M):
            report['status'] = 'MEMORY_LIMIT'
        if report['status'] == 'EXECUTED' and code == 0 and not lost.is_set():
            detail['snapshotStatus'] = 'REJECTED'
            code, out, err = phase(snapshot=True)
            detail['snapshotExitCode'] = code
            diagnostic = job / 'snapshot-stage.json'
            padded_json_record(diagnostic, {'exitCode': code, 'stdout': out[:2048].decode('utf-8', errors='replace'),
                                           'stderr': err[:2048].decode('utf-8', errors='replace')}, 65536, pad=False)
            if code == 0 and report['status'] == 'EXECUTED' and not lost.is_set():
                snapshot = json.loads(out)
                target = data / '.dm-snapshot.sqlite'
                info = target.lstat()
                if snapshot.get('schema') != 'dream-maker.sqlite-snapshot.v1' or snapshot.get('integrity') != 'ok' or not stat.S_ISREG(info.st_mode) or \
                        not 512 <= info.st_size <= 67108864 or snapshot.get('bytes') != info.st_size:
                    raise RuntimeError('SQLITE_SNAPSHOT_RESULT_UNPROVEN')
                detail.update({'snapshotStatus': 'READY', 'snapshot': snapshot})
    except Exception as error:
        detail['failureCode'] = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'[A-Z0-9_]{1,80}', str(error)) else type(error).__name__
        detail.update({'snapshotStatus': 'REJECTED', 'snapshot': None})
        if lost.is_set():
            report['status'] = 'CANCELLED'
    finally:
        report['cleanup']['remainingPids'] = quiesce()
        if group.exists():
            detail['memoryPeakBytes'] = int((group / 'memory.peak').read_text())
            remove_quiescent_group(group)
        if fd is not None:
            os.close(fd)
        report['cleanup']['groupRemoved'] = not group.exists()
        current = (cgroot / 'cgroup.subtree_control').read_text().split()
        if current != before and not any(p.is_dir() for p in cgroot.iterdir()):
            (cgroot / 'cgroup.subtree_control').write_text(' '.join('-'+c for c in current if c not in before))
        report['cleanup']['delegationRestored'] = (cgroot / 'cgroup.subtree_control').read_text().split() == before
        report['cleanup']['sourceUnchanged'] = all(hashlib.sha256((source / item['path']).read_bytes()).hexdigest() == item['sha256'] for item in request['files'])
        if len(mounts) == 2:
            retain()
        for path in reversed(mounts):
            bounded_command(['umount', str(path)])
        detail['mountsRemoved'] = all(not os.path.ismount(path) for path in [run, data])
        if 'retention' in detail:
            detail['retention']['bytes'] = owned_allocated_bytes(job)
            if detail['retention']['bytes'] > reservation:
                raise RuntimeError('SQLITE_RETENTION_ALLOCATION_LIMIT')
        if lost.is_set() and detail['snapshotStatus'] == 'READY':
            report['status'] = 'CANCELLED'
            detail.update({'snapshotStatus': 'NOT_RUN', 'snapshot': None})
        padded_json_record(job / 'result.json', report, 2000000)
    snapshot = detail['snapshot']
    size, digest = (snapshot['bytes'], snapshot['sha256']) if detail['snapshotStatus'] == 'READY' else (0, empty_hash)
    frame = {'schema': 'dream-maker.sqlite-frame.v1', 'kind': 'SQLITE_IMAGE_V1', 'inputHash': exchange['inputHash'],
             'expectedRevision': revision, 'imageBytes': size, 'imageHash': digest, 'result': report}
    header = json.dumps(frame, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
    if len(header) > 2000000:
        raise RuntimeError('SQLITE_RESULT_METADATA_LIMIT')
    transport = {'schema': 'dream-maker.sqlite-transport.v1', 'jobId': request['jobId'], 'state': 'NOT_ACKNOWLEDGED', 'storeCommitted': False}
    try:
        # After an execution timeout/cancel, a small cleanup receipt may still be sent for
        # at most two seconds. A READY image always keeps the original deadline and EOF fence.
        send_bounded_output(1, header + b'\n', lost if size else threading.Event(), deadline if size else time.monotonic()+2)
        if size:
            if snapshot_span is None or snapshot_span[1] != size:
                raise RuntimeError('SQLITE_RETAINED_SNAPSHOT_MISSING')
            with (job / 'retained.bin').open('rb', buffering=0) as image:
                image.seek(snapshot_span[0])
                for offset in range(0, size, 65536):
                    body = image.read(min(65536, size-offset))
                    if len(body) != min(65536, size-offset):
                        raise RuntimeError('SQLITE_RETAINED_SNAPSHOT_TRUNCATED')
                    send_bounded_output(1, body, lost, deadline)
        transport['state'] = 'SENT_NOT_STORE_COMMITTED'
    except Exception as error:
        transport['state'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        raise
    finally:
        # A sent pipe is never an acknowledgement of Store CAS; all retained bytes remain.
        padded_json_record(job / 'result.json', report, 2000000)
        padded_json_record(job / 'transport.json', transport, 4096)
        finished.set()
        if watcher:
            watcher.join(timeout=1)
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


try:
    if payload.get('schema') == 'dream-maker.wsl-job.v2':
        execute_sqlite(payload)
    else:
        execute(payload)
except Exception as error:
    print(json.dumps({'schema': 'dream-maker.wsl-supervisor-error.v1',
                      'code': str(error) if isinstance(error, RuntimeError) else
                      ('OS_ERROR_' + str(error.errno) if isinstance(error, OSError) and type(error.errno) is int and 0 <= error.errno <= 4095 else type(error).__name__)}))
    raise SystemExit(7)
