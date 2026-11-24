"""Own the existing Kimi byte bridge in the DM-only WSL. No OAuth/model request implementation.
stdin lifetime is the ownership signal. stdout contains only bounded public lifecycle events.
"""
import hashlib
import errno
import json
import os
from pathlib import Path
import re
import select
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit

ROOT = '/opt/dream-maker-controller/'
PINS = ('supervisor', 'bridge', 'connector', 'node', 'program')
KEYS = {'schema', 'distro', *PINS, 'home', 'port', 'hashes', 'serviceId', 'instanceId', 'accountRef'}
PROXY_KEYS = {'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'}
BYPASS = 'localhost,127.0.0.1,::1,[::1]'


def safe_path(value):
    return isinstance(value, str) and value.startswith(ROOT) and len(value) < 400 and all(
        part not in ('.', '..') and re.fullmatch(r'[A-Za-z0-9._-]+', part)
        for part in value[1:].split('/'))


def validate_profile(p):
    if not isinstance(p, dict) or set(p) not in (KEYS, KEYS | {'network'}) or p['schema'] != 'dream-maker.kimi-local-service.v1':
        raise ValueError('PROFILE_INVALID')
    if not isinstance(p['distro'], str) or not re.fullmatch(r'DreamMaker-[A-Za-z0-9._-]{1,65}', p['distro']):
        raise ValueError('PROFILE_INVALID')
    if type(p['port']) is not int or not 1024 <= p['port'] <= 65535 or any(not safe_path(p[k]) for k in (*PINS, 'home')):
        raise ValueError('PROFILE_INVALID')
    if not isinstance(p['hashes'], dict) or set(p['hashes']) != set(PINS) or any(
            not isinstance(p['hashes'][k], str) or not re.fullmatch(r'[a-f0-9]{64}', p['hashes'][k]) for k in PINS):
        raise ValueError('PROFILE_INVALID')
    if not isinstance(p['serviceId'], str) or not re.fullmatch(r'kimi_service_[a-f0-9]{20}', p['serviceId']) or p['instanceId'] != p['serviceId']:
        raise ValueError('PROFILE_INVALID')
    if not isinstance(p['accountRef'], str) or len(p['accountRef']) > 256 or any(ord(c) < 32 for c in p['accountRef']):
        raise ValueError('PROFILE_INVALID')
    if 'network' in p:
        validate_network(p['network'])


def private_ipv4(host):
    try:
        parts = [int(part) for part in host.split('.')]
    except (TypeError, ValueError):
        return False
    if len(parts) != 4 or any(part < 0 or part > 255 for part in parts):
        return False
    return parts[0] == 10 or (parts[0] == 172 and 16 <= parts[1] <= 31) or (parts[0] == 192 and parts[1] == 168)


def validate_network(network):
    if not isinstance(network, dict) or set(network) != {'schema', 'environment'} or network['schema'] != 'dream-maker.kimi-wsl-proxy.v1':
        raise ValueError('PROFILE_INVALID')
    environment = network['environment']
    if not isinstance(environment, dict) or set(environment) != PROXY_KEYS | {'NO_PROXY', 'no_proxy'}:
        raise ValueError('PROFILE_INVALID')
    proxies = {environment[key] for key in PROXY_KEYS}
    if len(proxies) != 1:
        raise ValueError('PROFILE_INVALID')
    proxy = next(iter(proxies))
    if not isinstance(proxy, str):
        raise ValueError('PROFILE_INVALID')
    parsed = urlsplit(proxy)
    if (parsed.scheme != 'http' or not parsed.hostname or not private_ipv4(parsed.hostname)
            or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment
            or parsed.path != '/' or not parsed.port or not 1 <= parsed.port <= 65535):
        raise ValueError('PROFILE_INVALID')
    if environment['NO_PROXY'] != BYPASS or environment['no_proxy'] != BYPASS:
        raise ValueError('PROFILE_INVALID')
    return {key: environment[key] for key in PROXY_KEYS | {'NO_PROXY', 'no_proxy'}}


