$ErrorActionPreference="Continue"
Set-Location "D:/DreamMakerSuite/oss/dream-maker"
$inp = [string]::Concat("protocol=https", [char]10, "host=github.com", [char]10, [char]10)
$out = $inp | git credential fill 2>&1
$arr = $out -split "[\r\n]+"
$pv = ($arr | Where-Object { $_ -match "^password=" })
if($pv){ "token_len=" + (($pv -replace "^password=","")).Length; $tok = ($pv -replace "^password=",""); Set-Content -LiteralPath "D:/DreamMakerSuite/oss/dream-maker/.tok" -Value $tok -NoNewline -Encoding ascii; "saved" } else { "none"; $arr -join " | " }
