"""Fixed controller cleanup. No SQL parsing, recursive deletion, subprocesses or model credentials."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat

BASE = Path('/opt/dream-maker-acceptance-20261011')
ENVIRONMENT = 'DreamMaker-Acceptance-F-20261101-R2'
CONTAINER_BYTES = 536870912
METADATA_BYTES = 536870912
FIELDS = set('schema projectId runId specHash operationHash revision versionHash jobId sourceHash inputHash resultHash manifestHash workerHash resourceHelperHash resourceFinalHash imageHash imageBytes parentOperationHash parentImageHash parentImageBytes committedRecordId requestedRecordId closedRecordId cleanupRecordId grantRecordId originalDispatchId authorityHash'.split())


def fail(code):
    raise RuntimeError(code)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def basis_checked(value):
    if not isinstance(value, dict) or set(value) != FIELDS or value.get('schema') != 'dream-maker.sqlite-retirement-basis.v1':
        fail('SQLITE_RETIREMENT_BASIS_INVALID')
    hashes = 'specHash operationHash versionHash sourceHash inputHash resultHash manifestHash workerHash resourceHelperHash resourceFinalHash imageHash authorityHash'.split()
    if any(not isinstance(value.get(k), str) or not re.fullmatch('[a-f0-9]{64}', value[k]) for k in hashes):
        fail('SQLITE_RETIREMENT_BASIS_INVALID')
    if not re.fullmatch(r'wsl_job_[a-z0-9_-]{1,80}', str(value.get('jobId', ''))) or any(not isinstance(value.get(k), str) or not re.fullmatch(r'[A-Za-z0-9_:-]{1,160}', value[k]) for k in 'projectId runId committedRecordId requestedRecordId closedRecordId cleanupRecordId grantRecordId originalDispatchId'.split()):
        fail('SQLITE_RETIREMENT_BASIS_INVALID')
    if type(value['revision']) is not int or not 1 <= value['revision'] <= 32 or type(value['imageBytes']) is not int or not 512 <= value['imageBytes'] <= 67108864 or value['imageBytes'] % 512:
        fail('SQLITE_RETIREMENT_BASIS_INVALID')
    if value['revision'] == 1:
        if value['parentOperationHash'] is not None or value['parentImageHash'] is not None or value['parentImageBytes'] != 0:
            fail('SQLITE_RETIREMENT_BASIS_INVALID')
    elif any(not isinstance(value.get(k), str) or not re.fullmatch('[a-f0-9]{64}', value[k]) for k in ['parentOperationHash', 'parentImageHash']) or type(value['parentImageBytes']) is not int or not 512 <= value['parentImageBytes'] <= 67108864 or value['parentImageBytes'] % 512:
        fail('SQLITE_RETIREMENT_BASIS_INVALID')
    if digest({k: v for k, v in value.items() if k != 'authorityHash'}) != value['authorityHash']:
        fail('SQLITE_RETIREMENT_BASIS_INVALID')
    return dict(value)


def directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(fd)
    if info.st_uid != 0 or info.st_mode & 0o022:
        os.close(fd)
        fail('SQLITE_RETIREMENT_DIRECTORY_UNTRUSTED')
    return fd


def regular(fd, limit, private=True):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_size > limit or info.st_mode & (0o077 if private else 0o022):
        fail('SQLITE_RETIREMENT_FILE_UNTRUSTED')
    return info


def read_record(folder, name, limit=16384):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=folder)
    try:
        regular(fd, limit)
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            fail('SQLITE_RETIREMENT_RECORD_LIMIT')
        value = json.loads(raw)
        return value, hashlib.sha256(raw).hexdigest()
    finally:
        os.close(fd)


def write_record(folder, name, value):
    raw = canonical(value)
    if len(raw) > 16384:
        fail('SQLITE_RETIREMENT_RECORD_LIMIT')
    temporary = name + '.next'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=folder)
    try:
        with os.fdopen(os.dup(fd), 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(fd)
    os.replace(temporary, name, src_dir_fd=folder, dst_dir_fd=folder)
    os.fsync(folder)


def exists(folder, name):
    try:
        os.stat(name, dir_fd=folder, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False


def check_parent(parent_gone):
    if parent_gone():
        fail('SQLITE_RETIREMENT_CANCELLED')


def checked_tombstone(value, basis, reservation_hash):
    expected = {'schema': 'dream-maker.sqlite-retirement.v1', 'jobId': basis['jobId'],
                'authorityHash': basis['authorityHash'], 'resultHash': basis['resultHash'],
                'manifestHash': basis['manifestHash'], 'reservationHash': reservation_hash}
    if not isinstance(value, dict) or set(value) != set(expected) | {'metadataBytes', 'state'} or any(value.get(k) != v for k, v in expected.items()) or value.get('state') not in ['STARTED', 'RETIRED'] or type(value.get('metadataBytes')) is not int or not 0 <= value['metadataBytes'] <= 134217728:
        fail('SQLITE_RETIREMENT_PREVIOUS_UNPROVEN')
    return value


def metadata_room(base, job):
    jobs = [p for p in base.iterdir() if p.name.startswith('wsl_job_')]
    if len(jobs) > 512:
        fail('SQLITE_RETIREMENT_METADATA_LIMIT')
    total = 65536
    for path in jobs:
        folder = directory(path)
        try:
            if path != job and exists(folder, 'retirement.json'):
                record, _ = read_record(folder, 'retirement.json')
                amount = record.get('metadataBytes')
                if type(amount) is not int or not 0 <= amount <= 134217728:
                    fail('SQLITE_RETIREMENT_METADATA_UNPROVEN')
                total += amount
        finally:
            os.close(folder)
    size, stack, nodes = 65536, [job], 0
    while stack:
        for path in stack.pop().iterdir():
            nodes += 1
            if nodes > 10000:
                fail('SQLITE_RETIREMENT_METADATA_LIMIT')
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                fail('SQLITE_RETIREMENT_METADATA_UNPROVEN')
            if path != job / 'retained.bin':
                size += max(4096, info.st_blocks * 512)
            if stat.S_ISDIR(info.st_mode):
                stack.append(path)
    if size > 134217728 or total + size > METADATA_BYTES:
        fail('SQLITE_RETIREMENT_METADATA_LIMIT')
    return size


def attempt_binding(raw, attempt_id, helper_hash):
    b = basis_checked(raw)
    if not isinstance(attempt_id, str) or not re.fullmatch(r'retire_attempt_[a-f0-9]{32}', attempt_id) or not isinstance(helper_hash, str) or not re.fullmatch('[a-f0-9]{64}', helper_hash):
        fail('SQLITE_RETIREMENT_ATTEMPT_INVALID')
    return b, {'schema': 'dream-maker.sqlite-retirement-attempt.v1', 'attemptId': attempt_id,
               'jobId': b['jobId'], 'authorityHash': b['authorityHash'], 'helperHash': helper_hash,
               'resourceHelperHash': b['resourceHelperHash']}


def process_identity(pid):
    raw = Path('/proc', str(pid), 'stat').read_text()
    return {'pid': pid, 'startTicks': raw[raw.rindex(')') + 2:].split()[19]}


def boot_id():
    value = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    if not re.fullmatch('[a-f0-9-]{36}', value):
        fail('SQLITE_RETIREMENT_BOOT_UNPROVEN')
    return value


def record_retirement_attempt(raw, attempt_id, helper_hash, *, base=BASE):
    """Persist this exact process before any destructive effect. No subprocess is started here."""
    b, record = attempt_binding(raw, attempt_id, helper_hash)
    if os.getuid() != 0:
        fail('SQLITE_RETIREMENT_ROOT_REQUIRED')
    root = directory(base)
    folder = None
    try:
        folder = directory(base / b['jobId'])
        metadata_room(base, base / b['jobId'])
        record.update({'bootId': boot_id(), 'identity': process_identity(os.getpid())})
        fd = os.open(attempt_id + '.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=folder)
        try:
            with os.fdopen(os.dup(fd), 'wb') as stream:
                stream.write(canonical(record))
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            os.close(fd)
        os.fsync(folder)
        return record
    finally:
        if folder is not None:
            os.close(folder)
        os.close(root)


def observe_retirement_attempt(raw, attempt_id, helper_hash, attempt_hash, *, base=BASE):
    """Fresh read-only observation, including PID reuse and Linux boot identity."""
    b, expected = attempt_binding(raw, attempt_id, helper_hash)
    root = directory(base)
    folder = None
    try:
        folder = directory(base / b['jobId'])
        record, _ = read_record(folder, attempt_id + '.json')
        if not isinstance(record, dict) or set(record) != set(expected) | {'bootId', 'identity'} or digest(record) != attempt_hash or any(record.get(k) != v for k, v in expected.items()):
            fail('SQLITE_RETIREMENT_ATTEMPT_UNPROVEN')
        identity = record['identity']
        if not isinstance(record['bootId'], str) or not re.fullmatch('[a-f0-9-]{36}', record['bootId']) or not isinstance(identity, dict) or set(identity) != {'pid', 'startTicks'} or type(identity['pid']) is not int or identity['pid'] <= 1 or not isinstance(identity['startTicks'], str) or not re.fullmatch('[1-9][0-9]{0,19}', identity['startTicks']):
            fail('SQLITE_RETIREMENT_ATTEMPT_UNPROVEN')
        absent = boot_id() != record['bootId']
        if not absent:
            try:
                absent = process_identity(identity['pid']) != identity
            except FileNotFoundError:
                absent = True
        return {'schema': 'dream-maker.sqlite-retirement-observation.v1', 'attempt': record, 'helperAbsent': absent}
    finally:
        if folder is not None:
            os.close(folder)
        os.close(root)


def execute_retirement(raw, attempt_id, helper_hash, resource_reader, *, base=BASE, parent_gone=lambda: False):
    b = basis_checked(raw)
    attempt = record_retirement_attempt(b, attempt_id, helper_hash, base=base)
    outcome = {'schema': 'dream-maker.sqlite-retirement-outcome.v1', 'attemptId': attempt_id,
               'authorityHash': b['authorityHash'], 'attemptHash': digest(attempt),
               'status': 'FAILED', 'result': None, 'errorCode': None}
    try:
        outcome['result'] = retire_committed(b, resource_reader, base=base, parent_gone=parent_gone)
        outcome['status'] = 'RETIRED'
    except Exception as error:
        code = str(error)
        outcome['errorCode'] = code if re.fullmatch(r'SQLITE_RETIREMENT_[A-Z_]{1,80}', code) else 'SQLITE_RETIREMENT_FAILED'
    folder = directory(base / b['jobId'])
    try:
        write_record(folder, attempt_id + '.result.json', outcome)
    finally:
        os.close(folder)
    return outcome


def read_retirement_state(raw, attempt_id, helper_hash, *, base=BASE):
    b, _ = attempt_binding(raw, attempt_id, helper_hash)
    folder = directory(base / b['jobId'])
    try:
        attempt = read_record(folder, attempt_id + '.json')[0]
        observed = observe_retirement_attempt(b, attempt_id, helper_hash, digest(attempt), base=base)
        outcome = read_record(folder, attempt_id + '.result.json')[0] if exists(folder, attempt_id + '.result.json') else None
        if outcome is not None:
            expected = {'schema': 'dream-maker.sqlite-retirement-outcome.v1', 'attemptId': attempt_id,
                        'authorityHash': b['authorityHash'], 'attemptHash': digest(attempt)}
            if not isinstance(outcome, dict) or set(outcome) != set(expected) | {'status', 'result', 'errorCode'} or any(outcome.get(k) != v for k, v in expected.items()):
                fail('SQLITE_RETIREMENT_OUTCOME_UNPROVEN')
            if outcome['status'] == 'RETIRED':
                if not isinstance(outcome['result'], dict) or outcome['errorCode'] is not None:
                    fail('SQLITE_RETIREMENT_OUTCOME_UNPROVEN')
            elif outcome['status'] != 'FAILED' or outcome['result'] is not None or not isinstance(outcome['errorCode'], str) or not re.fullmatch(r'SQLITE_RETIREMENT_[A-Z_]{1,80}', outcome['errorCode']):
                fail('SQLITE_RETIREMENT_OUTCOME_UNPROVEN')
        return {**observed, 'outcome': outcome}
    finally:
        os.close(folder)


def retire_committed(raw, resource_reader, *, base=BASE, parent_gone=lambda: False):
    b = basis_checked(raw)
    if os.getuid() != 0:
        fail('SQLITE_RETIREMENT_ROOT_REQUIRED')
    root = directory(base)
    lock = None
    folder = None
    container = None
    try:
        lock = os.open('controller.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=root)
        regular(lock, 16384, private=False)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail('SQLITE_RETIREMENT_BUSY')
        job = base / b['jobId']
        folder = directory(job)
        check_parent(parent_gone)
        saved = resource_reader(b['jobId'])
        r, observation = saved['result'], saved['observation']
        final, seen = observation['final'], observation['observed']
        if digest(r) != b['resultHash'] or digest(final) != b['resourceFinalHash'] or any(seen.get(k) is not True for k in ['scopeAbsent', 'parentAbsent', 'childAbsent']):
            fail('SQLITE_RETIREMENT_RESOURCE_UNPROVEN')
        expected = {'jobId': b['jobId'], 'sourceHash': b['sourceHash'], 'workerHash': b['workerHash'], 'resourceHelperHash': b['resourceHelperHash']}
        if final.get('schema') != 'dream-maker.wsl-resource-final.v1' or final.get('environment') != ENVIRONMENT or final.get('resultHash') != b['resultHash'] or any(final.get(k) != v for k, v in expected.items()):
            fail('SQLITE_RETIREMENT_RESOURCE_UNPROVEN')
        s, cleanup = r.get('sqlite', {}), r.get('cleanup', {})
        if r.get('schema') != 'dream-maker.wsl-result.v1' or r.get('environment') != ENVIRONMENT or r.get('status') != 'EXECUTED' or r.get('exitCode') != 0 or any(r.get(k) != b[k] for k in ['jobId', 'sourceHash', 'workerHash']) or cleanup.get('remainingPids') != [] or any(cleanup.get(k) is not True for k in ['groupRemoved', 'delegationRestored', 'sourceUnchanged']):
            fail('SQLITE_RETIREMENT_RESULT_UNPROVEN')
        snapshot, retention = s.get('snapshot', {}), s.get('retention', {})
        if s.get('inputHash') != b['inputHash'] or s.get('expectedRevision') != b['revision'] - 1 or s.get('snapshotStatus') != 'READY' or snapshot.get('integrity') != 'ok' or snapshot.get('sha256') != b['imageHash'] or snapshot.get('bytes') != b['imageBytes'] or retention.get('manifestHash') != b['manifestHash'] or retention.get('containerBytes') != CONTAINER_BYTES:
            fail('SQLITE_RETIREMENT_IMAGE_UNPROVEN')
        original, _ = read_record(folder, 'result.json', 2000000)
        if digest(original) != b['resultHash']:
            fail('SQLITE_RETIREMENT_RESULT_CHANGED')
        manifest = os.open('retention.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=folder)
        try:
            regular(manifest, 67108864)
            checksum = hashlib.sha256()
            while True:
                check_parent(parent_gone)
                chunk = os.read(manifest, 65536)
                if not chunk:
                    break
                checksum.update(chunk)
            if checksum.hexdigest() != b['manifestHash']:
                fail('SQLITE_RETIREMENT_MANIFEST_CHANGED')
        finally:
            os.close(manifest)
        source = 'sqlite-reserved.json' if exists(folder, 'sqlite-reserved.json') else 'sqlite-reservation-retired.json'
        reservation, reservation_hash = read_record(folder, source)
        if reservation != {'jobId': b['jobId'], 'sourceHash': b['sourceHash'], 'workerHash': b['workerHash'], 'reservedBytes': 805306368}:
            fail('SQLITE_RETIREMENT_RESERVATION_UNPROVEN')
        previous = checked_tombstone(read_record(folder, 'retirement.json')[0], b, reservation_hash) if exists(folder, 'retirement.json') else None
        container = os.open('retained.bin', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=folder)
        size = regular(container, CONTAINER_BYTES).st_size
        # Recover only a fully readable private temp record for this exact authority.
        # A partial, foreign or contradictory file is retained for explicit reconciliation.
        if exists(folder, 'retirement.json.next'):
            pending = checked_tombstone(read_record(folder, 'retirement.json.next')[0], b, reservation_hash)
            impossible_retired = pending['state'] == 'RETIRED' and (size != 0 or not previous)
            regressed = previous and previous['state'] == 'RETIRED' and pending['state'] != 'RETIRED'
            unknown_size = size not in [0, CONTAINER_BYTES] or size == 0 and not previous
            if impossible_retired or regressed or unknown_size:
                fail('SQLITE_RETIREMENT_TEMP_UNPROVEN')
            check_parent(parent_gone)
            temporary = os.open('retirement.json.next', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=folder)
            try:
                regular(temporary, 16384)
                os.fsync(temporary)
            finally:
                os.close(temporary)
            os.replace('retirement.json.next', 'retirement.json', src_dir_fd=folder, dst_dir_fd=folder)
            os.fsync(folder)
            previous = pending
        if size != CONTAINER_BYTES and not (size == 0 and previous):
            fail('SQLITE_RETIREMENT_CONTAINER_UNPROVEN')
        if previous and previous['state'] == 'RETIRED' and size != 0:
            fail('SQLITE_RETIREMENT_CONTAINER_UNPROVEN')
        amount = metadata_room(base, job)
        check_parent(parent_gone)
        tombstone = {'schema': 'dream-maker.sqlite-retirement.v1', 'jobId': b['jobId'], 'authorityHash': b['authorityHash'], 'resultHash': b['resultHash'], 'manifestHash': b['manifestHash'], 'reservationHash': reservation_hash, 'metadataBytes': amount, 'state': 'STARTED'}
        replayed = bool(previous and previous['state'] == 'RETIRED' and size == 0 and source == 'sqlite-reservation-retired.json')
        if not replayed:
            if not (previous and previous['state'] == 'RETIRED'):
                write_record(folder, 'retirement.json', tombstone)
                check_parent(parent_gone)
                os.ftruncate(container, 0)
                os.fsync(container)
                tombstone['state'] = 'RETIRED'
                write_record(folder, 'retirement.json', tombstone)
            check_parent(parent_gone)
            if source == 'sqlite-reserved.json':
                if exists(folder, 'sqlite-reservation-retired.json'):
                    fail('SQLITE_RETIREMENT_RESERVATION_CONFLICT')
                os.rename('sqlite-reserved.json', 'sqlite-reservation-retired.json', src_dir_fd=folder, dst_dir_fd=folder)
                os.fsync(folder)
        if os.fstat(container).st_size != 0 or exists(folder, 'sqlite-reserved.json'):
            fail('SQLITE_RETIREMENT_RESULT_UNPROVEN')
        return {'schema': 'dream-maker.sqlite-retirement-result.v1', 'jobId': b['jobId'], 'authorityHash': b['authorityHash'], 'retired': True, 'containerBytesAfter': 0, 'reservationReleased': True, 'replayed': replayed, 'evidencePreserved': True}
    finally:
        for fd in [container, folder, lock, root]:
            if fd is not None:
                os.close(fd)
