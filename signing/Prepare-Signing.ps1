<#
.SYNOPSIS
  在等待 CA 审核期间，先把"要签什么"固定下来。
.DESCRIPTION
  产出一个签名前基线包（SIGNING_REQUEST.json + SHA256SUMS.txt），列明：
    - 每个待签 PE 文件的路径、字节数、sha256
    - 签名参数（算法、时间戳、主题）
    - 证书到手后要执行的命令
  这份基线一旦固定，证书到手后签名结果可逐字节核对，签错文件会被发现。
.EXAMPLE
  .\Prepare-Signing.ps1
  .\Prepare-Signing.ps1 -Package D:\some\where\DreamMakerSuite-Portable-0.1.0
#>
param(
  [string]$Package = "D:\DreamMakerSuite\dist-portable\DreamMakerSuite-Portable-0.1.0",
  [string]$Product  = "DreamMaker Suite",
  [string]$TimestampUrl = "http://timestamp.digicert.com",
  [string]$OutFile
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Package)) { throw "PACKAGE_MISSING: $Package" }
if (-not $OutFile) { $OutFile = Join-Path $Package "SIGNING_REQUEST.json" }

# Only PE files can carry an Authenticode signature. Everything else in the package is
# covered by RELEASE_MANIFEST.json instead, so this list is deliberately short.
# @() matters: with a single target PowerShell would hand back an ordered dictionary and
# .Count would report the number of KEYS (5), not the number of files.
$targets = @(Get-ChildItem $Package -Recurse -File -Include "*.exe","*.dll" |
  Where-Object { $_.FullName -notmatch "\\runtime\\node\.exe$" } |
  ForEach-Object {
    [ordered]@{
      path    = $_.FullName.Substring($Package.Length).TrimStart("\")
      bytes   = $_.Length
      sha256  = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
      version = (Get-Item $_.FullName).VersionInfo.FileVersion
      product = (Get-Item $_.FullName).VersionInfo.ProductName
    }
  })
if (-not $targets) { throw "NO_PE_TARGET_FOUND" }

$manifest = [ordered]@{
  schema        = "dreammaker.signing-request.v1"
  preparedAt    = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  package       = $Package
  product       = $Product
  signature     = [ordered]@{
    kind           = "Authenticode"
    digest         = "SHA256"
    timestampUrl   = $TimestampUrl
    timestampDigest= "SHA256"
    level          = "asInvoker"
    expect         = "Valid"
  }
  ca            = [ordered]@{
    vendor        = "ssl.com"
    certificate   = "Code Signing (NOT SSL/TLS)"
    keyCustody    = "eSigner cloud HSM (preferred) or hardware token"
    note          = "Private key never enters this repository; only the certificate thumbprint is referenced."
  }
  targets       = $targets
  order         = @(
    "1. install the issued certificate into Cert:\CurrentUser\My",
    "2. .\Sign-DreamMaker.ps1 -Thumbprint <sha1> -UpdateManifest",
    "3. .\Verify-Signature.ps1        (must print Status = Valid)",
    "4. re-run Verify-Portable.ps1    (manifest must still pass after re-signing)"
  )
  warning       = "Signing changes file bytes. Sign FIRST, then recalculate RELEASE_MANIFEST.json. The reverse order fails with PORTABLE_FILE_CHANGED."
}

$json = $manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($OutFile, $json + "`n", (New-Object System.Text.UTF8Encoding $false))

$sums = Join-Path $Package "SIGNING_TARGETS.txt"
$lines = $targets | ForEach-Object { $_.sha256 + "  " + $_.path }
[System.IO.File]::WriteAllText($sums, ($lines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))

Write-Host "PREPARED  $OutFile" -ForegroundColor Green
Write-Host "TARGETS   $($targets.Count) PE file(s)"
foreach ($t in $targets) { Write-Host ("  " + $t.path + "  " + $t.bytes + " bytes  " + $t.sha256.Substring(0,16)) }
Write-Host "SUMS      $sums"
