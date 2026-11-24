"""DM-only ciphertext custody. No network, SQLite, model credentials or arbitrary paths.

Windows CurrentUser DPAPI remains the encryption boundary. Linux permissions protect
the F-backed dedicated distro copy; callers never ask this helper for plaintext.
"""
import base64
import hashlib
import json
import os
import pathlib
import re
import stat
import sys

ROOT = pathlib.Path('/opt/dream-maker-controller/native-probe-custody')
NAME = 'signing-key.dpapi'
SCHEMA = 'dream-maker.probe-cipher-custody.v1'
LIMIT = 8192


def deny(code='NATIVE_PROBE_CUSTODY_UNVERIFIED'):
    raise RuntimeError(code)


def directory(path, private=False):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & (0o077 if private else 0o022):
        deny()


def folder(namespace, create):
    for p in [pathlib.Path('/'), pathlib.Path('/opt'), ROOT.parent]:
        directory(p)
    for p in [ROOT, ROOT / namespace]:
        if not p.exists():
            if not create:
                return None
            try:
                p.mkdir(mode=0o700)
            except FileExistsError:
                pass
        directory(p, True)
    p = ROOT / namespace
    names = list(p.iterdir())
    if len(names) > 1 or any(x.name != NAME for x in names):
        deny('NATIVE_PROBE_CUSTODY_COLLISION')
    return p


def read_cipher(p):
    target = p / NAME
    try:
        before = target.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or stat.S_IMODE(before.st_mode) != 0o600 or not 1 <= before.st_size <= LIMIT:
        deny()
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        current = os.fstat(fd)
        if (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino):
            deny()
        value = b''
        while True:
            chunk = os.read(fd, LIMIT + 1 - len(value))
            if not chunk:
                break
            value += chunk
            if len(value) > LIMIT:
                deny()
        if len(value) != before.st_size:
            deny()
        return value
    finally:
        os.close(fd)


def execute(request):
    if os.geteuid() != 0 or not isinstance(request, dict):
        deny()
    action, ns = request.get('action'), request.get('namespace')
    if action not in ('read', 'import') or not isinstance(ns, str) or not re.fullmatch('[a-f0-9]{64}', ns):
        deny()
    if set(request) != ({'action', 'namespace'} if action == 'read' else {'action', 'namespace', 'ciphertext', 'sha256'}):
        deny()
    incoming = None
    if action == 'import':
        text = request['ciphertext']
        if not isinstance(text, str) or len(text) > 12000:
            deny()
        incoming = base64.b64decode(text, validate=True)
        if not 1 <= len(incoming) <= LIMIT or hashlib.sha256(incoming).hexdigest() != request['sha256']:
            deny()
    p = folder(ns, action == 'import')
    value = read_cipher(p) if p else None
    if value is None and action == 'import':
        try:
            fd = os.open(p / NAME, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            value = read_cipher(p)
        else:
            try:
                offset = 0
                while offset < len(incoming):
                    n = os.write(fd, incoming[offset:])
                    if n <= 0:
                        deny()
                    offset += n
                os.fsync(fd)
            finally:
                os.close(fd)
            parent = os.open(p, os.O_DIRECTORY | os.O_RDONLY)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
            value = read_cipher(p)
    if value is None:
        return {'schema': SCHEMA, 'namespace': ns, 'status': 'MISSING'}
    if action == 'import' and value != incoming:
        deny('NATIVE_PROBE_CUSTODY_CONFLICT')
    return {'schema': SCHEMA, 'namespace': ns, 'status': 'READY', 'uid': 0, 'directoryMode': '0700', 'fileMode': '0600',
            'sha256': hashlib.sha256(value).hexdigest(), 'ciphertext': base64.b64encode(value).decode('ascii')}


def main():
    try:
        raw = sys.stdin.buffer.read(32769)
        if len(raw) > 32768:
            deny()
        result = execute(json.loads(raw))
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch('NATIVE_PROBE_[A-Z_]+', str(error)) else 'NATIVE_PROBE_CUSTODY_UNVERIFIED'
        print(json.dumps({'schema': SCHEMA, 'status': 'DENIED', 'code': code}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
