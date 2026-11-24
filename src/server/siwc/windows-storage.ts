import { spawn } from 'node:child_process';
import { resolve, parse, dirname } from 'node:path';
import { lstatSync } from 'node:fs';
import { platform } from 'node:os';
import { SiwcBlocked } from './errors.js';
/** Gate before any SDK instantiation or token file access. No ACL relaxation; only dedicated new SIWC directory. */
const SCRIPT=`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try {
  $payload=[Console]::In.ReadLine()
  $target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
  if ([string]::IsNullOrWhiteSpace($target)) { throw 'invalid path' }
  $dir=[System.IO.Directory]::CreateDirectory($target)
  if (($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'reparse denied'}
  $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $sid) { throw 'no user SID' }
  $accessSections=[Security.AccessControl.AccessControlSections]::Access
  $ownerSections=[Security.AccessControl.AccessControlSections]::Owner
  $acl=$dir.GetAccessControl($accessSections)
  $acl.SetAccessRuleProtection($true,$false)
  foreach($rule in @($acl.Access)) {$acl.RemoveAccessRuleSpecific($rule)}
  $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $allow=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($allow)
  $dir.SetAccessControl($acl)
  $after=$dir.GetAccessControl($accessSections)
  $owner=$dir.GetAccessControl($ownerSections).GetOwner([Security.Principal.SecurityIdentifier]).Value
  if (-not $after.AreAccessRulesProtected -or $owner -ne $sid.Value) {throw 'ACL not protected'}
  $rules=@($after.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1) {throw 'unexpected ACL count'}
  foreach($rule in $rules) {
    if ($rule.IsInherited -or $rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit)) {throw 'unexpected ACL'}
  }
  [Console]::Out.Write('SIWC_STORAGE_ACL_OK')
} catch {
  [Console]::Error.Write('SIWC_STORAGE_ACL_FAILED')
  exit 7
}
`;
const encoded=Buffer.from(SCRIPT,'utf16le').toString('base64');
function noSymlinks(path:string):void {let p=resolve(path);const root=parse(p).root;while(p!==root){try{if(lstatSync(p).isSymbolicLink())throw new SiwcBlocked('SIWC_STORAGE_SYMLINK_DENIED',403);}catch(e){if(e instanceof SiwcBlocked)throw e;const x=e as NodeJS.ErrnoException;if(x.code!=='ENOENT')throw new SiwcBlocked('SIWC_STORAGE_PATH_UNAVAILABLE',403);}p=dirname(p);}}
export async function prepareWindowsStorage(path:string):Promise<void>{
 if(platform()!=='win32')throw new SiwcBlocked('SIWC_WINDOWS_STORAGE_ONLY',503);noSymlinks(path);
 const sys=process.env.SystemRoot??'C:\\Windows';
 const executable=sys+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
 await new Promise<void>((res,rej)=>{
  const proc=spawn(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{SystemRoot:sys,WINDIR:sys,PATH:''}});
  let out='',errLen=0,done=false;
  const fail=()=>{if(done)return;done=true;proc.kill();rej(new SiwcBlocked('SIWC_STORAGE_ACL_UNVERIFIED',503));};
  const timer=setTimeout(fail,15000);timer.unref();
  proc.stdout.setEncoding('ascii');proc.stdout.on('data',(part:string)=>{out+=part;if(out.length>64)fail();});
  proc.stderr.on('data',(part:Buffer)=>{errLen+=part.length;if(errLen>4096)fail();});
  proc.on('error',fail);proc.on('close',(code)=>{clearTimeout(timer);if(done)return;done=true;if(code!==0||errLen||out!=='SIWC_STORAGE_ACL_OK')rej(new SiwcBlocked('SIWC_STORAGE_ACL_UNVERIFIED',503));else res();});
  proc.stdin.on('error',fail);proc.stdin.end(Buffer.from(resolve(path),'utf8').toString('base64')+'\n','ascii');
 });
 noSymlinks(path);
}