def physical_path(value, directory=False):
    current = Path('/')
    for part in Path(value).parts[1:]:
        current /= part
        if stat.S_ISLNK(current.lstat().st_mode):
            raise ValueError('REDIRECTED_PROGRAM')
    mode = current.stat().st_mode
    if not (stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)):
        raise ValueError('REGULAR_PROGRAM_REQUIRED')
    return current


def emit(service_id, kind, **fields):
    print(json.dumps({'schema': 'dream-maker.kimi-service-event.v1', 'type': kind,
                      'serviceId': service_id, **fields}, separators=(',', ':')), flush=True)


def listener_matches(records, owned_inodes, port):
    owned = [r for r in records if r['inode'] in owned_inodes and r['state'] == '0A']
    return bool(owned) and all(r['address'] == '0100007F' and r['port'] == port for r in owned)


def check_port(port):
    import socket
    with socket.socket() as check:
        # Match the Linux HTTP listener's restart semantics; TIME_WAIT is not a live owner.
        # SO_REUSEPORT is deliberately absent: an active listener must still be refused.
        check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        check.bind(('127.0.0.1', port))


def owned_listener_ready(group, port):
    inodes = set()
    for pid in (group / 'cgroup.procs').read_text().split():
        try:
            for fd in Path('/proc', pid, 'fd').iterdir():
                try:
                    link = os.readlink(fd)
                    if re.fullmatch(r'socket:\[\d+\]', link):
                        inodes.add(link[8:-1])
                except OSError:
                    pass
        except OSError:
            pass
    records = []
    for path in ['/proc/net/tcp', '/proc/net/tcp6']:
        for line in Path(path).read_text().splitlines()[1:]:
            fields = line.split()
            address, raw_port = fields[1].split(':')
            records.append({'address': address, 'port': int(raw_port, 16), 'state': fields[3], 'inode': fields[9]})
    return listener_matches(records, inodes, port)


def reserve_home(home, service_id, boot_id):
    marker = home / '.dm-owned-service.pending.json'
    raw = json.dumps({'serviceId': service_id, 'bootId': boot_id, 'scope': 'UNCLEARED_UNTIL_CGROUP_PROOF'},
                     sort_keys=True, separators=(',', ':')).encode()
    try:
        # O_CREAT|O_EXCL rejects every existing path, including a symlink, on Linux and Windows.
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise ValueError('HOME_CLEANUP_RECONCILIATION_REQUIRED') from None
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    if sys.platform.startswith('linux'):
        directory = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    return raw


def clear_home(home, expected, proven):
    if not proven:
        return
    marker = home / '.dm-owned-service.pending.json'
    if marker.is_symlink() or marker.read_bytes() != expected:
        raise ValueError('HOME_IDENTITY_CHANGED')
    marker.unlink()
    if sys.platform.startswith('linux'):
        directory = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def settle_owned_group(group, child, timeout=5):
    deadline = time.monotonic() + timeout
    result = {'proven': False, 'remainingPids': [], 'errno': None, 'stage': 'CGROUP_KILL'}
    try:
        (group / 'cgroup.kill').write_text('1')
        result['stage'] = 'CHILD_REAP'
        if child is not None:
            child.wait(timeout=max(.1, deadline - time.monotonic()))
        while time.monotonic() < deadline:
            result['stage'] = 'KERNEL_EMPTY_CHECK'
            result['remainingPids'] = (group / 'cgroup.procs').read_text().split()
            threads = (group / 'cgroup.threads').read_text().strip()
            populated = dict(line.split() for line in (group / 'cgroup.events').read_text().splitlines()).get('populated')
            if not result['remainingPids'] and not threads and populated == '0':
                result['stage'] = 'CGROUP_REMOVE'
                try:
                    group.rmdir()
                    result.update(proven=True, stage='EMPTY_AND_REMOVED')
                    return result
                except OSError as error:
                    result['errno'] = error.errno
                    if error.errno != errno.EBUSY:
                        return result
            time.sleep(.02)
    except OSError as error:
        result['errno'] = error.errno
    except subprocess.TimeoutExpired:
        result['stage'] = 'CHILD_REAP_TIMEOUT'
    return result


