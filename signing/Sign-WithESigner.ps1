<#
.SYNOPSIS
  ssl.com eSigner 云签名：给 DreamMaker 的 PE 签名（无需硬件令牌、无需导出私钥）。
.DESCRIPTION
  eSigner 有两条真实路径，本脚本按顺序尝试；另有一条常被误当成它的替代：

    A  SSLcomCodeSign 模块   Set-AuthenticodeSignature_ESigner / Invoke-ESignerCodeSign
    B  signtool + eSigner dlib   signtool sign /dlib esigner.dll /dmdf metadata.json
    C  证书已在 Cert:\CurrentUser\My  —— 用 Sign-DreamMaker.ps1 -Thumbprint

  2023-06 之后公共 CA 的代码签名私钥不能导出 .pfx，
  所以"拿到证书文件再签"对新证书不存在。
.EXAMPLE
  .\Sign-WithESigner.ps1                    # 体检
  .\Sign-WithESigner.ps1 -Sign -UpdateManifest
#>
param(
  [switch]$Sign,
  [switch]$UpdateManifest,
  [string]$Package = "D:\DreamMakerSuite\dist-portable\DreamMakerSuite-Portable-0.1.0",
  [string]$Username     = $env:ESIGNER_USERNAME,
  [string]$Password     = $env:ESIGNER_PASSWORD,
  [string]$TotpSecret   = $env:ESIGNER_TOTP_SECRET,
  [string]$CredentialId = $env:ESIGNER_CREDENTIAL_ID,
  [string]$Dlib         = $env:ESIGNER_DLIB,
  [string]$Metadata     = $env:ESIGNER_METADATA,
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)
$ErrorActionPreference = "Stop"
$problems = New-Object System.Collections.ArrayList

function Note([string]$state, [string]$name, [string]$detail) {
  if ($state -eq "OK") { $c = "Green" } elseif ($state -eq "MISS") { $c = "Yellow" } else { $c = "Red" }
  Write-Host (("{0,-5} {1,-20} {2}" -f $state, $name, $detail)) -ForegroundColor $c
}

$module = Get-Module -ListAvailable -Name "SSLcomCodeSign" | Select-Object -First 1
if ($module) { Note "OK" "module" ($module.Name + " " + $module.Version) }
else { Note "MISS" "module" "PSGallery 无此包时改走 dlib 路径"; [void]$problems.Add("module") }

if ($Dlib -and (Test-Path $Dlib)) { Note "OK" "esigner dlib" $Dlib }
else { Note "MISS" "esigner dlib" "eSigner 客户端附带 esigner.dll，用 -Dlib 指过来"; [void]$problems.Add("dlib") }

if ($Metadata -and (Test-Path $Metadata)) { Note "OK" "metadata" $Metadata }
else { Note "MISS" "metadata" "eSigner 控制台生成 .json，用 -Metadata 指过来"; [void]$problems.Add("metadata") }

$storeCerts = @(Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue)
$real = @($storeCerts | Where-Object { $_.Subject -notmatch "self-signed" })
if ($real.Count -gt 0) {
  foreach ($c in $real) { Note "OK" "store cert" ($c.Subject + "  " + $c.Thumbprint) }
} elseif ($storeCerts.Count -gt 0) {
  Note "MISS" "store cert" ("只有自签名测试证书：" + $storeCerts[0].Subject)
} else {
  Note "MISS" "store cert" "证书存储里没有代码签名证书"
}

$cred = @{ ESIGNER_USERNAME = $Username; ESIGNER_PASSWORD = $Password; ESIGNER_TOTP_SECRET = $TotpSecret; ESIGNER_CREDENTIAL_ID = $CredentialId }
foreach ($k in $cred.Keys) {
  if ($cred[$k]) { Note "OK" $k "present (value not printed)" } else { Note "MISS" $k "未设置" }
}

$exe = Join-Path $Package "dream-maker.exe"
if (Test-Path $exe) {
  $pe = Get-Item $exe
  $before = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
  Note "OK" "target" ($pe.Name + "  " + $pe.Length + " bytes  sha256=" + $before.Substring(0,16))
} else {
  Note "MISS" "target" $exe
  exit 2
}

if (-not $Sign) {
  Write-Host ""
  if ($problems.Count -eq 0) {
    Write-Host "就绪。执行：.\Sign-WithESigner.ps1 -Sign -UpdateManifest" -ForegroundColor Cyan
    exit 0
  }
  Write-Host ("还差：" + ($problems -join ", ")) -ForegroundColor Yellow
  Write-Host ""
  Write-Host "证书到之前可先跑通流程（自签名）：" -ForegroundColor Cyan
  Write-Host "  .\Sign-DreamMaker.ps1 -Thumbprint <自签名证书指纹> -UpdateManifest" -ForegroundColor Cyan
  exit 1
}

$signed = $false
if ($module) {
  Import-Module $module.Path -Force
  $arg = @{ Path = $exe; CredentialId = $CredentialId; Username = $Username; Password = $Password; TotpSecret = $TotpSecret; TimestampUrl = $TimestampUrl }
  foreach ($cmd in @("Set-AuthenticodeSignature_ESigner", "Invoke-ESignerCodeSign")) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
      try { & $cmd @arg | Out-Null; $signed = $true; Note "OK" "sign" $cmd; break }
      catch { Note "FAIL" "sign" ($cmd + ": " + $_.Exception.Message.Substring(0, [Math]::Min(140, $_.Exception.Message.Length))) }
    }
  }
}

if (-not $signed -and $Dlib -and $Metadata) {
  $cands = @("C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe", "C:\Program Files (x86)\Windows Kits\10\bin\x64\signtool.exe")
  $signtool = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $signtool) { Note "FAIL" "signtool" "未找到"; exit 2 }
  & $signtool sign /v /fd SHA256 /tr $TimestampUrl /td SHA256 /dlib $Dlib /dmdf $Metadata $exe
  if ($LASTEXITCODE -eq 0) { $signed = $true; Note "OK" "sign" "signtool + dlib" }
  else { Note "FAIL" "sign" ("signtool exit " + $LASTEXITCODE) }
}

if (-not $signed) { Write-Host "没有可用签名路径。先解决上面 MISS 的项。" -ForegroundColor Red; exit 2 }

$v = Get-AuthenticodeSignature $exe
if ($v.Status -eq "Valid") { $vc = "Green" } else { $vc = "Yellow" }
Write-Host ("status  " + $v.Status) -ForegroundColor $vc
if ($v.SignerCertificate) { Write-Host ("signer  " + $v.SignerCertificate.Subject) }
if ($v.TimeStamperCertificate) { Write-Host ("stamp   " + $v.TimeStamperCertificate.Subject) }
$after = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
Write-Host ("sha256  " + $before.Substring(0,16) + " -> " + $after.Substring(0,16))

if ($UpdateManifest) {
  $rebuild = Join-Path $Package "Verify-Portable.ps1"
  if (Test-Path $rebuild) {
    Write-Host "recalculating RELEASE_MANIFEST.json ..." -ForegroundColor Cyan
    Push-Location $Package
    try { & $rebuild 2>&1 | Select-Object -Last 4 } finally { Pop-Location }
  } else { Write-Host "Verify-Portable.ps1 不在包内，请手工重算清单。" -ForegroundColor Yellow }
}
Write-Host "DONE" -ForegroundColor Green
