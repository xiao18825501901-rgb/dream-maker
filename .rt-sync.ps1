$ErrorActionPreference="Continue"
$env:PATH="D:/DreamMakerSuite/tools/pwsh;"+$env:PATH
Set-Location "D:/DreamMakerSuite/oss/dream-maker"
node scripts/test.mjs tests/revamp/storage-durability.test.mjs tests/revamp/windows-portable.test.mjs tests/revamp/windows-storage-pin.test.mjs tests/revamp/pi-final-text.test.mjs tests/revamp/chat-stages.test.mjs tests/revamp/zero-usage.test.mjs *> "D:/DreamMakerSuite/oss/dream-maker/.rt-sync.out"
Write-Output "done"
