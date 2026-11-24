// Module-initialization check only: no DOM, browser, network, model or Live evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script,createContext } from 'node:vm';
import { childEnv } from '../../dist/server/security.js';
import { root } from '../helpers.mjs';
test('offline test bundle initializes the current complete UI graph without missing modules',()=>{
 execFileSync(process.execPath,['scripts/ui-upgrade/offline-bundle.mjs'],{cwd:root,env:childEnv(),windowsHide:true,timeout:12000});
 const text=readFileSync(resolve(root,'.runtime/ui-offline/offline-test-bundle.js'),'utf8');
 const context=createContext({window:{}});new Script(text,{filename:'OFFLINE_TEST_ONLY.js'}).runInContext(context,{timeout:3000});
 const modules=context.window.dmTest.modules;
 for(const name of ['ui','views','local-api','demo-api','kimi-status-summary','native-readiness-summary','project-plan-view','flow-help-view','user-plan-view','shared/network-contexts','shared/codex-metadata'])assert.ok(modules[name],name);
 assert.equal(typeof context.window.dmTest.start,'function');
 assert.equal(modules['network-context-view'].readCodexMetadataObservation,modules['shared/codex-metadata'].readCodexMetadataObservation);
 assert.match(text,/OFFLINE DOM TEST ONLY\. NOT DEPLOYED/);
});
