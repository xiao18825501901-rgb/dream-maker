# Official, user-operated ChatGPT login for the independently installed CLI.
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ControlRoot = Join-Path (Split-Path -Parent $ProjectRoot) 'work/controller'
$env:CODEX_HOME = Join-Path $ControlRoot 'codex-home'
$CliEntry = Join-Path $env:APPDATA 'npm/node_modules/@openai/codex/bin/codex.js'
if (-not (Test-Path -LiteralPath $CliEntry)) { throw 'Independent npm Codex CLI is unavailable.' }
foreach ($Name in @('OPENAI_API_KEY','OPENAI_ACCESS_TOKEN','CODEX_ACCESS_TOKEN','CODEX_API_KEY','OPENAI_BASE_URL','OPENAI_API_BASE','CODEX_HOME_AUTH_JSON_BASE64')) {
    [Environment]::SetEnvironmentVariable($Name, $null, 'Process')
}
Write-Host 'Dream Maker dedicated ChatGPT login. Daily Codex authentication is untouched.'
Write-Host 'Complete the official browser sign-in personally. Do not send any password, code or token to chat.'
& node $CliEntry login
$LoginExit = $LASTEXITCODE
if ($LoginExit -eq 0) { Write-Host 'Login returned success for the dedicated home.' }
else { Write-Host ('Login did not complete. Exit code: ' + $LoginExit) }
Read-Host 'Press Enter to close this login window'
exit $LoginExit