def reconcile_pending_home(home, service_id, expected_hash, group, boot_id):
    if (not re.fullmatch(r'kimi_service_[a-f0-9]{20}', service_id)
            or not re.fullmatch(r'[a-f0-9]{64}', expected_hash)
            or not re.fullmatch(r'[a-f0-9-]{36}', boot_id)
            or group.as_posix() != '/sys/fs/cgroup/dream-maker-kimi-services/dm-' + service_id):
        raise ValueError('RECOVERY_SCOPE_INVALID')
    marker = home / '.dm-owned-service.pending.json'
    if marker.is_symlink():
        raise ValueError('HOME_IDENTITY_CHANGED')
    raw = marker.read_bytes()
    if len(raw) > 4096 or hashlib.sha256(raw).hexdigest() != expected_hash:
        raise ValueError('HOME_IDENTITY_CHANGED')
    saved = json.loads(raw)
    if saved.get('serviceId') != service_id or saved.get('scope') != 'UNCLEARED_UNTIL_CGROUP_PROOF' or not re.fullmatch(r'[a-f0-9-]{36}', str(saved.get('bootId', ''))):
        raise ValueError('HOME_IDENTITY_CHANGED')
    reason = 'PREVIOUS_KERNEL_ENDED' if saved.get('bootId') != boot_id else 'EXACT_CGROUP_EMPTY'
    if saved.get('bootId') == boot_id and group.exists():
        populated = dict(line.split() for line in (group / 'cgroup.events').read_text().splitlines()).get('populated')
        if (group / 'cgroup.procs').read_text().strip() or (group / 'cgroup.threads').read_text().strip() or populated != '0':
            raise ValueError('OWNED_GROUP_STILL_POPULATED')
        group.rmdir()  # Never kill during reconciliation or remove another group recursively.
    clear_home(home, raw, True)
    return {'proven': True, 'reason': reason, 'serviceId': service_id, 'markerHash': expected_hash}


