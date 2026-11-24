// OFFLINE controller environment/path tests; physical MXC and model results are separate evidence.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
import * as transport from '../../dist/server/providers/codex-transport.js';
import {harness} from '../helpers.mjs';
test('Windows Codex context keeps every controlled output in its own project directory and omits secrets',t=>{
 const h=harness(t);assert.equal(typeof transport.createWindowsCodexContext,'function');
 const source={SystemRoot:'C:/Windows',SystemDrive:'C:',ProgramData:'C:/ProgramData',ProgramFiles:'C:/Program Files',DEEPSEEK_API_KEY:'SYNTHETIC_MUST_NOT_INHERIT',OPENAI_API_KEY:'SYNTHETIC_MUST_NOT_INHERIT',HTTP_PROXY:'http://unapproved.invalid',USERPROFILE:'C:/daily',APPDATA:'C:/daily/apps'};
 const x=transport.createWindowsCodexContext(h.dir,'C:/EXISTING_DM_AUTH_HOME','planner2',source);
 assert.ok(x.cwd.startsWith(join(h.dir,'.runtime')));assert.ok(existsSync(x.cwd));assert.equal(x.environment.CODEX_HOME,'C:/EXISTING_DM_AUTH_HOME');
 for(const key of ['TEMP','TMP','TMPDIR','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','CODEX_SQLITE_HOME'])assert.ok(x.environment[key].startsWith(x.directory));
 assert.equal(x.environment.SystemDrive,'C:');for(const key of ['DEEPSEEK_API_KEY','OPENAI_API_KEY','HTTP_PROXY'])assert.equal(x.environment[key],undefined);
 assert.equal(JSON.stringify(x).includes('SYNTHETIC_MUST_NOT_INHERIT'),false);assert.ok(x.args.includes('windows.sandbox="mxc"'));assert.ok(x.args.includes('cli_auth_credentials_store="file"'));
 assert.equal(readFileSync(join(x.directory,'context.json'),'utf8').includes('EXISTING_DM_AUTH_HOME'),false);
});
test('Windows supervisory roles have separate packet roots and reject non-supervisory roles',t=>{
 const h=harness(t);assert.equal(typeof transport.createWindowsCodexContext,'function');
 const a=transport.createWindowsCodexContext(h.dir,'C:/SYNTHETIC_AUTH','planner2',{}),b=transport.createWindowsCodexContext(h.dir,'C:/SYNTHETIC_AUTH','reviewer',{});
 assert.notEqual(a.directory,b.directory);assert.notEqual(a.cwd,b.cwd);assert.notEqual(a.environment.USERPROFILE,b.environment.USERPROFILE);
 assert.throws(()=>transport.createWindowsCodexContext(h.dir,'C:/SYNTHETIC_AUTH','executor',{}),{code:'CODEX_ROLE_DENIED'});
});
