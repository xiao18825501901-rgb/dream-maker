# Fixed controller code, launched only inside the original owned Windows Job.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$dmPins=[Collections.Generic.List[IDisposable]]::new()
$dmNonce=$env:DM_STORAGE_CUSTODY_NONCE
$dmSequence=0
function Send-DmStorage($value){[Console]::Out.WriteLine(($value|ConvertTo-Json -Compress -Depth 5));[Console]::Out.Flush()}
function Read-DmStorageLine {
 $builder=[Text.StringBuilder]::new()
 while($true){
  $next=[Console]::In.Read()
  if($next -eq -1){if($builder.Length -eq 0){return $null};throw 'STORAGE_PROTOCOL_TRUNCATED'}
  if($next -eq 10){return $builder.ToString()}
  if($next -eq 13 -or $builder.Length -ge 4096){throw 'STORAGE_PROTOCOL_LIMIT'}
  [void]$builder.Append([char]$next)
 }
}
function Get-DmStoragePath([string]$relative){
 if($relative.Length -gt 512){throw 'STORAGE_PATH_DENIED'}
 if($relative -eq ''){return $dmRoot}
 foreach($part in $relative.Split('/')){
  if($part -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' -or $part.EndsWith('.') -or $part -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)' -or $part -match '[\r\n]'){throw 'STORAGE_PATH_DENIED'}
 }
 return [IO.Path]::Combine($dmRoot,$relative.Replace('/',[IO.Path]::DirectorySeparatorChar))
}
try {
 if($dmNonce -cnotmatch '^storage_custody_[a-f0-9]{20}$'){throw 'STORAGE_NONCE_DENIED'}
 $dmLibraryBytes=[IO.File]::ReadAllBytes($env:DM_STORAGE_CUSTODY_LIBRARY)
 $dmDigest=[Security.Cryptography.SHA256]::Create()
 try{$dmLibraryHash=[BitConverter]::ToString($dmDigest.ComputeHash($dmLibraryBytes)).Replace('-','').ToLowerInvariant()}finally{$dmDigest.Dispose()}
 if($dmLibraryHash -cne $env:DM_STORAGE_CUSTODY_LIBRARY_SHA256){throw 'STORAGE_LIBRARY_CHANGED'}
 Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString($dmLibraryBytes)) -ErrorAction Stop
 $dmRoot=[IO.Path]::GetFullPath($env:DM_STORAGE_CUSTODY_DIRECTORY)
 $dmRootPin=[DreamMaker.StorageDirectoryPin]::AcquireOrCreate($dmRoot)
 $dmPins.Add($dmRootPin)
 Send-DmStorage @{schema='dream-maker.storage-custody.v1';nonce=$dmNonce;type='ready';id=0;identity=$dmRootPin.Identity;libraryHash=$dmLibraryHash}
 while($true){
  $dmLine=Read-DmStorageLine
  if($null -eq $dmLine){break}
  if($dmSequence -ge 768 -or $dmPins.Count -ge 320){throw 'STORAGE_CUSTODY_LIMIT'}
  $dmRequest=$dmLine|ConvertFrom-Json
  if(-not ($dmRequest.id -is [int] -or $dmRequest.id -is [long]) -or $dmRequest.id -ne ($dmSequence+1)){throw 'STORAGE_SEQUENCE_DENIED'}
  $dmSequence++
  if($dmRequest.relative -isnot [string]){throw 'STORAGE_PATH_DENIED'}
  $dmPath=Get-DmStoragePath $dmRequest.relative
  $dmNames=@($dmRequest.PSObject.Properties.Name)
  if($dmRequest.op -ceq 'directory'){
   if(@($dmNames|Where-Object {$_ -notin @('id','op','relative','create')}).Count -ne 0 -or $dmRequest.create -isnot [bool]){throw 'STORAGE_PROTOCOL_DENIED'}
   if($dmRequest.create){$dmPin=[DreamMaker.StorageDirectoryPin]::AcquireOrCreate($dmPath)}else{$dmPin=[DreamMaker.StorageDirectoryPin]::Acquire($dmPath)}
   $dmPins.Add($dmPin)
   Send-DmStorage @{schema='dream-maker.storage-custody.v1';nonce=$dmNonce;type='directory';id=$dmSequence;identity=$dmPin.Identity}
  }elseif($dmRequest.op -ceq 'image'){
   if(@($dmNames|Where-Object {$_ -notin @('id','op','relative','operation','bytes','sha256')}).Count -ne 0 -or $dmRequest.operation -isnot [string] -or $dmRequest.operation.Length -ne 64 -or $dmRequest.operation -cnotmatch '^[a-f0-9]{64}$' -or $dmRequest.sha256 -isnot [string] -or $dmRequest.sha256.Length -ne 64 -or $dmRequest.sha256 -cnotmatch '^[a-f0-9]{64}$' -or -not ($dmRequest.bytes -is [int] -or $dmRequest.bytes -is [long])){throw 'STORAGE_PROTOCOL_DENIED'}
   $dmPin=[DreamMaker.StorageDirectoryPin]::AcquireImage($dmPath,$dmRequest.operation,[long]$dmRequest.bytes,$dmRequest.sha256)
   $dmPins.Add($dmPin)
   Send-DmStorage @{schema='dream-maker.storage-custody.v1';nonce=$dmNonce;type='image';id=$dmSequence;sha256=$dmPin.ImageHash;bytes=$dmPin.ImageBytes}
  }elseif($dmRequest.op -ceq 'file'){
   if(@($dmNames|Where-Object {$_ -notin @('id','op','relative','bytes','sha256')}).Count -ne 0 -or $dmRequest.sha256 -isnot [string] -or $dmRequest.sha256.Length -ne 64 -or $dmRequest.sha256 -cnotmatch '^[a-f0-9]{64}$' -or -not ($dmRequest.bytes -is [int] -or $dmRequest.bytes -is [long])){throw 'STORAGE_PROTOCOL_DENIED'}
   $dmPin=[DreamMaker.StorageDirectoryPin]::AcquireFile($dmPath,[long]$dmRequest.bytes,$dmRequest.sha256)
   $dmPins.Add($dmPin)
   Send-DmStorage @{schema='dream-maker.storage-custody.v1';nonce=$dmNonce;type='file';id=$dmSequence;sha256=$dmPin.ImageHash;bytes=$dmPin.ImageBytes}
  }else{throw 'STORAGE_OPERATION_DENIED'}
 }
}catch{
 Send-DmStorage @{schema='dream-maker.storage-custody.v1';nonce=$dmNonce;type='error';id=$dmSequence;code='STORAGE_CUSTODY_REFUSED'}
 exit 74
}finally{
 for($dmIndex=$dmPins.Count-1;$dmIndex -ge 0;$dmIndex--){$dmPins[$dmIndex].Dispose()}
 $dmPins.Clear()
 Send-DmStorage @{schema='dream-maker.storage-custody.v1';nonce=$dmNonce;type='closed';id=0}
}
