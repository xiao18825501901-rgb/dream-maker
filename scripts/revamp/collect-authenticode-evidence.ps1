param(
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][string]$ArtifactPath,
  [Parameter(Mandatory = $true)][string]$ArtifactSha256,
  [Parameter(Mandatory = $true)][string]$RuntimeTreeSha256,
  [Parameter(Mandatory = $true)][string]$ComponentId,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = 'Stop'
if ($null -eq (Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine('POWERSHELL_SECURITY_UNAVAILABLE')
  exit 1
}

function Fail([string]$Code) {
  [Console]::Error.WriteLine($Code)
  exit 1
}

function Full-Path([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [System.IO.Path]::IsPathRooted($Path)) {
    Fail 'ABSOLUTE_PATH_REQUIRED'
  }
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-NotReparse($Item, [string]$Code) {
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail $Code
  }
}

function File-Sha256([string]$Path) {
  $stream = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
  )
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

$root = Full-Path $RuntimeRoot
$artifact = Full-Path $ArtifactPath
$outputPath = Full-Path $Output
if ($ArtifactSha256 -notmatch '^[a-fA-F0-9]{64}$') { Fail 'ARTIFACT_SHA256_INVALID' }
if ($RuntimeTreeSha256 -notmatch '^[a-fA-F0-9]{64}$') { Fail 'RUNTIME_TREE_SHA256_INVALID' }
if ($ComponentId -notmatch '^[a-z0-9][a-z0-9-]{0,127}$') { Fail 'COMPONENT_ID_INVALID' }
if ($Version -notmatch '^[0-9][A-Za-z0-9.+_-]{0,159}$') { Fail 'VERSION_INVALID' }
if ([System.IO.File]::Exists($outputPath)) { Fail 'OUTPUT_EXISTS' }

try {
  $rootItem = Get-Item -LiteralPath $root -Force
  $artifactItem = Get-Item -LiteralPath $artifact -Force
} catch {
  Fail 'INPUT_MISSING'
}
if (-not $rootItem.PSIsContainer) { Fail 'RUNTIME_ROOT_NOT_DIRECTORY' }
if ($artifactItem.PSIsContainer) { Fail 'ARTIFACT_NOT_FILE' }
Assert-NotReparse $rootItem 'RUNTIME_ROOT_REPARSE_DENIED'
Assert-NotReparse $artifactItem 'ARTIFACT_REPARSE_DENIED'

$actualArtifactHash = File-Sha256 $artifact
if ($actualArtifactHash -ne $ArtifactSha256.ToLowerInvariant()) {
  Fail 'ARTIFACT_DIGEST_MISMATCH'
}

$paths = New-Object System.Collections.ArrayList
function Add-PeFiles([string]$Directory) {
  $directoryItem = Get-Item -LiteralPath $Directory -Force
  if (-not $directoryItem.PSIsContainer) { Fail 'RUNTIME_CHILD_NOT_DIRECTORY' }
  Assert-NotReparse $directoryItem 'RUNTIME_REPARSE_DENIED'
  foreach ($item in @(Get-ChildItem -LiteralPath $Directory -Force)) {
    Assert-NotReparse $item 'RUNTIME_REPARSE_DENIED'
    if ($item.PSIsContainer) {
      Add-PeFiles $item.FullName
    } elseif ($item.Extension -ieq '.exe' -or $item.Extension -ieq '.dll') {
      if ($paths.Count -ge 256) { Fail 'PE_FILE_COUNT_LIMIT' }
      [void]$paths.Add($item.FullName)
    }
  }
}
Add-PeFiles $root

$files = New-Object System.Collections.ArrayList
$signers = @{}
$validCount = 0
$unsignedCount = 0
$invalidCount = 0
foreach ($path in $paths) {
  $before = Get-Item -LiteralPath $path -Force
  Assert-NotReparse $before 'PE_REPARSE_DENIED'
  $beforeHash = File-Sha256 $path
  $signature = Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop
  $after = Get-Item -LiteralPath $path -Force
  $afterHash = File-Sha256 $path
  if ($before.Length -ne $after.Length -or $beforeHash -ne $afterHash) {
    Fail 'PE_SOURCE_CHANGED'
  }

  $status = [string]$signature.Status
  $statusClass = 'INVALID'
  if ($status -eq 'Valid') {
    $statusClass = 'VALID'
    $validCount++
  } elseif ($status -eq 'NotSigned' -or
      (($signature.SignerCertificate -eq $null) -and ($signature.SignatureType -eq 'None'))) {
    $statusClass = 'UNSIGNED'
    $unsignedCount++
  } else {
    $invalidCount++
  }

  $signerSubject = $null
  $signerThumbprint = $null
  if ($signature.SignerCertificate -ne $null) {
    $signerSubject = [string]$signature.SignerCertificate.Subject
    $signerThumbprint = [string]$signature.SignerCertificate.Thumbprint
    $signers[$signerThumbprint] = $signerSubject
  }
  $timestampSubject = $null
  if ($signature.TimeStamperCertificate -ne $null) {
    $timestampSubject = [string]$signature.TimeStamperCertificate.Subject
  }

  $relativePath = $path.Substring($root.Length).TrimStart([char[]]@('\', '/'))
  [void]$files.Add([ordered]@{
    path = $relativePath
    bytes = [long]$after.Length
    sha256 = $afterHash
    status = $status
    statusClass = $statusClass
    signerSubject = $signerSubject
    signerThumbprint = $signerThumbprint
    timeStamperSubject = $timestampSubject
    signatureType = [string]$signature.SignatureType
  })
}

$unsignedFiles = @($files | Where-Object { $_.statusClass -eq 'UNSIGNED' } | ForEach-Object { $_.path })
$invalidFiles = @($files | Where-Object { $_.statusClass -eq 'INVALID' } | ForEach-Object { $_.path })
$overall = 'PASS'
if ($invalidCount -gt 0) {
  $overall = 'FAIL'
} elseif ($unsignedCount -gt 0) {
  $overall = 'PARTIAL'
}

$signerList = New-Object System.Collections.ArrayList
foreach ($entry in $signers.GetEnumerator()) {
  [void]$signerList.Add([ordered]@{
    thumbprint = $entry.Key
    subject = $entry.Value
  })
}

$document = [ordered]@{
  schema = 'dream-maker.windows-authenticode-evidence.v1'
  at = [DateTime]::UtcNow.ToString('o')
  componentId = $ComponentId
  version = $Version
  runtimeRoot = $root
  artifactPath = $artifact
  artifactSha256 = $actualArtifactHash
  runtimeTreeSha256 = $RuntimeTreeSha256.ToLowerInvariant()
  status = $overall
  totalPeFiles = $files.Count
  validCount = $validCount
  unsignedCount = $unsignedCount
  invalidCount = $invalidCount
  unsignedFiles = $unsignedFiles
  invalidFiles = $invalidFiles
  signers = $signerList
  files = $files
  binariesExecuted = $false
  modelCalls = 0
  credentialsRead = $false
  scope = 'AUTHENTICODE_FILE_EVIDENCE_NOT_CLEAN_WINDOWS_OR_REDISTRIBUTION_APPROVAL'
}

$outputDirectory = [System.IO.Path]::GetDirectoryName($outputPath)
if (-not [System.IO.Directory]::Exists($outputDirectory)) {
  [void][System.IO.Directory]::CreateDirectory($outputDirectory)
}
$temporary = $outputPath + '.tmp-' + [Guid]::NewGuid().ToString('N')
try {
  $json = $document | ConvertTo-Json -Depth 8
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, $encoding)
  [System.IO.File]::Move($temporary, $outputPath)
} finally {
  if ([System.IO.File]::Exists($temporary)) {
    [System.IO.File]::Delete($temporary)
  }
}

Write-Output ([ordered]@{
  output = $outputPath
  status = $overall
  totalPeFiles = $files.Count
  validCount = $validCount
  unsignedCount = $unsignedCount
  invalidCount = $invalidCount
  modelCalls = 0
} | ConvertTo-Json -Compress)
