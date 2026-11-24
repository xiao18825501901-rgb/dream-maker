// Real lock files; no service, credential, account or model activity.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {acquireServerLock} from '../../dist/server/server-lock.js';
import * as product from '../../dist/server/local-product.js';
import {DomainError} from '../../dist/server/security.js';
import {root} from '../helpers.mjs';

test('startup cleanup uncertainty retains the original instance lock; an ordinary settled startup failure releases only its own lock',t=>{
 const parent=resolve(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const dir=mkdtempSync(resolve(parent,'startup-cleanup-')),path=resolve(dir,'server.lock');
 const options={identity:'offline-startup-lock',identityProvider:()=> 'offline-startup-lock'},lock=acquireServerLock(path,options);
 t.after(()=>{lock.release();rmSync(dir,{recursive:true,force:true});});
 assert.equal(typeof product.releaseFailedStartupLock,'function');
 assert.equal(product.releaseFailedStartupLock(lock,new DomainError('APPLICATION_CLOSE_UNCERTAIN',409)),false);assert.equal(existsSync(path),true);assert.throws(()=>acquireServerLock(path,options));
 assert.equal(product.releaseFailedStartupLock(lock,Object.assign(Error('occupied'),{code:'EADDRINUSE'})),true);assert.equal(existsSync(path),false);
});
