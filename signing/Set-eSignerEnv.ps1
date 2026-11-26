<#
.SYNOPSIS
  把 ssl.com eSigner 的四项凭据写进当前用户环境变量，不落盘到本仓库。
.DESCRIPTION
  凭据来自 SSL.com 控制台（Orders -> Code Signing order -> Download -> SIGNING CREDENTIALS）。
  写入位置是 HKCU 用户环境变量，不是文件；不会进 git，不会进便携包。

  验证凭据是否有效：-Test 会调用 CodeSignTool get_credential_ids，
  成功则打印该账号下的 Credential ID 列表 —— 这是"接线通了"的最硬证据。
.EXAMPLE
  # 填凭据（密码交互输入，不进命令行历史）
  .\Set-eSignerEnv.ps1 -Username me@example.com -CredentialId 11111111-2222-3333-4444-555555555555 -TotpSecret JBSWY3DPEHPK3PXP

.EXAMPLE
  # 只验证现有凭据
  .\Set-eSignerEnv.ps1 -Test

.EXAMPLE
  # 清空
  .\Set-eSignerEnv.ps1 -Clear
#>
param(
  [string]$Username,
  [string]$CredentialId,
  [string]$TotpSecret,
  [securestring]$Password,
  [switch]$Test,
  [switch]$Show,
  [switch]$Clear,
  [string]$CodeSignTool = "D:\DreamMakerSuite\tools\CodeSignTool"
)
$ErrorActionPreference = "Stop"
$Names = @("ESIGNER_USERNAME","ESIGNER_PASSWORD","ESIGNER_TOTP_SECRET","ESIGNER_CREDENTIAL_ID")

function Set-User([string]$k, [string]$v) {
  [Environment]::SetEnvironmentVariable($k, $v, "User")
  Set-Item -Path ("Env:" + $k) -Value $v
}

if ($Clear) {
  foreach ($n in $Names) { [Environment]::SetEnvironmentVariable($n, $null, "User"); Remove-Item ("Env:" + $n) -ErrorAction SilentlyContinue }
  Write-Host "已清除四项 eSigner 凭据。" -ForegroundColor Green
  exit 0
}

$touched = $false
if ($Username)     { Set-User "ESIGNER_USERNAME" $Username; $touched = $true }
if ($CredentialId) { Set-User "ESIGNER_CREDENTIAL_ID" $CredentialId; $touched = $true }
if ($TotpSecret)   { Set-User "ESIGNER_TOTP_SECRET" $TotpSecret; $touched = $true }
if ($Password) {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::BeginPtr(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)))
  Set-User "ESIGNER_PASSWORD" $plain
  $touched = $true
  $plain = $null
} elseif ($touched -and -not $env:ESIGNER_PASSWORD) {
  $sec = Read-Host -AsSecureString "ssl.com 登录密码"
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::BeginPtr(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)))
  Set-User "ESIGNER_PASSWORD" $plain
  $plain = $null
}

if ($touched -or $Show -or $Test) {
  Write-Host ""
  foreach ($n in $Names) {
    $v = [Environment]::GetEnvironmentVariable($n, "User")
    if ($v) { Write-Host ("  set   " + $n.PadRight(24) + " len=" + $v.Length) -ForegroundColor Green }
    else    { Write-Host ("  empty " + $n.PadRight(24) + " 未设置") -ForegroundColor Yellow }
  }
}

if ($Test) {
  $jar = Get-ChildItem (Join-Path $CodeSignTool "jar") -Filter "code_sign_tool-*.jar" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $jar) { Write-Host "找不到 CodeSignTool jar：$CodeSignTool" -ForegroundColor Red; exit 2 }
  if (-not $env:ESIGNER_USERNAME -or -not $env:ESIGNER_PASSWORD) { Write-Host "缺 USERNAME / PASSWORD，先填。" -ForegroundColor Yellow; exit 2 }
  Write-Host ""
  Write-Host "调用 CodeSignTool get_credential_ids （只验账号，不签名、不消耗签名配额）..." -ForegroundColor Cyan
  & java -jar $jar.FullName get_credential_ids "-username=$env:ESIGNER_USERNAME" "-password=$env:ESIGNER_PASSWORD" 2>&1 | Out-String | Write-Host
  if ($LASTEXITCODE -ne 0) { Write-Host ("FAILED exit=" + $LASTEXITCODE) -ForegroundColor Red; exit 1 }
  Write-Host "凭据有效。" -ForegroundColor Green
}

if (-not $touched -and -not $Show -and -not $Test) {
  Write-Host "什么也没做。用 -Username / -CredentialId / -TotpSecret 填写，-Test 验证，-Clear 清空。"
}