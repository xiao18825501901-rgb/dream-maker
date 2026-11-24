#!/usr/bin/env python3
"""Read-only untrusted source ZIP preflight. Never extracts or executes a file.
Not a malware scanner, license approval or safe-to-run certificate.
"""
from __future__ import annotations
import hashlib, json, re, stat, sys, unicodedata, zipfile
from pathlib import Path, PurePosixPath

MAX_FILES=2500
MAX_FILE_BYTES=8*1024*1024
MAX_TOTAL_BYTES=100*1024*1024

class ArchiveRejected(ValueError):
    pass

def inspect_zip(path: str | Path) -> dict:
    path=Path(path)
    if path.is_symlink() or not path.is_file():
        raise ArchiveRejected('ARCHIVE_NOT_REGULAR_FILE')
    if path.stat().st_size > MAX_TOTAL_BYTES:
        raise ArchiveRejected('ARCHIVE_COMPRESSED_SIZE_LIMIT')
    with zipfile.ZipFile(path) as z:
        infos=z.infolist()
        if not infos or len(infos)>MAX_FILES:
            raise ArchiveRejected('ARCHIVE_ENTRY_COUNT')
        seen: dict[str,str]={}
        total=0; entries=[]
        for item in infos:
            # ZipInfo normalizes backslashes on Windows and truncates NUL in filename.
            # Validate the original central-directory bytes' decoded name before that normalization.
            name=item.orig_filename
            if '\x00' in name or '\\' in name or '%' in name or ':' in name or name.startswith('/') or len(name)>512:
                raise ArchiveRejected('ARCHIVE_UNSAFE_PATH')
            trimmed=name[:-1] if name.endswith('/') else name
            parts=trimmed.split('/')
            if not trimmed or len(parts)>25 or any(p in ('','.','..') or p.endswith(('.', ' ')) or any(ord(c)<32 or ord(c)==127 for c in p) for p in parts):
                raise ArchiveRejected('ARCHIVE_UNSAFE_PATH')
            if any(re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)',p,re.I) for p in parts):
                raise ArchiveRejected('ARCHIVE_WINDOWS_RESERVED_NAME')
            if any(p.casefold()=='.git' for p in parts) or parts[-1].casefold()=='.gitmodules':
                raise ArchiveRejected('ARCHIVE_GIT_CONTROL_DENIED')
            key=unicodedata.normalize('NFC',trimmed).casefold()
            if key in seen: raise ArchiveRejected('ARCHIVE_DUPLICATE_OR_CASE_COLLISION')
            mode=(item.external_attr>>16)&0xffff
            if mode and stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR):
                raise ArchiveRejected('ARCHIVE_LINK_OR_SPECIAL_FILE')
            if item.flag_bits&1: raise ArchiveRejected('ARCHIVE_ENCRYPTED_ENTRY')
            if item.file_size>MAX_FILE_BYTES: raise ArchiveRejected('ARCHIVE_FILE_LIMIT')
            total+=item.file_size
            if total>MAX_TOTAL_BYTES or item.file_size>1024*1024 and item.file_size/max(item.compress_size,1)>200:
                raise ArchiveRejected('ARCHIVE_EXPANSION_LIMIT')
            kind='DIRECTORY' if item.is_dir() else 'FILE'
            for parent in PurePosixPath(key).parents:
                if str(parent)!='.' and seen.get(str(parent))=='FILE': raise ArchiveRejected('ARCHIVE_FILE_DIRECTORY_COLLISION')
            if kind=='FILE' and any(old.startswith(key+'/') for old in seen): raise ArchiveRejected('ARCHIVE_FILE_DIRECTORY_COLLISION')
            seen[key]=kind
            h=hashlib.sha256();actual=0
            if not item.is_dir():
                with z.open(item) as f:
                    while block:=f.read(65536):
                        actual+=len(block)
                        if actual>MAX_FILE_BYTES or actual>item.file_size: raise ArchiveRejected('ARCHIVE_ACTUAL_SIZE_LIMIT')
                        h.update(block)
                if actual!=item.file_size: raise ArchiveRejected('ARCHIVE_SIZE_MISMATCH')
            entries.append({'path':name,'kind':kind,'bytes':item.file_size,'sha256':None if item.is_dir() else h.hexdigest(),'trust':'UNTRUSTED_SOURCE_ONLY'})
    return {'schema':'dream-maker.source-zip-preflight.v1','status':'STRUCTURE_CHECKED_NOT_SAFE_TO_EXECUTE','entryCount':len(entries),'uncompressedBytes':total,'entries':entries,'executedCode':False,'extractedFiles':False,'licenseApproved':False}

if __name__=='__main__':
    if len(sys.argv)!=2:
        print('Usage: python scripts/revamp/inspect-source-zip.py <source.zip>',file=sys.stderr);sys.exit(2)
    try:
        print(json.dumps(inspect_zip(sys.argv[1]),ensure_ascii=False,indent=2))
    except (ArchiveRejected,zipfile.BadZipFile,OSError) as exc:
        code=str(exc) if isinstance(exc,ArchiveRejected) else type(exc).__name__
        print(json.dumps({'status':'REJECTED','code':code}));sys.exit(1)
