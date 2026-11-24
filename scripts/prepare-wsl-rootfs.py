"""Build a separate controller-configured archive; never edit another distribution."""
import hashlib, io, json, sys, tarfile
from pathlib import Path

source, sums, target = map(Path, sys.argv[1:4])
if target.exists():
    raise FileExistsError('Existing isolation archive is preserved')
expected = next(line.split()[0] for line in sums.read_text(encoding='utf-8').splitlines() if line.split()[-1].lstrip('*') == source.name)
actual = hashlib.file_digest(source.open('rb'), 'sha256').hexdigest()
if actual != expected:
    raise ValueError('Official rootfs checksum mismatch')
configuration = b'''[automount]\nenabled=false\nmountFsTab=false\n[interop]\nenabled=false\nappendWindowsPath=false\n[boot]\nsystemd=false\n[gpu]\nenabled=false\nappendLibPath=false\n'''
with tarfile.open(source, 'r:gz') as original, tarfile.open(target, 'w:gz') as output:
    for entry in original:
        if entry.name.lstrip('./') == 'etc/wsl.conf':
            continue
        output.addfile(entry, original.extractfile(entry) if entry.isfile() else None)
    entry = tarfile.TarInfo('etc/wsl.conf')
    entry.size, entry.mode, entry.uid, entry.gid = len(configuration), 0o644, 0, 0
    output.addfile(entry, io.BytesIO(configuration))
print(json.dumps({'schema':'dream-maker.rootfs-source.v1','source':source.name,'sourceSha256':actual,'officialChecksumMatched':True,'configuredArchive':target.name,'configuredSha256':hashlib.file_digest(target.open('rb'),'sha256').hexdigest(),'globalConfigChanged':False,'qualifiedSandbox':False}))
