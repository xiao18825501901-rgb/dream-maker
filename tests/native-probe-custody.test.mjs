// Actual Windows custody of a random synthetic signing key; no model/account credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,unlinkSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {openProbeKey} from '../dist/server/native-probe-custody.js';
import {harness} from './helpers.mjs';
test('dedicated probe key survives a CurrentUser reload without plaintext storage', {skip:process.platform!=='win32'},async t=>{
 const h=harness(t),a=await openProbeKey(h.dir,false),path=resolve(h.dir,'.runtime/controller/native-probe-custody/signing-key.dpapi');
 const cipher=readFileSync(path);assert.equal(a.length,32);assert.equal(cipher.includes(Buffer.from(a.toString('hex'))),false);
 const b=await openProbeKey(h.dir,true);assert.deepEqual(b,a);a.fill(0);b.fill(0);
 unlinkSync(path);await assert.rejects(openProbeKey(h.dir,true),{code:'NATIVE_PROBE_KEY_MISSING'});
});
test('a custody collision fails before altering another directory ACL',async t=>{
 const h=harness(t),directory=resolve(h.dir,'.runtime/controller/native-probe-custody');mkdirSync(directory,{recursive:true});
 writeFileSync(resolve(directory,'not-owned.txt'),'preserve');
 await assert.rejects(openProbeKey(h.dir,false),{code:'NATIVE_PROBE_CUSTODY_COLLISION'});
 assert.equal(readFileSync(resolve(directory,'not-owned.txt'),'utf8'),'preserve');
});
