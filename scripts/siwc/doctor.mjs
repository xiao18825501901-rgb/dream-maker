/** Read-only, redacted diagnostic. Does not sign in, read tokens, print env values or invoke network. */
import {resolve} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {defaults,parseConfig} from '../../dist/server/config.js';
import {inspectPinnedCheckout,PINNED_COMMIT} from '../../dist/server/siwc/sdk-loader.js';
import {createWindowsCredentialEncryption} from '../../dist/server/siwc/windows-credential-encryption.js';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const file=process.argv[2]?resolve(process.argv[2]):resolve(root,'.runtime/config.json');
let config=defaults,error='NONE';
try{if(existsSync(file))config=parseConfig(JSON.parse(readFileSync(file,'utf8')));}catch{error='CONFIG_UNREADABLE_OR_INVALID';}
const sdk=inspectPinnedCheckout(process.env.SIWC_SDK_CHECKOUT??'');
const encryption=createWindowsCredentialEncryption();
const available=await encryption.isAvailable();
const result={
 tool:'DREAM_MAKER_SIWC_READ_ONLY_DOCTOR',nodeMajor:Number(process.versions.node.split('.')[0]),
 platform:process.platform,authMode:config.planner1.authMode,selectedModelConfigured:Boolean(config.planner1.siwcModel),
 profileReferenceConfigured:Boolean(config.planner1.siwcProfileId),licenseAcknowledged:config.planner1.siwcNoncommercialAttested,
 sdkStatus:sdk.status,sdkVersion:sdk.version,requiredCommit:PINNED_COMMIT,
 compiledSdkHashApproved:/^[a-f0-9]{64}$/.test(process.env.SIWC_SDK_DIST_SHA256??''),
 windowsCredentialEncryption:available?'AVAILABLE_SELFTEST_ONLY_NOT_LIVE_STORAGE_VERIFIED':'UNAVAILABLE',
 oauthLive:'NOT_RUN',sharingScope:'NOT_VERIFIED',modelList:'NOT_RUN',inference:'NOT_RUN',configStatus:error
};
console.log(JSON.stringify(result,null,2));
