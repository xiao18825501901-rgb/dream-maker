"""Fixed controller helper. Production invocation is inside the isolated worker at /data only."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys

IMAGE_LIMIT = 64 * 1024 * 1024
SIDECAR_LIMIT = IMAGE_LIMIT
INPUT_TOTAL_LIMIT = 2 * IMAGE_LIMIT + 1048576
SNAPSHOT = '.dm-snapshot.sqlite'
ALLOWED = {'project.sqlite', 'project.sqlite-wal', 'project.sqlite-shm', 'project.sqlite-journal'}


def fail(code):
    raise RuntimeError(code)


def regular_file(path, limit):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        fail('SQLITE_DATA_FILE_DENIED')
    return info


def create_snapshot(directory):
    """Internal API; the supervisor must quiesce all generated processes before calling the helper."""
    directory = Path(directory)
    if not stat.S_ISDIR(directory.lstat().st_mode):
        fail('SQLITE_DATA_DIRECTORY_DENIED')
    target = directory / SNAPSHOT
    if target.exists() or target.is_symlink():
        fail('SQLITE_SNAPSHOT_ALREADY_EXISTS')
    entries = list(directory.iterdir())
    if len(entries) > len(ALLOWED) or any(path.name not in ALLOWED for path in entries):
        fail('SQLITE_DATA_UNDECLARED_FILE')
    sizes = [regular_file(path, 1048576 if path.name.endswith('-shm') else SIDECAR_LIMIT).st_size for path in entries]
    if sum(sizes) > INPUT_TOTAL_LIMIT:
        fail('SQLITE_DATA_TOTAL_LIMIT')
    source_path = directory / 'project.sqlite'
    if not source_path.exists():
        fail('SQLITE_DATA_MISSING')
    info = regular_file(source_path, IMAGE_LIMIT)
    if info.st_size < 512 or info.st_size % 512:
        fail('SQLITE_DATA_INVALID')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    with os.fdopen(os.open(source_path, flags), 'rb') as file:
        if file.read(16) != b'SQLite format 3\0':
            fail('SQLITE_DATA_INVALID')
    source = destination = None
    try:
        source = sqlite3.connect(source_path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
        source.enable_load_extension(False)
        source.execute('PRAGMA trusted_schema=OFF')
        source.execute('PRAGMA query_only=ON')
        source.execute('PRAGMA cache_size=-8192')
        source.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, IMAGE_LIMIT)
        source.execute('BEGIN')
        pages = source.execute('PRAGMA page_count').fetchone()[0]
        page_size = source.execute('PRAGMA page_size').fetchone()[0]
        if type(pages) is not int or type(page_size) is not int or pages < 1 or pages * page_size > IMAGE_LIMIT:
            fail('SQLITE_DATA_IMAGE_LIMIT')
        if source.execute('PRAGMA integrity_check').fetchone() != ('ok',):
            fail('SQLITE_DATA_INTEGRITY_FAILED')
        fd = os.open(target, os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        os.close(fd)
        destination = sqlite3.connect(target.resolve().as_uri() + '?mode=rw', uri=True, timeout=2)
        destination.enable_load_extension(False)
        destination.execute('PRAGMA trusted_schema=OFF')
        destination.execute('PRAGMA cache_size=-8192')
        source.backup(destination, pages=256, sleep=.01)
        if destination.execute('PRAGMA integrity_check').fetchone() != ('ok',):
            fail('SQLITE_SNAPSHOT_INTEGRITY_FAILED')
        if destination.execute('PRAGMA journal_mode=DELETE').fetchone() != ('delete',):
            fail('SQLITE_SNAPSHOT_NOT_SELF_CONTAINED')
        destination.close()
        destination = None
        for suffix in ['-wal', '-shm', '-journal']:
            if (directory / (SNAPSHOT + suffix)).exists():
                fail('SQLITE_SNAPSHOT_NOT_SELF_CONTAINED')
        regular_file(target, IMAGE_LIMIT)
        digest, size = hashlib.sha256(), 0
        with os.fdopen(os.open(target, flags), 'rb') as file:
            while True:
                body = file.read(65536)
                if not body:
                    break
                size += len(body)
                if size > IMAGE_LIMIT:
                    fail('SQLITE_DATA_IMAGE_LIMIT')
                digest.update(body)
        return {'schema': 'dream-maker.sqlite-snapshot.v1', 'bytes': size, 'sha256': digest.hexdigest(),
                'sqliteVersion': sqlite3.sqlite_version, 'integrity': 'ok'}
    except sqlite3.Error:
        fail('SQLITE_DATA_INVALID')
    finally:
        if destination is not None:
            destination.close()
        if source is not None:
            source.close()


if __name__ == '__main__':
    if sys.platform != 'linux' or not hasattr(os, 'O_NOFOLLOW') or len(sys.argv) != 1:
        fail('SQLITE_SNAPSHOT_ISOLATION_REQUIRED')
    try:
        result = create_snapshot(Path('/data'))
    except (RuntimeError, OSError):
        # The controller needs a bounded category, not schema details or business values.
        print(json.dumps({'schema': 'dream-maker.sqlite-snapshot-error.v1', 'code': 'SQLITE_DATA_INVALID'}))
        sys.exit(1)
    print(json.dumps(result))
