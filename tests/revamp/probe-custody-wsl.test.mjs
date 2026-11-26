// Real Windows DPAPI + DM-only Linux permission tests. Random test keys, no model/account credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join,dirname,parse} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import * as custody from '../../dist/server/native-probe-custody.js';
import {createWindowsCredentialEncryption} from '../../dist/server/siwc/windows-credential-encryption.js';
import {childEnv} from '../../dist/server/security.js';
import {harness} from '../helpers.mjs';
const distro='DreamMaker-Acceptance-F-20261101-R2',sha=b=>createHash('sha256').update(b).digest('hex');
const paths=h=>({local:resolve(h.dir,'.runtime/controller/native-probe-custody/signing-key.dpapi'),namespace:sha(resolve(h.dir).toLowerCase())});
function linux(script,namespace){const r=spawnSync('wsl.exe',['-d',distro,'--exec','/usr/bin/python3','-I','-c',script,namespace],{cwd:process.cwd(),env:childEnv(),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:16000});assert.equal(r.status,0,'bounded dedicated WSL fixture check failed');return JSON.parse(r.stdout);}
function cleanup(t,h){const ns=paths(h).namespace;t.after(()=>{linux('import pathlib,sys; p=pathlib.Path("/opt/dream-maker-controller/native-probe-custody")/sys.argv[1]; f=p/"signing-key.dpapi";\nif f.is_file() and not f.is_symlink(): f.unlink()\nif p.is_dir() and not p.is_symlink(): p.rmdir()\nprint("{}")',ns);});}
test('WSL custody preserves the original CurrentUser ciphertext and denies a generated-user read',{skip:process.platform!=='win32',timeout:60000},async t=>{
 const h=harness(t),p=paths(h),encryption=createWindowsCredentialEncryption(),key=randomBytes(32),cipher=await encryption.encrypt(key.toString('hex'));mkdirSync(resolve(p.local,'..'),{recursive:true});writeFileSync(p.local,cipher);cleanup(t,h);
 const a=await custody.openWslProbeKey(h.dir,true,distro),b=await custody.openWslProbeKey(h.dir,true,distro);assert.deepEqual(a,key);assert.deepEqual(b,key);assert.equal(sha(readFileSync(p.local)),sha(Buffer.from(cipher)));a.fill(0);b.fill(0);key.fill(0);
 const denied=linux('import json,os,pathlib,sys; p=pathlib.Path("/opt/dream-maker-controller/native-probe-custody")/sys.argv[1]/"signing-key.dpapi"; os.setgroups([]); os.setgid(65534); os.setuid(65534)\ntry: p.read_bytes(); print(json.dumps({"denied":False}))\nexcept PermissionError: print(json.dumps({"denied":True}))',p.namespace);assert.equal(denied.denied,true);
});
test('WSL custody cannot mint a replacement when historical receipts have no available key',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const h=harness(t);await assert.rejects(custody.openWslProbeKey(h.dir,true,distro),{code:'NATIVE_PROBE_KEY_MISSING'});assert.equal(existsSync(paths(h).local),false);
});
test('a fresh WSL key survives reopening without plaintext or a host custody file',{skip:process.platform!=='win32',timeout:60000},async t=>{
 const h=harness(t);cleanup(t,h);const a=await custody.openWslProbeKey(h.dir,false,distro),b=await custody.openWslProbeKey(h.dir.toUpperCase(),true,distro);assert.equal(a.length,32);assert.deepEqual(a,b);assert.equal(existsSync(paths(h).local),false);a.fill(0);b.fill(0);
});
test('WSL custody refuses another distribution before transferring any ciphertext',async()=>{
 await assert.rejects(custody.openWslProbeKey(resolve('.'),true,'Ubuntu-24.04'),{code:'NATIVE_PROBE_CUSTODY_SCOPE_DENIED'});
});
test('custody root inspection rejects a redirected ancestor even when the final folder is ordinary',()=>{
 const path='F:\\DreamMakerSuite\\alias\\repo',reader={lstat:p=>({isSymbolicLink:()=>p.toLowerCase().endsWith('\\alias'),isDirectory:()=>true}),realpath:p=>p};
 assert.throws(()=>custody.probeCustodyDirectoryIdentity(path,reader),{code:'NATIVE_PROBE_CUSTODY_SCOPE_DENIED'});
});

test('the running product root is an approved custody scope and foreign paths stay denied',()=>{
 const product=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
 // The identity ends with the real folder name. Pinning the checkout name made this case pass
 // only inside that one directory; what it means is that the root it runs from is approved.
 assert.equal(custody.probeCustodyDirectoryIdentity(product).toLowerCase().split('\\').pop(), parse(product).base.toLowerCase());
 assert.match(custody.probeCustodyDirectoryIdentity(resolve(product,'tests')),/tests$/);
 assert.throws(()=>custody.probeCustodyDirectoryIdentity(resolve(process.env.SystemRoot??'C:/Windows','Temp')),{code:'NATIVE_PROBE_CUSTODY_SCOPE_DENIED'});
});
test('a same-name WSL registration moved to C or replaced by a new GUID is rejected',()=>{
 const expected={distribution:distro,id:'{c1853a0e-87ff-4d5e-a060-42cb09bad8c6}',basePath:'F:\\DreamMakerSuite\\runtime\\wsl\\'+distro,version:2};
 for(const observed of [{...expected,basePath:'C:\\same-name'},{...expected,id:'{00000000-0000-0000-0000-000000000001}'}])assert.throws(()=>custody.assertProbeCustodyRegistration(expected,observed),{code:'NATIVE_PROBE_CUSTODY_ENVIRONMENT_CHANGED'});
});
test('MISSING replies cannot carry ciphertext or contradictory permission metadata',()=>{
 const namespace='a'.repeat(64),base={schema:'dream-maker.probe-cipher-custody.v1',namespace,status:'MISSING'};
 for(const extra of [{ciphertext:'YQ=='},{uid:65534,directoryMode:'0777'},{unexpected:true}])assert.throws(()=>custody.decodeProbeCustodyFrame({...base,...extra},namespace,'read'),{code:'NATIVE_PROBE_CUSTODY_UNVERIFIED'});
});
// Windows Codex must reuse the already qualified signing-key custody independently of its runtime.
import * as custodySelection from '../../dist/server/probe-custody-scope.js';
import {WSL_ENVIRONMENT as custodyDistro} from '../../dist/server/wsl-sandbox.js';
test('explicit existing WSL probe custody is independent of Windows Codex transport',()=>{
 assert.equal(typeof custodySelection.selectProbeCustody,'function');
 assert.deepEqual(custodySelection.selectProbeCustody({type:'DEDICATED_WSL',distribution:custodyDistro},{transport:'stdio'}),{transport:'wsl',distribution:custodyDistro});
 assert.deepEqual(custodySelection.selectProbeCustody(undefined,{transport:'stdio'}),{transport:'stdio',distribution:''});
 for(const v of [{type:'DEDICATED_WSL',distribution:'UNRELATED'},{type:'DEDICATED_WSL',distribution:custodyDistro,unverified:true},{type:'WINDOWS'}])assert.throws(()=>custodySelection.selectProbeCustody(v,{transport:'stdio'}),{code:'NATIVE_PROBE_CUSTODY_SCOPE_DENIED'});
});
