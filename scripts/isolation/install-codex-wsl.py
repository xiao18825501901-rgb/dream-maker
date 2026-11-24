"""Explicit pinned install in the owned WSL distro; no npm scripts or credentials."""
import base64
import datetime
import hashlib
import json
import os
import pathlib
import platform
import subprocess
import sys
import tarfile
import time
import urllib.parse
import urllib.request

VERSION = '0.162.0'
DISTRO = 'DreamMaker-Acceptance-20261011'
TARGET = pathlib.Path('/opt/dream-maker-controller/codex-' + VERSION)
REGISTRY = 'https://registry.npmjs.org'
MAX_ARCHIVE = 250 * 1024 * 1024
MAX_UNPACKED = 600 * 1024 * 1024

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('INSTALL_REDIRECT_DENIED')

def registry_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != 'registry.npmjs.org' or parsed.query or parsed.fragment:
        raise RuntimeError('INSTALL_REGISTRY_TARGET_DENIED')
    if not (parsed.path.startswith('/@openai') or parsed.path == '/-/npm/v1/keys'):
        raise RuntimeError('INSTALL_REGISTRY_PATH_DENIED')
    return url

def fetch_bytes(url, limit):
    registry_url(url)
    if any(os.environ.get(key) for key in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']):
        raise RuntimeError('INSTALL_PROXY_ENV_DENIED')
    opener = urllib.request.build_opener(NoRedirect())
    deadline = time.monotonic() + 180
    with opener.open(url, timeout=30) as response:
        chunks, count = [], 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            count += len(chunk)
            if count > limit or time.monotonic() > deadline:
                raise RuntimeError('INSTALL_DOWNLOAD_LIMIT')
            chunks.append(chunk)
        return b''.join(chunks)

def metadata(version):
    value = json.loads(fetch_bytes(REGISTRY + '/@openai%2Fcodex/' + version, 1000000))
    if value.get('name') != '@openai/codex' or value.get('version') != version or value.get('license') != 'Apache-2.0':
        raise RuntimeError('INSTALL_PACKAGE_IDENTITY_DENIED')
    if value.get('repository', {}).get('url') != 'git+https://github.com/openai/codex.git' or value.get('scripts') or value.get('dependencies'):
        raise RuntimeError('INSTALL_PACKAGE_SCOPE_DENIED')
    expected = REGISTRY + '/@openai/codex/-/codex-' + version + '.tgz'
    if value.get('dist', {}).get('tarball') != expected:
        raise RuntimeError('INSTALL_TARBALL_ROUTE_DENIED')
    return value

def verify_signature(pack, keys):
    # npm's documented name@version:integrity signature, verified by existing Node crypto.
    program = """const fs=require('fs'),crypto=require('crypto');const x=JSON.parse(fs.readFileSync(0,'utf8'));
const msg=x.pack.name+'@'+x.pack.version+':'+x.pack.dist.integrity;
const valid=x.pack.dist.signatures.some(s=>x.keys.some(k=>k.keyid===s.keyid&&k.scheme==='ecdsa-sha2-nistp256'&&
(!k.expires||Date.parse(k.expires)>Date.now())&&crypto.verify('sha256',Buffer.from(msg),
{key:Buffer.from(k.key,'base64'),format:'der',type:'spki'},Buffer.from(s.sig,'base64'))));
if(!valid)process.exit(4);console.log(JSON.stringify({verified:true}));"""
    result = subprocess.run(['/usr/bin/node', '-e', program], input=json.dumps({'pack':pack,'keys':keys}),
                            text=True, capture_output=True, timeout=15,
                            env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent'})
    if result.returncode != 0:
        raise RuntimeError('INSTALL_REGISTRY_SIGNATURE_FAILED')

def checked_members(archive):
    members, seen, total = archive.getmembers(), set(), 0
    if len(members) > 1000:
        raise RuntimeError('INSTALL_ARCHIVE_MEMBER_LIMIT')
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '\\' in member.name or ':' in member.name or '..' in path.parts or not path.parts or path.parts[0] != 'package':
            raise RuntimeError('INSTALL_ARCHIVE_PATH_DENIED')
        if not (member.isdir() or member.isfile()) or str(path) in seen:
            raise RuntimeError('INSTALL_ARCHIVE_TYPE_OR_DUPLICATE_DENIED')
        seen.add(str(path)); total += member.size
        if member.size < 0 or total > MAX_UNPACKED:
            raise RuntimeError('INSTALL_ARCHIVE_SIZE_DENIED')
    return members

def install():
    if sys.argv[1:] != ['--authorized-wsl-install'] or platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise RuntimeError('EXPLICIT_LINUX_X64_INSTALL_REQUIRED')
    if os.environ.get('WSL_DISTRO_NAME') != DISTRO or not pathlib.Path('/opt/dream-maker-acceptance-20261011').is_dir():
        raise RuntimeError('DEDICATED_WSL_IDENTITY_REQUIRED')
    if os.getuid() != 0:
        raise RuntimeError('DEDICATED_CONTROLLER_OWNER_REQUIRED')
    for parent in [pathlib.Path('/opt'), TARGET.parent]:
        if parent.is_symlink():
            raise RuntimeError('INSTALL_TARGET_LINK_DENIED')
    if TARGET.exists() or TARGET.is_symlink():
        raise RuntimeError('INSTALL_TARGET_ALREADY_EXISTS')
    keys = json.loads(fetch_bytes(REGISTRY + '/-/npm/v1/keys', 1000000))['keys']
    packages = [metadata(VERSION), metadata(VERSION + '-linux-x64')]
    if packages[0].get('optionalDependencies', {}).get('@openai/codex-linux-x64') != 'npm:@openai/codex@' + VERSION + '-linux-x64':
        raise RuntimeError('INSTALL_PLATFORM_ALIAS_MISMATCH')
    if packages[1].get('optionalDependencies'):
        raise RuntimeError('INSTALL_UNEXPECTED_PLATFORM_DEPENDENCY')
    for pack in packages:
        verify_signature(pack, keys)
    TARGET.parent.mkdir(mode=0o700, exist_ok=True)
    TARGET.mkdir(mode=0o700)
    cache = TARGET / 'verified-archives'; cache.mkdir(mode=0o700)
    report = {'schema':'dream-maker.wsl-codex-install.v1','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'distro':DISTRO,'target':str(TARGET),'version':VERSION,'packages':[],
              'modelCalls':0,'authenticationImported':False,'globalLinksCreated':False,'npmInstalled':False}
    try:
        for index, pack in enumerate(packages):
            data = fetch_bytes(pack['dist']['tarball'], MAX_ARCHIVE)
            actual = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode('ascii')
            if actual != pack['dist']['integrity']:
                raise RuntimeError('INSTALL_TARBALL_INTEGRITY_FAILED')
            archive_path = cache / (pack['version'] + '.tgz'); archive_path.write_bytes(data)
            destination = TARGET / ('launcher' if index == 0 else 'native')
            destination.mkdir(mode=0o700)
            with tarfile.open(archive_path, 'r:gz') as archive:
                members = checked_members(archive)
                archive.extractall(destination, members=members, filter='data')
            report['packages'].append({'name':pack['name'],'version':pack['version'],'tarball':pack['dist']['tarball'],
                'integrity':actual,'archiveSha256':hashlib.sha256(data).hexdigest(),'signatureVerified':True,
                'archiveBytes':len(data),'unpackedBytes':sum(m.size for m in members),'members':len(members)})
        # Match the official launcher's published platform-package resolution without global npm.
        alias = TARGET / 'launcher/package/node_modules/@openai/codex-linux-x64'
        alias.parent.mkdir(parents=True, mode=0o700)
        os.rename(TARGET / 'native/package', alias)
        entry = TARGET / 'launcher/package/bin/codex.js'
        binary = alias / 'vendor/x86_64-unknown-linux-musl/bin/codex'
        home = TARGET / 'codex-home'; home.mkdir(mode=0o700)
        env = {'PATH':'/usr/bin:/bin','HOME':str(TARGET),'CODEX_HOME':str(home)}
        version = subprocess.run(['/usr/bin/node',str(entry),'--version'],text=True,capture_output=True,timeout=15,env=env)
        if version.returncode != 0 or version.stdout.strip() != 'codex-cli ' + VERSION:
            raise RuntimeError('INSTALL_VERSION_EXECUTION_FAILED')
        report.update({'status':'INSTALLED_VERSION_VERIFIED','entry':str(entry),'binary':str(binary),'home':str(home),
                       'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'actualVersion':version.stdout.strip()})
    except Exception as error:
        report.update({'status':'FAILED_PRESERVED_OWNED_DIRECTORY','code':type(error).__name__,
                       'failure':str(error) if isinstance(error,RuntimeError) else 'INSTALL_OPERATION_FAILED'})
        raise
    finally:
        (TARGET / 'install-receipt.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report),flush=True)

if __name__ == '__main__':
    install()
