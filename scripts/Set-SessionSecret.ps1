# Optional local credential entry. Sets only the current PowerShell process environment.
# No plaintext argument, file, account lookup or network request is used.
param([Parameter(Mandatory=$true)][ValidateSet('OpenAI','DeepSeek')][string]$Provider)
$ErrorActionPreference = 'Stop'
$Name = if ($Provider -eq 'OpenAI') { 'OPENAI_API_KEY' } else { 'DEEPSEEK_API_KEY' }
$Secure = Read-Host "Enter $Provider API key (local process only)" -AsSecureString
$Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
try {
    $Plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)
    if ([string]::IsNullOrWhiteSpace($Plain)) { throw 'Key must not be empty.' }
    [Environment]::SetEnvironmentVariable($Name, $Plain, 'Process')
} finally {
    if ($Pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer) }
    $Plain = $null
    $Secure.Dispose()
}
Write-Host "$Name is set for this terminal only. Start Dream Maker from this same terminal."
