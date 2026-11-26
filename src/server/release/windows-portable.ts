import {createHash} from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,openSync,readSync,closeSync,fstatSync
} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {isWindowsPackageSegment} from './windows-package-path.js';

export interface PortableFile {path:string;bytes:number;sha256:string}
export interface PortableManifest {
  schema:'dream-maker.windows-portable.v1';
  product:'DreamMaker Suite';
  version:string;
  head:string;
  nodeVersion:string;
  builtAt:string;
  scope:'CORE_LOCAL_UI_AND_PROJECT_STATE_NOT_FULL_NATIVE_RELEASE';
  sourceHash:string|null;
  capabilities:Record<string,'AVAILABLE'|'NOT_BUNDLED'|boolean>;
  files:PortableFile[];
  filesHash:string;
}

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const HASH=/^[a-f0-9]{64}$/;
const UTF8_BOM=Buffer.from([0xef,0xbb,0xbf]);
const windowsPowerShell=(value:string)=>Buffer.concat([UTF8_BOM,Buffer.from(value,'utf8')]);
const OPTIONAL_CONFIGS=[
  'config/local.example.json',
  'config/dsh-native.example.json',
  'config/native-audit.example.json',
  'config/native-owner.example.json',
  'config/custom-account-sources.example.json',
  'config/codex-agent-readonly.toml',
  'config/codex-agent-windows-readonly.toml',
  'config/codex-supervisor-windows.toml'
];
const REQUIRED_TREES=['dist','prompts','migrations','adapters','skills','scripts/isolation'];
const PREWORK_PUBLIC_ASSETS=[
  'contracts/DM_PREWORK_HANDOFF_V1.schema.json',
  'examples/prework/synthetic-handoff.json',
  'docs/prework/PREWORK_USER_GUIDE_CN.md'
];
const DEMO_PUBLIC_ASSETS=['scripts/verify-board.mjs',...['index.html','style.css','board.mjs','app.mjs','README.md'].map(name=>'examples/study-board/'+name)];
const DENY=/(^|\/)(?:\.env[^/]*|local\.json|native-owner\.local\.json|\.runtime|\.wsl|codex-home|credentials?|tokens?|auth[^/]*|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(?:\/|$)|\.py[co]$/i;
const MAX_FILE=256*1024*1024;
const MAX_FILES=20_000;

export function safePortablePath(value:string):string {
  if(typeof value!=='string'||!value||value.length>400||value.includes('\\')||value.includes('\0')||
    value.startsWith('/')||/^[A-Za-z]:/.test(value))throw new Error('PORTABLE_PATH_INVALID');
  const parts=value.split('/');
  if(parts.some(part=>!isWindowsPackageSegment(part))||DENY.test(value))throw new Error('PORTABLE_PATH_INVALID');
  return value;
}

export function createPortableManifest(input:{
  version:string;head:string;nodeVersion:string;builtAt?:string;sourceHash?:string|null;
  files:{path:string;bytes:number;sha256:string}[];
}):PortableManifest {
  if(typeof input.version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(input.version))throw new Error('PORTABLE_VERSION_INVALID');
  if(typeof input.head!=='string'||!/^[a-f0-9]{7,64}$/.test(input.head))throw new Error('PORTABLE_HEAD_INVALID');
  if(typeof input.nodeVersion!=='string'||!/^v\d+\.\d+\.\d+$/.test(input.nodeVersion))throw new Error('PORTABLE_NODE_VERSION_INVALID');
  if(input.sourceHash!==undefined&&input.sourceHash!==null&&!HASH.test(input.sourceHash))throw new Error('PORTABLE_SOURCE_HASH_INVALID');
  if(!Array.isArray(input.files)||!input.files.length||input.files.length>MAX_FILES)throw new Error('PORTABLE_FILES_INVALID');
  const seen=new Set<string>(),files=input.files.map(file=>{
    const path=safePortablePath(file.path);
    const identity=path.normalize('NFC').toLocaleLowerCase('en-US');
    if(seen.has(identity))throw new Error('PORTABLE_FILE_DUPLICATE');
    if(!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>MAX_FILE)throw new Error('PORTABLE_FILE_SIZE_INVALID');
    if(typeof file.sha256!=='string'||!HASH.test(file.sha256))throw new Error('PORTABLE_FILE_HASH_INVALID');
    seen.add(identity);return{path,bytes:file.bytes,sha256:file.sha256};
  }).sort((a,b)=>a.path.localeCompare(b.path,'en'));
  const builtAt=input.builtAt??new Date().toISOString();
  if(Number.isNaN(Date.parse(builtAt)))throw new Error('PORTABLE_TIME_INVALID');
  return{
    schema:'dream-maker.windows-portable.v1',
    product:'DreamMaker Suite',
    version:input.version,
    head:input.head,
    nodeVersion:input.nodeVersion,
    builtAt,
    scope:'CORE_LOCAL_UI_AND_PROJECT_STATE_NOT_FULL_NATIVE_RELEASE',
    sourceHash:input.sourceHash??null,
    capabilities:{
      demoUi:'AVAILABLE',
      localProjectState:'AVAILABLE',
      nativeRoleRuntimes:'NOT_BUNDLED',
      planner1CloudRuntime:'NOT_BUNDLED',
      dshRuntime:'NOT_BUNDLED',
      codexRuntime:'NOT_BUNDLED',
      magpieCustomRuntime:'NOT_BUNDLED',
      layaRuntime:'NOT_BUNDLED',
      redistributionReviewed:false,
      cleanWindowsVerified:false
    },
    files,
    filesHash:sha(JSON.stringify(files))
  };
}

function contained(root:string,path:string):void {
  const name=relative(resolve(root),resolve(path));
  if(!name||name==='..'||name.startsWith('..'+sep)||resolve(path)===resolve(root))throw new Error('PORTABLE_OUTPUT_ESCAPE');
}

function fileEntry(root:string,path:string):PortableFile {
  const full=resolve(root,path),stat=lstatSync(full);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_FILE)throw new Error('PORTABLE_SOURCE_INVALID');
  return{path:safePortablePath(path),...hashPortableFile(full)};
}

