import { existsSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { computeSdkBuildHash } from './sdk-integrity.js';
import type { ClientFactory, Encryption, SiwcClient } from './types.js';
import { SiwcBlocked } from './errors.js';
import { prepareWindowsStorage } from './windows-storage.js';

/** An independently authored adapter; the noncommercial DevKit is not redistributed. */
export const PINNED_COMMIT='0a36fefeb913055c8c7a1a29b63d82b96b2e841a';
const ID='dream-maker';
export interface LoaderOptions { checkout: string; encryption:Encryption; storageDir:string }
export function inspectPinnedCheckout(checkout:string, expectedSha256=process.env.SIWC_SDK_DIST_SHA256??''): {status:'PINNED_CHECKOUT'|'UNAVAILABLE';version:string|null;commit:string|null} {
 try {
  if(!checkout||!existsSync(checkout))throw Error('MISSING');
  if (!/^[a-f0-9]{64}$/.test(expectedSha256))throw Error('INTEGRITY_NOT_APPROVED');
  const root=realpathSync(resolve(checkout));
  const packageFile=join(root,'packages/local/package.json'),entry=join(root,'packages/local/dist/index.js');
  if(lstatSync(packageFile).isSymbolicLink()||!existsSync(entry)||lstatSync(entry).isSymbolicLink())throw Error('UNTRUSTED_SDK_FILE');
  const pack=JSON.parse(readFileSync(packageFile,'utf8'));
  const sha=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',timeout:3500,stdio:['ignore','pipe','ignore']}).trim();
  // Commit identity without worktree cleanliness permits edited tracked SDK sources.
  execFileSync('git',['-C',root,'diff','--quiet','HEAD','--','packages/local','package-lock.json','package.json','tsconfig.base.json','scripts/copy-package-notices.mjs'],{timeout:3500,stdio:'ignore'});
  execFileSync('git',['-C',root,'diff','--cached','--quiet','HEAD','--','packages/local','package-lock.json','package.json','tsconfig.base.json','scripts/copy-package-notices.mjs'],{timeout:3500,stdio:'ignore'});
  if(sha!==PINNED_COMMIT||pack.name!=='@siwc/local'||pack.version!=='0.1.0'||pack.private!==true)
   throw Error('UNPINNED_OR_NOT_BUILT');
  if(computeSdkBuildHash(join(root,'packages/local/dist')).sha256!==expectedSha256)throw Error('DIST_INTEGRITY_FAILED');
  return {status:'PINNED_CHECKOUT',version:'0.1.0',commit:sha};
 }catch{return{status:'UNAVAILABLE',version:null,commit:null};}
}
export function makePinnedFactory(opts:LoaderOptions):ClientFactory {
 return async():Promise<SiwcClient>=>{
  if(!(await opts.encryption.isAvailable()))throw new SiwcBlocked('SIWC_OS_ENCRYPTION_UNAVAILABLE',503);
  await prepareWindowsStorage(opts.storageDir);
  if(inspectPinnedCheckout(opts.checkout).status!=='PINNED_CHECKOUT')throw new SiwcBlocked('SIWC_SDK_NOT_PINNED_OR_NOT_BUILT',503);
  const mod=await import(pathToFileURL(join(realpathSync(opts.checkout),'packages/local/dist/index.js')).href);
  if(typeof mod.createChatGPT!=='function')throw new SiwcBlocked('SIWC_SDK_EXPORT_MISSING',503);
  const client=mod.createChatGPT({appName:'Dream Maker',appId:ID,redirectPort:0,storageDir:resolve(opts.storageDir),credentialEncryption:opts.encryption,
   // Official OSS docs require host ID. Pin code defaults false; explicitly enable supported path.
   sendHostId:true}) as SiwcClient;
  for(const key of ['signIn','cancelSignIn','getSession','listProfiles','selectProfile','listModels','subscribe','disconnect','streamResponse'] as const)
   if(typeof client[key]!=='function')throw new SiwcBlocked('SIWC_SDK_INCOMPATIBLE',503);
  return client;
 };
}
