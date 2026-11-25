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