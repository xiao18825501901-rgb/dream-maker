/** Read-only helper; run ONLY after auditing and building the pinned SDK in its
 * own checkout. Prints a NONSECRET hash of the compiled files, not credentials. */
import { resolve,join } from 'node:path';
import { readFileSync,realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { computeSdkBuildHash } from '../../dist/server/siwc/sdk-integrity.js';
import { PINNED_COMMIT } from '../../dist/server/siwc/sdk-loader.js';
const location=process.argv[2];
if(!location){console.error('Usage: node scripts/siwc/sdk-hash.mjs <audited SDK checkout>');process.exit(2);}
try {
 const root=realpathSync(resolve(location));
 const actual=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',timeout:3500,stdio:['ignore','pipe','ignore']}).trim();
 if(actual!==PINNED_COMMIT)throw Error('SDK_COMMIT_MISMATCH');
 execFileSync('git',['-C',root,'diff','--quiet','HEAD','--','packages/local','package-lock.json','package.json','tsconfig.base.json','scripts/copy-package-notices.mjs'],{timeout:3500,stdio:'ignore'});
 execFileSync('git',['-C',root,'diff','--cached','--quiet','HEAD','--','packages/local','package-lock.json','package.json','tsconfig.base.json','scripts/copy-package-notices.mjs'],{timeout:3500,stdio:'ignore'});
 const pack=JSON.parse(readFileSync(join(root,'packages/local/package.json'),'utf8'));
 if(pack.name!=='@siwc/local'||pack.private!==true||pack.version!=='0.1.0')throw Error('SDK_PACKAGE_IDENTITY_MISMATCH');
 console.log(JSON.stringify({sourceCommit:actual,package:pack.name,version:pack.version,build:computeSdkBuildHash(join(root,'packages/local/dist')),effect:'READ_ONLY_NONSECRET_HASH_NOT_OAUTH_PROOF'},null,2));
}catch {console.error('SDK_HASH_UNAVAILABLE_OR_UNTRUSTED');process.exitCode=3;}
