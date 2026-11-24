// Transport paths are not a model or OS sandbox qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { codexAgentCwd, codexCwdMatches } from '../../dist/server/providers/codex-transport.js';
import { defaults } from '../../dist/server/config.js';
test('WSL role uses the trusted Linux packet directory, never a Windows workspace path',()=>{
 const config=structuredClone(defaults);
 config.codex.transport='wsl';config.codex.wslCwdRoot='/opt/dream-maker-controller/codex-work';
 const cwd=codexAgentCwd(config,'C:\\untrusted-generated-project');
 assert.equal(cwd,'/opt/dream-maker-controller/codex-work');
 assert.equal(codexCwdMatches(config,cwd,cwd),true);
 assert.equal(codexCwdMatches(config,cwd,'C:\\untrusted-generated-project'),false);
 assert.equal(codexCwdMatches(config,cwd,cwd+'/../private'),false);
});
