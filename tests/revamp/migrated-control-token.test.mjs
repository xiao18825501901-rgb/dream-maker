// Windows DPAPI + a local transport stub: no account login, real credential or model request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {createWindowsCredentialEncryption} from '../../dist/server/siwc/windows-credential-encryption.js';
import {createKimiTransport} from '../../dist/server/providers/kimi.js';
import {root} from '../helpers.mjs';
test('migrated local control token stays encrypted at rest and malformed ciphertext sends nothing',{skip:process.platform!=='win32'},async t=>{
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const dir=mkdtempSync(resolve(parent,'f-token-')),path=resolve(dir,'control-token.dpapi');
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const plain='synthetic-local-control-token-for-migration-test',encryption=createWindowsCredentialEncryption({entropy:'DreamMakerSuite-dedicated-appdata-v1'});
 writeFileSync(path,await encryption.encrypt(plain));assert.equal(readFileSync(path).includes(Buffer.from(plain)),false);
 let calls=0;const transport=createKimiTransport({baseUrl:'http://127.0.0.1:9',tokenFile:path,fetchImpl:async(url,init)=>{calls++;assert.equal(init.headers.authorization,'Bearer '+plain);assert.equal(url,'http://127.0.0.1:9/api/session');return {synthetic:true};}});
 assert.deepEqual(await transport('/api/session',{method:'GET'}),{synthetic:true});assert.equal(calls,1);
 writeFileSync(path,Buffer.from('damaged ciphertext'));
 await assert.rejects(transport('/api/session',{method:'GET'}),{code:'KIMI_SERVER_TOKEN_DECRYPT_FAILED'});assert.equal(calls,1);
});
