/** Windows-native SIWC secret-store qualification with only random synthetic bytes.
 * This script NEVER signs in, fetches OAuth tokens, alters shared config, or accesses user profiles.
 * Other-user access denial needs an explicitly authorized separate Windows test account.
 */
import {randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,relative,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createWindowsCredentialEncryption} from '../../dist/server/siwc/windows-credential-encryption.js';
import {prepareWindowsStorage} from '../../dist/server/siwc/windows-storage.js';
const self=fileURLToPath(import.meta.url),sha=x=>createHash('sha256').update(x).digest('hex');
const root=resolve(dirname(self),'../..'),probeRoot=resolve(root,'.runtime/siwc-windows-probes');
if(process.argv[2]==='--child-check'){
 try {const path=process.argv[3],expected=process.argv[4];const value=await createWindowsCredentialEncryption().decrypt(readFileSync(path));const matched=sha(Buffer.from(value,'utf8'))===expected;console.log(JSON.stringify({syntheticCrossProcessDPAPI:matched?'PASS':'FAIL'}));process.exitCode=matched?0:4;}
 catch {console.log(JSON.stringify({syntheticCrossProcessDPAPI:'FAIL',code:'DPAPI_CHILD_DECRYPT_FAILED'}));process.exitCode=5;}
}else if(process.platform!=='win32'){
 console.log(JSON.stringify({result:'BLOCKED_NOT_WINDOWS',actualWindowsChecks:'NOT_RUN',otherUserSidChecks:'NOT_RUN',environment:process.platform},null,2));
}else{
 let path;const outcome={result:'NOT_RUN',platform:process.platform,syntheticOnly:true,otherUserSidChecks:'NOT_RUN',liveOAuth:'NOT_RUN',steps:[]};
 try{
  const crypto=createWindowsCredentialEncryption();if(!(await crypto.isAvailable()))throw Error('DPAPI_UNAVAILABLE');
  outcome.steps.push('CURRENT_USER_DPAPI_SELFTEST_PASS');
  mkdirSync(probeRoot,{recursive:true});path=mkdtempSync(resolve(probeRoot,'dream-maker-siwc-probe-'));
  await prepareWindowsStorage(path);outcome.steps.push('OWNER_SID_ACL_PROTECTED_PASS');
  const sample='DM_SYNTHETIC_'+randomBytes(32).toString('base64url');
  const cipher=await crypto.encrypt(sample),again=await crypto.decrypt(cipher);
  if(again!==sample)throw Error('ROUNDTRIP_MISMATCH');outcome.steps.push('SYNTHETIC_ROUNDTRIP_PASS');
  const encryptedPath=resolve(path,'synthetic-cipher.bin');writeFileSync(encryptedPath,cipher,{flag:'wx'});
  const child=spawnSync(process.execPath,[self,'--child-check',encryptedPath,sha(Buffer.from(sample,'utf8'))],{encoding:'utf8',timeout:20000,windowsHide:true,env:{SystemRoot:process.env.SystemRoot??'C:\\Windows',WINDIR:process.env.SystemRoot??'C:\\Windows',PATH:'',TEMP:tmpdir(),TMP:tmpdir()}});
  if(child.status!==0)throw Error('CHILD_FAIL');
  const result=JSON.parse(child.stdout);if(result.syntheticCrossProcessDPAPI!=='PASS')throw Error('CHILD_MISMATCH');outcome.steps.push('SYNTHETIC_SECOND_PROCESS_PASS');
  let denied=false;try{await crypto.decrypt(Buffer.from(cipher).fill(0,0,Math.min(16,cipher.length)));}catch{denied=true;}
  if(!denied)throw Error('CORRUPTED_DATA_ACCEPTED');outcome.steps.push('CORRUPTED_CIPHERTEXT_DENIED_PASS');
  outcome.result='PASS_SYNTHETIC_CURRENT_USER_ONLY';
 }catch{outcome.result='FAIL_CLOSED';outcome.steps.push('SAFE_FAILURE_REVIEW_WINDOWS_LOGS');process.exitCode=7;}
 finally{if(path){if(dirname(resolve(path))!==probeRoot||!relative(probeRoot,path).startsWith('dream-maker-siwc-probe-'))throw Error('PROBE_CLEANUP_SCOPE_DENIED');rmSync(path,{recursive:true,force:true});}console.log(JSON.stringify(outcome,null,2));}
}
