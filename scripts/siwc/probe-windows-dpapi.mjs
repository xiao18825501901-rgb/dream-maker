// Synthetic capabilities only; no real credentials, auth, policy or account changes.
import { spawnSync } from 'node:child_process';
const script=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$stage='assembly';try{
Add-Type -AssemblyName System.Security
$stage='encrypt';$data=[Text.Encoding]::UTF8.GetBytes('DM_SYNTHETIC_CAPABILITY_ONLY')
$entropy=[Text.Encoding]::UTF8.GetBytes('dream-maker-siwc-dpapi-v1')
$cipher=[Security.Cryptography.ProtectedData]::Protect($data,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
$stage='decrypt';$plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
if([Text.Encoding]::UTF8.GetString($plain)-ne 'DM_SYNTHETIC_CAPABILITY_ONLY'){throw 'synthetic mismatch'}
[Console]::Out.Write('DPAPI_SYNTHETIC_CAPABILITY_PASS')
}catch{[Console]::Out.Write($stage+':'+$_.Exception.GetType().Name+':'+$_.Exception.HResult);exit 7}`;
const sys=process.env.SystemRoot??'C:\\Windows';
const r=spawnSync(sys+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
 ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
 {env:{SystemRoot:sys,WINDIR:sys,PATH:''},encoding:'utf8',timeout:15000,windowsHide:true});
console.log(JSON.stringify({exitCode:r.status,safeStage:r.stdout.trim(),stderrBytes:Buffer.byteLength(r.stderr??''),error:r.error?.code??null}));
