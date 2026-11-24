// Offline helper contract checks; never launches a login or reads credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=()=>readFileSync(new URL('../scripts/Login-WslCodex.ps1',import.meta.url),'utf8');
test('WSL helper requires explicit user login and has a harmless validation mode',()=>{
 const code=source();assert.match(code,/\[switch\]\$UserLogin/);assert.match(code,/\[switch\]\$ValidateOnly/);
 assert.match(code,/EXPLICIT_LOGIN_OR_VALIDATION_REQUIRED/);assert.match(code,/--device-auth/);
});
test('WSL helper isolates the official account without cache import, transcript or API fallback',()=>{
 const code=source();assert.match(code,/DreamMaker-Acceptance-20261011/);
 assert.match(code,/\/opt\/dream-maker-controller\/codex-0\.162\.0/);
 assert.match(code,/cli_auth_credentials_store="file"/);assert.match(code,/forced_login_method="chatgpt"/);
 assert.match(code,/os\.umask\(0o077\)/);assert.match(code,/\{'PATH':/);
 assert.doesNotMatch(code,/Start-Transcript|--with-api-key|--with-access-token|auth\.json.*read_text|ExecutionPolicy.*Bypass|logout/);
});
