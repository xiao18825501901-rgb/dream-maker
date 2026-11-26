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
  [string]$CodeSignTool = $env:ESIGNER_CODESIGNTOOL,
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)
$ErrorActionPreference = "Stop"
$problems = New-Object System.Collections.ArrayList

function Note([string]$state, [string]$name, [string]$detail) {
  switch ($state) {
    "OK"   { $c = "Green" }
    "WAIT" { $c = "Yellow" }
    "--"   { $c = "DarkGray" }
    default{ $c = "Red" }
  }
  Write-Host (("{0,-5} {1,-20} {2}" -f $state, $name, $detail)) -ForegroundColor $c
}

# SSL.com 官方 CLI（Java）。这是唯一"装完就能用"的本地路径：
# 模块 SSLcomCodeSign 在 PSGallery 上并不存在（实测 MISS），dlib 是 eSigner 旧客户端形态。
$csJar = $null
if ($CodeSignTool) {
  if (Test-Path $CodeSignTool -PathType Leaf) { $csJar = $CodeSignTool }
  else {
    foreach ($cand in @((Join-Path $CodeSignTool "jar\code_sign_tool-1.3.2.jar")) + @(Get-ChildItem (Join-Path $CodeSignTool "jar") -Filter "code_sign_tool-*.jar" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })) {
      if ($cand -and (Test-Path $cand)) { $csJar = $cand; break }
    }
  }
}
if (-not $csJar) {
  foreach ($cand in @("D:\DreamMakerSuite\tools\CodeSignTool")) { 
    if (Test-Path (Join-Path $cand "jar")) {
      $j = Get-ChildItem (Join-Path $cand "jar") -Filter "code_sign_tool-*.jar" -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($j) { $csJar = $j.FullName; break }
    }
  }
}
$java = (Get-Command java -ErrorAction SilentlyContinue).Source
if ($csJar -and $java) { Note "OK" "codesigntool" (($csJar -split "\\")[-1] + "  java=" + ((& java -version 2>&1 | Select-Object -First 1) -join " ")) }
elseif ($csJar -and -not $java) { Note "MISS" "java" "CodeSignTool 需要 Java 运行时"; [void]$problems.Add("java") }
else { Note "MISS" "codesigntool" '装 SSL.com CodeSignTool 后用 -CodeSignTool 指过来'; [void]$problems.Add("codesigntool") }

$module = Get-Module -ListAvailable -Name "SSLcomCodeSign" | Select-Object -First 1
if ($module) { Note "OK" "module" ($module.Name + " " + $module.Version) }
else { Note "--" "module" "PSGallery 上不存在此包（保留兼容，不作为阻塞）" }

if ($Dlib -and (Test-Path $Dlib)) { Note "OK" "esigner dlib" $Dlib }
elseif ($csJar) { Note "--" "esigner dlib" "CodeSignTool 已就绪，不需要旧 eSigner 客户端" }
else { Note "MISS" "esigner dlib" "eSigner 客户端附带 esigner.dll，用 -Dlib 指过来"; [void]$problems.Add("dlib") }

if ($Metadata -and (Test-Path $Metadata)) { Note "OK" "metadata" $Metadata }
elseif ($csJar) { Note "--" "metadata" "CodeSignTool 已就绪，不需要 .json" }
else { Note "MISS" "metadata" "eSigner 控制台生成 .json，用 -Metadata 指过来"; [void]$problems.Add("metadata") }

$storeCerts = @(Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue)
$real = @($storeCerts | Where-Object { $_.Subject -notmatch "self-signed" })
if ($real.Count -gt 0) {
  foreach ($c in $real) { Note "OK" "store cert" ($c.Subject + "  " + $c.Thumbprint) }
} elseif ($storeCerts.Count -gt 0) {
  Note "WAIT" "store cert" ("只有自签名测试证书：" + $storeCerts[0].Subject + "  —— 等 CA 签发")
} else {
  Note "WAIT" "store cert" "证书存储里没有代码签名证书 —— 等 CA 签发"
}

$cred = @{ ESIGNER_USERNAME = $Username; ESIGNER_PASSWORD = $Password; ESIGNER_TOTP_SECRET = $TotpSecret; ESIGNER_CREDENTIAL_ID = $CredentialId }
foreach ($k in $cred.Keys) {
  if ($cred[$k]) { Note "OK" $k "present (value not printed)" }
  elseif ($csJar) { Note "WAIT" $k "等 CA 签发后填写（见 README_CN.md 第六节）" }
  else { Note "MISS" $k "未设置"; [void]$problems.Add($k) }
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
  $credMissing = @($cred.Keys | Where-Object { -not $cred[$_] })
  if ($problems.Count -eq 0 -and $credMissing.Count -eq 0 -and $real.Count -gt 0) {
    Write-Host "就绪。执行：.\Sign-WithESigner.ps1 -Sign -UpdateManifest" -ForegroundColor Cyan
    exit 0
  }
  if ($problems.Count -gt 0) {
    Write-Host ("工具还差：" + ($problems -join ", ")) -ForegroundColor Yellow
  } else {
    Write-Host "工具已就绪（CodeSignTool + Java）。" -ForegroundColor Green
  }
  if ($credMissing.Count -gt 0) {
    Write-Host ("等 CA 签发：" + ($credMissing -join ", ")) -ForegroundColor Yellow
    Write-Host "  填入方式：.\Set-eSignerEnv.ps1 -CredentialId <UUID> -Username <邮箱> -TotpSecret <Base32>" -ForegroundColor Cyan
  }
  Write-Host ""
  Write-Host "证书到之前可先跑通全流程（自签名）：" -ForegroundColor Cyan
  Write-Host "  .\Sign-DreamMaker.ps1 -Thumbprint <自签名证书指纹> -UpdateManifest" -ForegroundColor Cyan
  exit 1
}

$signed = $false

# 路径 A：CodeSignTool（SSL.com 官方 CLI，实测 v1.3.2 可用）
if (-not $signed -and $csJar -and $java -and $Username -and $Password) {
  $argList = @("-jar", $csJar, "sign", "-username=$Username", "-password=$Password",
               "-input_file_path=$exe", "-override")
  if ($CredentialId) { $argList += "-credential_id=$CredentialId" }
  if ($TotpSecret)   { $argList += "-totp_secret=$TotpSecret" }
  Write-Host ("exec  java -jar ... sign " + (Split-Path $exe -Leaf)) -ForegroundColor DarkGray
  & $java @argList 2>&1 | Out-String | Write-Host
  if ($LASTEXITCODE -eq 0) { $signed = $true; Note "OK" "sign" "CodeSignTool" }
  else { Note "FAIL" "sign" ("CodeSignTool exit " + $LASTEXITCODE) }
}

if (-not $signed -and $module) {
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

if (-not $signed) {
  $need = @()
  if ($problems.Count -gt 0) { $need += "工具：" + ($problems -join ", ") }
  $miss = @($cred.Keys | Where-Object { -not $cred[$_] })
  if ($miss.Count -gt 0) { $need += "凭据：" + ($miss -join ", ") }
  if ($need.Count -eq 0) { $need += "未知原因，看上面的红色行" }
  Write-Host ("没有可用签名路径。缺 " + ($need -join "；")) -ForegroundColor Red
  if ($miss.Count -gt 0) { Write-Host "  填凭据：.\Set-eSignerEnv.ps1 -Username <邮箱> -CredentialId <UUID> -TotpSecret <Base32>" -ForegroundColor Cyan }
  exit 2
}

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