/** Bounded hashing also covers the bundled Node executable; never buffer it whole. */
function hashPortableFile(path:string):{bytes:number;sha256:string}{
  const fd=openSync(path,'r');
  try{
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size>MAX_FILE)throw new Error('PORTABLE_SOURCE_INVALID');
    const buffer=Buffer.allocUnsafe(Math.max(1,Math.min(stat.size,1024*1024))),digest=createHash('sha256');let bytes=0;
    for(;;){const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;bytes+=n;
      if(bytes>MAX_FILE)throw new Error('PORTABLE_FILE_SIZE_INVALID');digest.update(buffer.subarray(0,n));}
    return{bytes,sha256:digest.digest('hex')};
  }finally{closeSync(fd);}
}

function copyStable(sourceRoot:string,targetRoot:string,path:string,manifestPath=path):PortableFile {
  safePortablePath(path);
  safePortablePath(manifestPath);
  const from=resolve(sourceRoot,path),to=resolve(targetRoot,path);
  contained(sourceRoot,from);contained(targetRoot,to);
  const before=lstatSync(from);
  if(!before.isFile()||before.isSymbolicLink()||before.size>MAX_FILE)throw new Error('PORTABLE_SOURCE_INVALID');
  mkdirSync(dirname(to),{recursive:true});
  copyFileSync(from,to);
  const source=hashPortableFile(from),target=hashPortableFile(to),after=statSync(from);
  if(source.sha256!==target.sha256||source.bytes!==before.size||target.bytes!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('PORTABLE_SOURCE_CHANGED');
  return{path:manifestPath,bytes:target.bytes,sha256:target.sha256};
}

function walk(sourceRoot:string,tree:string,out:string[]):void {
  const folder=resolve(sourceRoot,tree),stat=lstatSync(folder);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('PORTABLE_SOURCE_INVALID');
  for(const entry of readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
    const path=`${tree}/${entry.name}`;
    if(DENY.test(path))continue;
    if(entry.isSymbolicLink())throw new Error('PORTABLE_SYMLINK_DENIED');
    if(entry.isDirectory())walk(sourceRoot,path,out);
    else if(entry.isFile())out.push(path);
    else throw new Error('PORTABLE_SOURCE_INVALID');
  }
}

function launcher(product:'dream-maker'|'dreamflow'):string {
  const name=product==='dreamflow'?'DreamFlow':'Dream Maker';
  const main=product==='dreamflow'?'dreamflow-main.js':'main.js';
  const defaultPort=product==='dreamflow'?4318:4317;
  return `param(
  [ValidateRange(0,65535)][int]$Port=${defaultPort},
  [switch]$NoBrowser
)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$app=Join-Path $root 'app'
$data=Join-Path $root 'data\\${product}'
$temp=Join-Path $root 'temp'
New-Item -ItemType Directory -Force -Path $data,$temp | Out-Null
$env:DM_DATA_DIR=$data
$env:DM_CONFIG=Join-Path $data 'config\\local.json'
$env:DM_PORT=[string]$Port
$env:TEMP=$temp
$env:TMP=$temp
$node=Join-Path $root 'runtime\\node.exe'
$main=Join-Path $app 'dist\\server\\${main}'
if($NoBrowser){
  Push-Location $app
  try{
    & $node $main
    $code=$LASTEXITCODE
  }finally{
    Pop-Location
  }
  exit $code
}
$stamp=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$stdout=Join-Path $data ("startup-$stamp.stdout.log")
$stderr=Join-Path $data ("startup-$stamp.stderr.log")
$process=Start-Process -FilePath $node -ArgumentList ('"'+$main.Replace('"','\\"')+'"') -WorkingDirectory $app -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$url=$null
try{
  for($i=0;$i -lt 120;$i++){
    if(Test-Path -LiteralPath $stdout){
      $text=Get-Content -LiteralPath $stdout -Raw
      if(-not [string]::IsNullOrEmpty($text)){
        $match=[regex]::Match($text,'http://127\\.0\\.0\\.1:\\d+/(?:\\?bootstrap=|#bootstrap=)[A-Za-z0-9_-]+')
        if($match.Success){$url=$match.Value;break}
      }
    }
    if($process.HasExited){break}
    Start-Sleep -Milliseconds 250
  }
  if(-not $url){
    $detail=if(Test-Path -LiteralPath $stderr){Get-Content -LiteralPath $stderr -Raw}else{'启动进程没有输出可用地址。'}
    throw ('${name} 未能启动。'+$detail)
  }
  Start-Process $url
  Write-Host '${name} 已在本地启动。关闭此窗口会停止程序。'
  Write-Host '如浏览器没有自动打开，请使用启动窗口之后打印的本地地址。'
  Wait-Process -Id $process.Id
}finally{
  if(-not $process.HasExited){Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue;Wait-Process -Id $process.Id -ErrorAction SilentlyContinue}
  Remove-Item -LiteralPath $stdout -Force -ErrorAction SilentlyContinue
}
`;
}

const VERIFY_SCRIPT=`import {fileURLToPath} from 'node:url';
import {verifyPortableDirectory} from './app/dist/server/release/windows-portable.js';
const value=await verifyPortableDirectory(fileURLToPath(new URL('.',import.meta.url)));
console.log(JSON.stringify(value,null,2));
`;

const VERIFY_PS=`$ErrorActionPreference='Stop'
$root=$PSScriptRoot
& (Join-Path $root 'runtime\\node.exe') (Join-Path $root 'verify-portable.mjs') (Join-Path $root '.')
exit $LASTEXITCODE
`;

const MANAGE_SCRIPT=`import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {
  installPortableDirectory,
  readInstallationState,
  rollbackPortableDirectory,
  uninstallPortableDirectory,
  updatePortableDirectory
} from './app/dist/server/release/windows-installation.js';
import {verifyPortableDirectory} from './app/dist/server/release/windows-portable.js';

const packageRoot=fileURLToPath(new URL('.',import.meta.url));
const action=process.argv[2];
function value(name){
  const index=process.argv.indexOf(name);
  if(index<0)return null;
  if(index+1>=process.argv.length)throw new Error('INSTALLATION_ARGUMENT_MISSING:'+name);
  return process.argv[index+1];
}
function target(){
  const result=value('--target');
  if(!result)throw new Error('INSTALLATION_TARGET_REQUIRED');
  return resolve(result);
}
let result;
if(action==='install')result=await installPortableDirectory({sourceRoot:packageRoot,installRoot:target()});
else if(action==='update')result=await updatePortableDirectory({sourceRoot:value('--source')??packageRoot,installRoot:target()});
else if(action==='rollback')result=await rollbackPortableDirectory({installRoot:target()});
else if(action==='uninstall')result=await uninstallPortableDirectory({installRoot:target()});
else if(action==='status'){
  const installRoot=target();
  result={state:readInstallationState(installRoot),verification:await verifyPortableDirectory(installRoot)};
}else throw new Error('INSTALLATION_ACTION_INVALID');
console.log(JSON.stringify(result,null,2));
`;

const SETUP_SCRIPT=`[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$InstallDir,
  [switch]$CreateShortcuts
)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$target=[IO.Path]::GetFullPath($InstallDir)
& (Join-Path $root 'runtime\\node.exe') (Join-Path $root 'manage-installation.mjs') install --target $target
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
if($CreateShortcuts){
  & (Join-Path $root 'Manage-Shortcuts.ps1') -Action Create -InstallDir $target
}
Write-Host ('DreamMaker Suite 已安装到 '+$target)
`;

const UPDATE_SCRIPT=`[CmdletBinding()]
param([Parameter(Mandatory)][string]$InstallDir)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$target=[IO.Path]::GetFullPath($InstallDir)
& (Join-Path $root 'runtime\\node.exe') (Join-Path $root 'manage-installation.mjs') update --target $target
exit $LASTEXITCODE
`;

const ROLLBACK_SCRIPT=`[CmdletBinding()]
param([Parameter(Mandatory)][string]$InstallDir)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$target=[IO.Path]::GetFullPath($InstallDir)
& (Join-Path $root 'runtime\\node.exe') (Join-Path $root 'manage-installation.mjs') rollback --target $target
exit $LASTEXITCODE
`;

const UNINSTALL_SCRIPT=`[CmdletBinding()]
param([Parameter(Mandatory)][string]$InstallDir)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$target=[IO.Path]::GetFullPath($InstallDir)
& (Join-Path $root 'runtime\\node.exe') (Join-Path $root 'manage-installation.mjs') uninstall --target $target
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
& (Join-Path $root 'Manage-Shortcuts.ps1') -Action Remove -InstallDir $target
`;

const MANAGE_SHORTCUTS_SCRIPT=`[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('Create','Remove')][string]$Action,
  [Parameter(Mandatory)][string]$InstallDir,
  [string]$ShortcutRoot=''
)
$ErrorActionPreference='Stop'
if([string]::IsNullOrWhiteSpace($ShortcutRoot)){
  if([string]::IsNullOrWhiteSpace($env:APPDATA)){throw 'SHORTCUT_APPDATA_MISSING'}
  $ShortcutRoot=Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'
}
$target=[IO.Path]::GetFullPath($InstallDir)
$root=[IO.Path]::GetFullPath($ShortcutRoot)
$folder=Join-Path $root 'DreamMaker Suite'
$entries=@(
  [pscustomobject]@{Name='Dream Maker';Script='Start-DreamMaker.ps1'},
  [pscustomobject]@{Name='DreamFlow';Script='Start-DreamFlow.ps1'}
)
$script:Shell=$null
function Get-Shell {
  if($null -eq $script:Shell){$script:Shell=New-Object -ComObject WScript.Shell}
  return $script:Shell
}
function Get-PowerShell {
  $value=(Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
  if(-not $value){$value=(Get-Command powershell.exe -ErrorAction Stop).Source}
  return [IO.Path]::GetFullPath($value)
}
function Assert-RegularDirectory([string]$path,[string]$code){
  if(-not (Test-Path -LiteralPath $path)){return}
  $item=Get-Item -LiteralPath $path -Force
  if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){
    throw $code+':'+$path
  }
}
function Get-Arguments([string]$scriptName){
  return '-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $target $scriptName)+'"'
}
function Read-Shortcut([string]$path){
  $item=Get-Item -LiteralPath $path -Force
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){
    throw 'SHORTCUT_LINK_INVALID:'+$path
  }
  $shortcut=(Get-Shell).CreateShortcut($path)
  return [pscustomobject]@{
    TargetPath=[string]$shortcut.TargetPath
    Arguments=[string]$shortcut.Arguments
    WorkingDirectory=[string]$shortcut.WorkingDirectory
  }
}
function Test-OwnedShortcut([string]$path,[string]$scriptName){
  if(-not (Test-Path -LiteralPath $path -PathType Leaf)){return $false}
  $link=Read-Shortcut $path
  $targetName=[IO.Path]::GetFileName($link.TargetPath)
  $shellTarget=$targetName -ieq 'pwsh.exe' -or $targetName -ieq 'powershell.exe'
  return $shellTarget -and $link.Arguments -eq (Get-Arguments $scriptName) -and $link.WorkingDirectory -eq $target
}
Assert-RegularDirectory $root 'SHORTCUT_ROOT_INVALID'
Assert-RegularDirectory $folder 'SHORTCUT_FOLDER_INVALID'
if($Action -eq 'Create'){
  foreach($entry in $entries){
    $program=Join-Path $target $entry.Script
    if(-not (Test-Path -LiteralPath $program -PathType Leaf)){throw 'SHORTCUT_PROGRAM_MISSING:'+$program}
  }
  $powerShell=Get-PowerShell
  if(Test-Path -LiteralPath $folder){
    foreach($entry in $entries){
      $path=Join-Path $folder ($entry.Name+'.lnk')
      if(Test-Path -LiteralPath $path){
        if(-not (Test-OwnedShortcut $path $entry.Script)){
          throw 'SHORTCUT_TARGET_CONFLICT:'+$path
        }
      }
    }
  }else{
    New-Item -ItemType Directory -Path $folder | Out-Null
  }
  $created=[Collections.Generic.List[string]]::new()
  $reused=0
  try{
    foreach($entry in $entries){
      $path=Join-Path $folder ($entry.Name+'.lnk')
      if(Test-Path -LiteralPath $path){
        $reused++
        continue
      }
      $shortcut=(Get-Shell).CreateShortcut($path)
      $shortcut.TargetPath=$powerShell
      $shortcut.Arguments=Get-Arguments $entry.Script
      $shortcut.WorkingDirectory=$target
      $shortcut.Description='DreamMaker Suite - '+$entry.Name
      $shortcut.Save()
      $created.Add($path)
      if(-not (Test-OwnedShortcut $path $entry.Script)){throw 'SHORTCUT_VERIFY_FAILED:'+$path}
    }
    [pscustomobject]@{
      schema='dream-maker.windows-shortcuts.v1'
      action='Create'
      folder=$folder
      created=@($created)
      reused=$reused
      verified=$true
    } | ConvertTo-Json -Compress
  }catch{
    foreach($path in $created){
      if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Force}
    }
    throw
  }
}else{
  $removed=[Collections.Generic.List[string]]::new()
  if(Test-Path -LiteralPath $folder){
    foreach($entry in $entries){
      $path=Join-Path $folder ($entry.Name+'.lnk')
      if(Test-OwnedShortcut $path $entry.Script){
        Remove-Item -LiteralPath $path -Force
        $removed.Add($path)
      }
    }
    if(-not (Get-ChildItem -LiteralPath $folder -Force | Select-Object -First 1)){
      Remove-Item -LiteralPath $folder -Force
    }
  }
  [pscustomobject]@{
    schema='dream-maker.windows-shortcuts.v1'
    action='Remove'
    folder=$folder
    removed=@($removed)
  } | ConvertTo-Json -Compress
}
`;

const STATUS_SCRIPT=`[CmdletBinding()]
param([Parameter(Mandatory)][string]$InstallDir)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$target=[IO.Path]::GetFullPath($InstallDir)
& (Join-Path $root 'runtime\\node.exe') (Join-Path $root 'manage-installation.mjs') status --target $target
exit $LASTEXITCODE
`;

const README=`# DreamMaker Suite Windows 核心便携包

这是可复制、可校验的 **本地核心包**，包含 Dream Maker、独立 DreamFlow、项目状态、
界面、提示词、数据库迁移、Windows 辅助脚本和专用 Node 运行时。

## 可以做什么

- 启动两款产品并浏览、创建 Demo 项目、保存本地草稿和项目状态。
- 使用现有的本地认证、CSRF、幂等和数据库保护代码。
- 选择复制到其他目录；安装器和启动器不会请求管理员权限。

## 当前没有打入的内容

- Codex、DSH、Archon、Magpie、Laya、Kimi/OpenAI/DeepSeek 凭据或模型。
- 任何用户数据库、日志、浏览器资料、认证缓存或共享配置。

因此这个包不能宣称四个真实角色、Custom/Magpie、Laya、清洁 Windows 安装或
再分发许可已经完成。真实运行器必须另行取得明确授权和许可材料后加入。

## 使用

1. 运行 \`Verify-Portable.ps1\` 核对所有文件。
2. 直接运行 \`Start-DreamMaker.ps1\` 或 \`Start-DreamFlow.ps1\`。
3. 如需复制安装，运行：

   \`\`\`powershell
   .\\Setup-DreamMakerSuite.ps1 -InstallDir "D:\\Apps\\DreamMakerSuite"
   \`\`\`

安装器默认不创建快捷方式；只有明确加入 \`-CreateShortcuts\` 才会在当前用户的
开始菜单建立 Dream Maker 和 DreamFlow 入口。同名入口指向其他安装目录时拒绝覆盖。
卸载只清理确实指向本次安装目录的本产品入口，不删除其他快捷方式。

## 升级、回滚、状态和卸载

升级时从**新版本便携包**运行：

\`\`\`powershell
.\\Update-DreamMakerSuite.ps1 -InstallDir "D:\\Apps\\DreamMakerSuite"
\`\`\`

升级会先核对新旧包、确认两款产品都没有活动锁，再把旧程序保留为同一磁盘上的
回滚目录。\`data\` 和 \`temp\` 不随旧程序保留，而是整体移动到新程序目录。

\`\`\`powershell
.\\Get-DreamMakerSuiteStatus.ps1 -InstallDir "D:\\Apps\\DreamMakerSuite"
.\\Rollback-DreamMakerSuite.ps1 -InstallDir "D:\\Apps\\DreamMakerSuite"
.\\Uninstall-DreamMakerSuite.ps1 -InstallDir "D:\\Apps\\DreamMakerSuite"
\`\`\`

卸载会移除程序代码，但把项目数据和临时目录移动到同盘、名称打印在结果中的
\`userdata\` 目录。该命令没有“强制删除用户数据”参数；需要清理时由用户核对路径后
另行处理。
`;

export interface BuildPortableOptions {
  sourceRoot:string;nodeRoot:string;output:string;version:string;head:string;nodeVersion:string;builtAt?:string;sourceHash?:string|null;
}

export async function buildPortableDirectory(options:BuildPortableOptions):Promise<{output:string;files:number;filesHash:string;manifestHash:string}> {
  const output=resolve(options.output);
  if(existsSync(output))throw new Error('PORTABLE_OUTPUT_EXISTS');
  const demoEnabled=existsSync(resolve(options.sourceRoot,'dist/server/demo.js'));
  if(demoEnabled)for(const path of DEMO_PUBLIC_ASSETS){
    if(!existsSync(resolve(options.sourceRoot,path)))throw new Error('PORTABLE_DEMO_ASSET_MISSING:'+path);
  }
  const preworkEnabled=existsSync(resolve(options.sourceRoot,'dist/server/prework/runtime.js'))||existsSync(resolve(options.sourceRoot,'migrations/009_prework_records.sql'));
  if(preworkEnabled)for(const path of [...PREWORK_PUBLIC_ASSETS,'migrations/009_prework_records.sql','dist/server/prework/runtime.js']){
    if(!existsSync(resolve(options.sourceRoot,path)))throw new Error('PORTABLE_PREWORK_ASSET_MISSING:'+path);
  }
  const temporary=output+'.partial-'+process.pid+'-'+Date.now();
  if(existsSync(temporary))throw new Error('PORTABLE_TEMP_EXISTS');
  const files:PortableFile[]=[];
  const addBuffer=(path:string,data:Buffer|string)=>{
    const safe=safePortablePath(path),buffer=Buffer.isBuffer(data)?data:Buffer.from(data,'utf8');
    if(buffer.length>MAX_FILE)throw new Error('PORTABLE_FILE_SIZE_INVALID');
    const target=resolve(temporary,safe);contained(temporary,target);
    mkdirSync(dirname(target),{recursive:true});writeFileSync(target,buffer,{flag:'wx'});
    files.push({path:safe,bytes:buffer.length,sha256:sha(buffer)});
  };
  const addPowerShell=(path:string,data:string)=>{
    const safe=safePortablePath(path),buffer=windowsPowerShell(data);
    if(buffer.length>MAX_FILE)throw new Error('PORTABLE_FILE_SIZE_INVALID');
    const target=resolve(temporary,safe);contained(temporary,target);
    mkdirSync(dirname(target),{recursive:true});writeFileSync(target,buffer,{flag:'wx'});
    files.push({path:safe,bytes:buffer.length,sha256:sha(buffer)});
  };
  try{
    mkdirSync(dirname(output),{recursive:true});
    mkdirSync(temporary,{recursive:false});
    for(const tree of REQUIRED_TREES){
      if(!existsSync(resolve(options.sourceRoot,tree)))throw new Error('PORTABLE_REQUIRED_TREE_MISSING');
      const paths:string[]=[];walk(options.sourceRoot,tree,paths);
      for(const path of paths)files.push(copyStable(options.sourceRoot,join(temporary,'app'),path,`app/${path}`));
    }
    files.push(copyStable(options.sourceRoot,join(temporary,'app'),'package.json','app/package.json'));
    if(demoEnabled)for(const path of DEMO_PUBLIC_ASSETS)files.push(copyStable(options.sourceRoot,join(temporary,'app'),path,`app/${path}`));
    if(preworkEnabled)for(const path of PREWORK_PUBLIC_ASSETS)files.push(copyStable(options.sourceRoot,join(temporary,'app'),path,`app/${path}`));
    for(const path of OPTIONAL_CONFIGS)if(existsSync(resolve(options.sourceRoot,path)))files.push(copyStable(options.sourceRoot,join(temporary,'app'),path,`app/${path}`));
    for(const name of ['node.exe','LICENSE']){
      if(!existsSync(resolve(options.nodeRoot,name)))throw new Error('PORTABLE_NODE_RUNTIME_MISSING');
      const from=resolve(options.nodeRoot,name),to=resolve(temporary,'runtime',name);
      contained(options.nodeRoot,from);contained(temporary,to);
      mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to);files.push(fileEntry(temporary,`runtime/${name}`));
    }
    addPowerShell('Start-DreamMaker.ps1',launcher('dream-maker'));
    addPowerShell('Start-DreamFlow.ps1',launcher('dreamflow'));
    addPowerShell('Manage-Shortcuts.ps1',MANAGE_SHORTCUTS_SCRIPT);
    addPowerShell('Setup-DreamMakerSuite.ps1',SETUP_SCRIPT);
    addPowerShell('Update-DreamMakerSuite.ps1',UPDATE_SCRIPT);
    addPowerShell('Rollback-DreamMakerSuite.ps1',ROLLBACK_SCRIPT);
    addPowerShell('Uninstall-DreamMakerSuite.ps1',UNINSTALL_SCRIPT);
    addPowerShell('Get-DreamMakerSuiteStatus.ps1',STATUS_SCRIPT);
    addPowerShell('Verify-Portable.ps1',VERIFY_PS);
    addBuffer('verify-portable.mjs',VERIFY_SCRIPT);
    addBuffer('manage-installation.mjs',MANAGE_SCRIPT);
    addBuffer('README_CN.md',README+(preworkEnabled?'\n## 开始前检查（Prework）\n\n使用说明：`app/docs/prework/PREWORK_USER_GUIDE_CN.md`。合同和明确标注的合成样例在 `app/contracts` 与 `app/examples/prework`。这不代表真实角色、服务资格或最终成果已通过验收。\n':''));
    const manifest=createPortableManifest({...options,builtAt:options.builtAt??new Date().toISOString(),files});
    const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
    writeFileSync(join(temporary,'RELEASE_MANIFEST.json'),manifestBytes,{flag:'wx'});
    const sums=[...manifest.files,{path:'RELEASE_MANIFEST.json',bytes:manifestBytes.length,sha256:sha(manifestBytes)}]
      .sort((a,b)=>a.path.localeCompare(b.path,'en')).map(file=>`${file.sha256}  ${file.path}`).join('\n')+'\n';
    writeFileSync(join(temporary,'SHA256SUMS.txt'),sums,{flag:'wx'});
    renameSync(temporary,output);
    return{output,files:manifest.files.length,filesHash:manifest.filesHash,manifestHash:sha(manifestBytes)};
  }catch(error){
    if(existsSync(temporary))rmSync(temporary,{recursive:true,force:true});
    throw error;
  }
}

