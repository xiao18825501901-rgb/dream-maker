<#
.SYNOPSIS
  用 CA 证书给 DreamMaker 便携包里的可执行体签名。
.EXAMPLE
  .\Sign-DreamMaker.ps1 -Pfx D:\cert\my.pfx -Password (Read-Host -AsSecureString)
.EXAMPLE
  # ssl.com eSigner 云签名（私钥在云端 HSM，无本地 pfx）
  .\Sign-DreamMaker.ps1 -Thumbprint 84103C5B25954C9AF863191121AA853020F5BA64
#>
param(
  [string]$Package = "D:\DreamMakerSuite\dist-portable\DreamMakerSuite-Portable-0.1.0",
  [string]$Pfx,
  [securestring]$Password,
  [string]$Thumbprint,
  [string]$TimestampUrl = "http://timestamp.digicert.com",
  [switch]$UpdateManifest
  ,[string]$NodeScript = "D:\DreamMakerSuite\runtime\dm-inst\.runtime\resign.mjs"
)
$ErrorActionPreference = "Stop"
$signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe"
if (-not (Test-Path $signtool)) { throw "SIGNTOOL_MISSING: $signtool" }
# 时间戳服务可达性因机器/网络而异。实测过：这台机器 digicert / ts.ssl.com / sectigo / certum
# 全部返回 502（中间层拒绝），只有微软的 Authenticode TSA 可达。硬编码任何一个都会在
# 别人的机器上炸，所以先探测再签。
function Resolve-TimestampUrl([string]$preferred) {
  $candidates = @($preferred) + @(
    "http://timestamp.acs.microsoft.com",
    "http://ts.ssl.com",
    "http://timestamp.digicert.com",
    "http://timestamp.sectigo.com"
  )
  foreach ($u in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    try {
      $r = Invoke-WebRequest -Uri $u -Method Head -TimeoutSec 6 -UseBasicParsing -ErrorAction Stop
      if ($r.StatusCode -lt 500) { return $u }
    } catch { }
  }
  return $null
}
$resolvedTs = Resolve-TimestampUrl $TimestampUrl
if ($resolvedTs) {
  if ($resolvedTs -ne $TimestampUrl) { Write-Host ("timestamp  " + $TimestampUrl + " 不可达，改用 " + $resolvedTs) -ForegroundColor Yellow }
  $TimestampUrl = $resolvedTs
} else {
  Write-Host "所有时间戳服务都不可达；将不盖时间戳（正式发布不要这样）" -ForegroundColor Yellow
}

$exe = Join-Path $Package "dream-maker.exe"
if (-not (Test-Path $exe)) { throw "TARGET_MISSING: $exe" }

if ($Pfx) {
  if (-not $Password) { throw "PASSWORD_REQUIRED" }
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password))
  & $signtool sign /fd SHA256 /f $Pfx /p $plain /tr $TimestampUrl /td SHA256 $exe
  if ($LASTEXITCODE -ne 0) { throw "SIGN_FAILED: $LASTEXITCODE" }
} elseif ($Thumbprint) {
  & $signtool sign /fd SHA256 /sha1 $Thumbprint /tr $TimestampUrl /td SHA256 $exe
  if ($LASTEXITCODE -ne 0) { throw "SIGN_FAILED: $LASTEXITCODE" }
} else {
  throw "NEED_PFX_OR_THUMBPRINT"
}

& $signtool verify /pa /v $exe | Out-String
if ($LASTEXITCODE -ne 0) { throw "VERIFY_FAILED: $LASTEXITCODE" }

if ($UpdateManifest) {
  if (-not (Test-Path $NodeScript)) { throw "MANIFEST_SCRIPT_MISSING: $NodeScript" }
  node $NodeScript
  if ($LASTEXITCODE -ne 0) { throw "MANIFEST_UPDATE_FAILED" }
}
Write-Host "SIGNATURE_OK" -ForegroundColor Green