def main():
    if not sys.platform.startswith('linux'):
        return 2
    import fcntl
    import socket
    os.umask(0o077)
    line = sys.stdin.buffer.readline(65537)
    if len(line) > 65536 or not line.endswith(b'\n'):
        return 2
    p = json.loads(line)
    validate_profile(p)
    service_id = p['serviceId']
    child = None
    group = None
    home_lock = None
    group_created = False
    home_marker = None
    cleanup = False
    return_code = 1
    try:
        for key in PINS:
            program = physical_path(p[key])
            digest = hashlib.sha256()
            with program.open('rb') as source:
                for block in iter(lambda: source.read(1048576), b''):
                    digest.update(block)
            if digest.hexdigest() != p['hashes'][key]:
                raise ValueError('PROGRAM_PIN_MISMATCH')
        home = physical_path(p['home'], directory=True)
        home_lock = os.open(home / '.dm-owned-service.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        fcntl.flock(home_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Refuse an occupied port; never stop or reconfigure the existing listener.
        check_port(p['port'])
        parent = Path(ROOT) / 'owned-kimi-services'
        parent.mkdir(mode=0o700, exist_ok=True)
        physical_path(str(parent), directory=True)
        job = parent / service_id
        job.mkdir(mode=0o700)
        control = job / 'control.sock'
        cgroot = Path('/sys/fs/cgroup/dream-maker-kimi-services')
        required = {'memory', 'pids', 'cpu'}
        if not cgroot.is_dir() or not required <= set((cgroot / 'cgroup.subtree_control').read_text().split()):
            raise ValueError('DEDICATED_RESOURCE_PARENT_REQUIRED')
        group = cgroot / ('dm-' + service_id)
        group.mkdir()
        group_created = True
        (group / 'memory.max').write_text(str(768 * 1024 * 1024))
        (group / 'memory.swap.max').write_text('0')
        (group / 'pids.max').write_text('64')
        (group / 'cpu.max').write_text('100000 100000')
        home_marker = reserve_home(home, service_id, Path('/proc/sys/kernel/random/boot_id').read_text().strip())

        def enter():
            (group / 'cgroup.procs').write_text(str(os.getpid()))

        command = ['/usr/bin/python3', p['bridge'], '--home', p['home'], '--socket', str(control), '--',
                   p['node'], p['program'], 'web', '--no-open', '--host', '127.0.0.1', '--port', str(p['port'])]
        network = validate_network(p['network']) if 'network' in p else {}
        env = {'PATH': '/usr/bin:/bin', 'HOME': p['home'], 'KIMI_CODE_HOME': p['home'], 'LANG': 'C.UTF-8',
               'DM_KIMI_BRIDGE': '1', 'DM_KIMI_INSTANCE_ID': service_id, 'DM_KIMI_ACCOUNT_REF': p['accountRef'],
               **network}
        child = subprocess.Popen(command, cwd=home, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, preexec_fn=enter, close_fds=True)
        # Drain all child output without persisting secrets or letting a full pipe stall shutdown.
        streams = [child.stdout, child.stderr]
        ready = False
        deadline = time.monotonic() + 25
        while child.poll() is None:
            watch = [sys.stdin.fileno(), *(stream.fileno() for stream in streams)]
            readable, _, _ = select.select(watch, [], [], 0.1)
            for stream in list(streams):
                if stream.fileno() in readable and not os.read(stream.fileno(), 65536):
                    streams.remove(stream)
            if sys.stdin.fileno() in readable:
                # Closing the owner channel, or any unexpected payload, ends this service.
                os.read(sys.stdin.fileno(), 1)
                return_code = 0
                break
            if not ready and control.exists() and owned_listener_ready(group, p['port']):
                if not stat.S_ISSOCK(control.lstat().st_mode) or stat.S_IMODE(control.stat().st_mode) != 0o600:
                    raise ValueError('PRIVATE_SOCKET_REQUIRED')
                ready = True
                emit(service_id, 'READY', socket=str(control), port=p['port'])
            if not ready and time.monotonic() > deadline:
                raise ValueError('START_TIMEOUT')
        if child.poll() is not None:
            raise ValueError('SERVICE_EXITED')
    except Exception as error:
        # Fixed category only: neither Python exceptions nor Kimi stderr are credential-safe logs.
        allowed = {'PROGRAM_PIN_MISMATCH', 'DEDICATED_RESOURCE_PARENT_REQUIRED', 'PRIVATE_SOCKET_REQUIRED',
                   'HOME_CLEANUP_RECONCILIATION_REQUIRED', 'START_TIMEOUT', 'SERVICE_EXITED', 'REDIRECTED_PROGRAM',
                   'REGULAR_PROGRAM_REQUIRED'}
        reason = str(error) if isinstance(error, ValueError) and str(error) in allowed else 'SYSTEM_FAILURE'
        emit(service_id, 'FAILED', reason=reason, errno=error.errno if isinstance(error, OSError) else None)
    finally:
        result = {'proven': child is None, 'remainingPids': [], 'errno': None, 'stage': 'NO_CHILD_STARTED'}
        if group_created and group.exists():
            result = settle_owned_group(group, child)
        cleanup = result['proven']
        if home_marker is not None:
            try:
                clear_home(home, home_marker, cleanup)
            except (OSError, ValueError):
                cleanup = False
        if home_lock is not None:
            os.close(home_lock)
        emit(service_id, 'CLEANUP', proven=cleanup, remainingPids=result['remainingPids'], stage=result['stage'], errno=result['errno'])
    return return_code if cleanup else 3


if __name__ == '__main__':
    sys.exit(main())
