# User-operated login in the installed, independent Linux CLI. No output capture.
param([switch]$UserLogin, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
if ($UserLogin -eq $ValidateOnly) { throw 'EXPLICIT_LOGIN_OR_VALIDATION_REQUIRED' }
$Mode = if ($ValidateOnly) { '--validate-only' } else { '--device-login' }
$Script = @'
import hashlib,json,os,pathlib,re,select,signal,subprocess,sys,time
root=pathlib.Path('/opt/dream-maker-controller/codex-0.162.0')
receipt=json.loads((root/'install-receipt.json').read_text())
entry=root/'launcher/package/bin/codex.js'
binary=root/'launcher/package/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
home=root/'codex-home'
if os.environ.get('WSL_DISTRO_NAME')!='DreamMaker-Acceptance-20261011':raise RuntimeError('DEDICATED_DISTRO_REQUIRED')
if home.is_symlink() or home.resolve()!=home or (home.stat().st_mode&0o777)!=0o700:raise RuntimeError('PRIVATE_CONTROL_HOME_REQUIRED')
if receipt['status']!='INSTALLED_VERSION_VERIFIED' or hashlib.sha256(binary.read_bytes()).hexdigest()!='50ed828f357c655a3c82054d346cab8434f24901f14ec19b8267571bdd008b38':raise RuntimeError('INDEPENDENT_CLI_BINDING_CHANGED')
if sys.argv[1:] == ['--validate-only']:
 print(json.dumps({'status':'LOGIN_SCOPE_VALIDATED','distro':'DreamMaker-Acceptance-20261011','version':'0.162.0','homeMode':'0700','modelCalls':0}))
 raise SystemExit(0)
if sys.argv[1:] != ['--device-login']:raise RuntimeError('EXPLICIT_DEVICE_LOGIN_REQUIRED')
os.umask(0o077)
lock=home/'dream-maker-device-login.lock'
handle=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
os.write(handle,str(os.getpid()).encode());os.close(handle)
env={'PATH':'/usr/bin:/bin','HOME':str(root),'CODEX_HOME':str(home)}
try:
 proc=subprocess.Popen(['/usr/bin/node',str(entry),'-c','cli_auth_credentials_store="file"','-c','forced_login_method="chatgpt"','login','--device-auth'],env=env,stderr=subprocess.PIPE,start_new_session=True)
 diagnostic=b'';deadline=time.monotonic()+900
 try:
  while proc.poll() is None:
   ready,_,_=select.select([proc.stderr],[],[],.2)
   if ready:
    data=os.read(proc.stderr.fileno(),8192)
    if data:sys.stderr.buffer.write(data);sys.stderr.buffer.flush();diagnostic=(diagnostic+data)[-16384:]
   if time.monotonic()>deadline:os.killpg(proc.pid,signal.SIGTERM);break
  proc.wait(timeout=5)
  data=proc.stderr.read(16384)
  if data:sys.stderr.buffer.write(data);sys.stderr.buffer.flush();diagnostic=(diagnostic+data)[-16384:]
 finally:
  if proc.poll() is None:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=5)
  proc.stderr.close()
 text=diagnostic.decode('utf-8','replace').lower()
 category='UNKNOWN'
 if 'unsupported_country' in text:category='REGION_REJECTED'
 elif '403' in text:category='HTTP_403'
 elif '401' in text:category='HTTP_401'
 elif 'not enabled' in text or 'disabled' in text:category='DEVICE_LOGIN_NOT_ENABLED'
 elif 'error sending request' in text or 'connection refused' in text:category='AUTH_NETWORK_ERROR'
 status={'schema':'dream-maker.user-login-result.v1','at':time.time(),'exitCode':proc.returncode,'status':'LOGIN_RETURNED_SUCCESS' if proc.returncode==0 else 'LOGIN_NOT_COMPLETED','errorCategory':category,'modelCalls':0}
 (home/('dream-maker-login-result-'+str(int(time.time()*1000))+'.json')).write_text(json.dumps(status)+'\n')
 raise SystemExit(proc.returncode)
finally:
 lock.unlink()
'@
if ($UserLogin) {
    $Host.UI.RawUI.WindowTitle = 'Dream Maker - Dedicated WSL Codex Login'
    Write-Host 'Use your existing ChatGPT account in the official browser page shown below.'
    Write-Host 'Keep the code in this local window only. Do not send passwords, codes or tokens to chat.'
    Write-Host 'No daily login, shared integration or model-spending setting is changed.'
}
& wsl.exe -d DreamMaker-Acceptance-20261011 --exec python3 -c $Script $Mode
$Result = $LASTEXITCODE
if ($UserLogin) {
    Write-Host ('Login process ended. Exit code: ' + $Result)
    Write-Host 'This window stays open. Close it after viewing the result.'
    return
}
exit $Result
