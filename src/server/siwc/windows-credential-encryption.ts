import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { Encryption } from './types.js';

/** CurrentUser DPAPI bridge. Powershell receives *only base64 stdin*, never secrets in args, env or logs.
 * The Powershell source is immutable; it invokes only Windows ProtectedData, not OAuth.
 * Windows ACL and reboot/second-user tests must be done on Windows before enabling real credentials.
 */
const DPAPI_SIWU_ENTROPY = 'dream-maker-siwc-dpapi-v1';
/**
 * The PowerShell source is generated once per entropy label. Each product namespace gets its own
 * entropy so a ciphertext written by one feature cannot be decrypted by another (DPAPI alone would
 * happily do that under the same user).
 */
const POWERSHELL_TEMPLATE = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try {
  Add-Type -AssemblyName System.Security
  $operation=[Console]::In.ReadLine()
  $line=[Console]::In.ReadLine()
  if ($null -eq $line -or $line.Length -gt 24000000) { throw 'invalid input' }
  $bytes=[Convert]::FromBase64String($line)
  $scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser
  $entropy=[Convert]::FromBase64String('__ENTROPY_B64__')
  if ($operation -eq 'encrypt') {
    $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,$scope)
  } elseif ($operation -eq 'decrypt') {
    $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,$scope)
  } else { throw 'bad operation' }
  [Console]::Out.Write([Convert]::ToBase64String($result))
  [Array]::Clear($bytes,0,$bytes.Length)
  [Array]::Clear($result,0,$result.Length)
} catch {
  [Console]::Error.Write('DPAPI_OPERATION_FAILED')
  exit 7
}
`;
const powershellFor = (entropy: string): string => POWERSHELL_TEMPLATE.replace('__ENTROPY_B64__', Buffer.from(entropy, 'utf8').toString('base64'));
// Strict arguments ensure the script never evaluates anything derived from plaintext.
const encodedFor = (entropy: string): string => Buffer.from(powershellFor(entropy), 'utf16le').toString('base64');
interface OSOptions { systemRoot?:string; platform?:NodeJS.Platform; timeoutMs?:number; entropy?:string; runner?: (operation:'encrypt'|'decrypt',input:Uint8Array)=>Promise<Uint8Array> }
export function createWindowsCredentialEncryption(options:OSOptions={}):Encryption {
 const os = options.platform??platform();
 const path = `${options.systemRoot??process.env.SystemRoot??'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
 const timeout=options.timeoutMs??12000;
 const encoded=encodedFor(options.entropy??DPAPI_SIWU_ENTROPY);
 const run = options.runner??(async(operation:'encrypt'|'decrypt',input:Uint8Array):Promise<Uint8Array>=>{
  if(os!=='win32')throw new Error('DPAPI_UNAVAILABLE');
  if(input.byteLength>8*1024*1024)throw new Error('DPAPI_INPUT_TOO_LARGE');
  return new Promise<Uint8Array>((resolve,reject)=>{
   const child=spawn(path,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot: options.systemRoot??process.env.SystemRoot??'C:\\Windows',WINDIR:options.systemRoot??process.env.SystemRoot??'C:\\Windows',PATH:'',TEMP:process.env.TEMP,TMP:process.env.TMP,TMPDIR:process.env.TMPDIR}});
   let stdout='';let stderrSize=0,settled=false;
   const terminate=(reason:string)=>{if(settled)return;settled=true;child.kill();reject(new Error(reason));};
   const timer=setTimeout(()=>terminate('DPAPI_TIMEOUT'),timeout);timer.unref();
   child.stdout.setEncoding('ascii');child.stdout.on('data',(x:string)=>{stdout+=x;if(stdout.length>12*1024*1024)terminate('DPAPI_OUTPUT_TOO_LARGE');});
   child.stderr.on('data',(chunk:Buffer)=>{stderrSize+=chunk.length;if(stderrSize>4096)terminate('DPAPI_FAILURE');});
   child.on('error',()=>{clearTimeout(timer);terminate('DPAPI_UNAVAILABLE');});
   child.on('close',(code)=>{clearTimeout(timer);if(settled)return;settled=true;
    if(code!==0||stderrSize||!stdout||!/^[A-Za-z0-9+/]+={0,2}$/.test(stdout))return reject(new Error('DPAPI_FAILURE'));
    try{resolve(Buffer.from(stdout,'base64'));}catch{reject(new Error('DPAPI_FAILURE'));}
   });
   child.stdin.on('error',()=>terminate('DPAPI_STDIN_FAILURE'));
   child.stdin.end(operation+'\n'+Buffer.from(input).toString('base64')+'\n','ascii');
  });
 });
 return {id:'windows-dpapi-current-user-v1',isAvailable:async()=>{
   if(os!=='win32')return false;
   // Never treat a filename check as evidence of working OS storage.
   try { const test=Buffer.from('DM-SIWC-DPAPI-SELFTEST','utf8');const ciphertext=await run('encrypt',test);const plain=await run('decrypt',ciphertext);return Buffer.from(plain).equals(test); }catch{return false;}
  },encrypt:async text=>{
   if(os!=='win32')throw new Error('DPAPI_UNAVAILABLE');return run('encrypt',Buffer.from(text,'utf8'));
  },decrypt:async bytes=>{
   if(os!=='win32')throw new Error('DPAPI_UNAVAILABLE');return Buffer.from(await run('decrypt',bytes)).toString('utf8');
  }};
}