export async function verifyPortableDirectory(root:string):Promise<{status:'PASS_CORE_PORTABLE_ONLY';files:number;filesHash:string;manifestHash:string;capabilities:PortableManifest['capabilities']}> {
  const base=resolve(root),manifestPath=join(base,'RELEASE_MANIFEST.json');
  if(!existsSync(manifestPath))throw new Error('PORTABLE_MANIFEST_MISSING');
  const manifestBytes=readFileSync(manifestPath),raw=JSON.parse(manifestBytes.toString('utf8')) as PortableManifest;
  const normalized=createPortableManifest({version:raw.version,head:raw.head,nodeVersion:raw.nodeVersion,builtAt:raw.builtAt,sourceHash:raw.sourceHash,files:raw.files});
  if(JSON.stringify(normalized)!==JSON.stringify(raw))throw new Error('PORTABLE_MANIFEST_INVALID');
  for(const file of normalized.files){
    const path=resolve(base,file.path);contained(base,path);
    if(!existsSync(path))throw new Error('PORTABLE_FILE_MISSING');
    const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.bytes)throw new Error('PORTABLE_FILE_CHANGED');
    const actual=hashPortableFile(path);
    if(actual.bytes!==file.bytes||actual.sha256!==file.sha256)throw new Error('PORTABLE_FILE_CHANGED');
  }
  const lines=readFileSync(join(base,'SHA256SUMS.txt'),'utf8').split(/\r?\n/).filter(Boolean),sums=new Map<string,string>();
  for(const line of lines){const match=/^([a-f0-9]{64})  (.+)$/.exec(line);if(!match)throw new Error('PORTABLE_SUMS_INVALID');if(sums.has(match[2]))throw new Error('PORTABLE_SUMS_DUPLICATE');sums.set(match[2],match[1]);}
  for(const file of normalized.files)if(sums.get(file.path)!==file.sha256)throw new Error('PORTABLE_SUM_MISMATCH');
  if(sums.get('RELEASE_MANIFEST.json')!==sha(manifestBytes))throw new Error('PORTABLE_MANIFEST_SUM_MISMATCH');
  if(sums.size!==normalized.files.length+1)throw new Error('PORTABLE_SUMS_EXTRA');
  const expected=new Set([...normalized.files.map(file=>file.path),'RELEASE_MANIFEST.json','SHA256SUMS.txt'].map(path=>path.normalize('NFC').toLocaleLowerCase('en-US')));
  const verifyTree=(folder:string,prefix=''):void=>{
    for(const entry of readdirSync(folder,{withFileTypes:true})){
      const path=prefix?`${prefix}/${entry.name}`:entry.name,identity=path.normalize('NFC').toLocaleLowerCase('en-US');
      const full=join(folder,entry.name);
      if(entry.isSymbolicLink())throw new Error('PORTABLE_EXTRA_FILE');
      if(entry.isDirectory()){
        if(!prefix&&['data','temp'].includes(identity))continue;
        const marker=identity+'/';
        if(![...expected].some(candidate=>candidate.startsWith(marker)))throw new Error('PORTABLE_EXTRA_FILE');
        verifyTree(full,path);
      }else if(!entry.isFile()||!expected.has(identity))throw new Error('PORTABLE_EXTRA_FILE');
    }
  };
  verifyTree(base);
  return{status:'PASS_CORE_PORTABLE_ONLY',files:normalized.files.length,filesHash:normalized.filesHash,manifestHash:sha(manifestBytes),capabilities:normalized.capabilities};
}
