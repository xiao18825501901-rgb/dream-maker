import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const parent=resolve(root,'.runtime/siwc-acl-probes');mkdirSync(parent,{recursive:true});
const target=mkdtempSync(resolve(parent,'synthetic-'));
const script=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$path=[Console]::In.ReadLine();$dir=New-Object IO.DirectoryInfo($path)
foreach($scope in @('All','Access, Owner, Group')){try{$acl=$dir.GetAccessControl([Security.AccessControl.AccessControlSections]$scope);[Console]::Out.WriteLine($scope+':AVAILABLE')}catch{[Console]::Out.WriteLine($scope+':'+$_.Exception.GetType().Name+':'+$_.Exception.HResult)}}`;
try {
 const sys=process.env.SystemRoot??'C:\\Windows';
 const r=spawnSync(sys+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
  {env:{SystemRoot:sys,WINDIR:sys,PATH:''},input:target+'\n',encoding:'utf8',timeout:15000,windowsHide:true});
 console.log(JSON.stringify({exitCode:r.status,safeScopeResults:r.stdout.trim().split(/\r?\n/),stderrBytes:Buffer.byteLength(r.stderr??'')}));
}finally{if(dirname(target)!==parent)throw Error('CLEANUP_SCOPE_DENIED');rmSync(target,{recursive:true,force:true});}
