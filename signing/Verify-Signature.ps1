param([string]$Package = "D:\DreamMakerSuite\dist-portable\DreamMakerSuite-Portable-0.1.0")
$ErrorActionPreference = "Stop"
$signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe"
$exe = Join-Path $Package "dream-maker.exe"
if (-not (Test-Path $exe)) { throw "TARGET_MISSING" }
& $signtool verify /pa /v $exe | Out-String
$signtoolExit = $LASTEXITCODE
$sig = Get-AuthenticodeSignature $exe
"Status      = " + $sig.Status
"SignerCN    = " + $(if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "(unsigned)" })
"TimeStamper = " + $(if ($sig.TimeStamperCertificate) { $sig.TimeStamperCertificate.Subject } else { "(none)" })
"signtool_exit = $signtoolExit"
if ($sig.Status -ne "Valid") { exit 1 }