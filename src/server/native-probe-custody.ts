import {existsSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {within,DomainError} from './security.js';
import {createWindowsCredentialEncryption} from './siwc/windows-credential-encryption.js';
import {prepareWindowsStorage} from './siwc/windows-storage.js';
import {resolve,join} from 'node:path';
import {capture} from './process.js';
import {childEnv,hash} from './security.js';
import {WSL_ENVIRONMENT} from './wsl-sandbox.js';
import {probeCustodyDirectoryIdentity,verifyProbeCustodyEnvironment,probeCustodyHelper} from './probe-custody-scope.js';
export {probeCustodyDirectoryIdentity,assertProbeCustodyRegistration} from './probe-custody-scope.js';

export async function openProbeKey(root:string,hasReceipts:boolean):Promise<Buffer>{
    const directory=within(root,'.runtime/controller/native-probe-custody');
    const path=within(root,'.runtime/controller/native-probe-custody/signing-key.dpapi');
    if(existsSync(directory)&&readdirSync(directory).some(n=>n!=='signing-key.dpapi'))throw new DomainError('NATIVE_PROBE_CUSTODY_COLLISION',409);
    if(!existsSync(path)&&hasReceipts)throw new DomainError('NATIVE_PROBE_KEY_MISSING',409);
    const encryption=createWindowsCredentialEncryption();
    if(!await encryption.isAvailable())throw new DomainError('NATIVE_PROBE_ENCRYPTION_REQUIRED',409);
    await prepareWindowsStorage(directory);
    if(!existsSync(path)){
        const plaintext=randomBytes(32).toString('hex');
        const ciphertext=await encryption.encrypt(plaintext);
        writeFileSync(path,ciphertext,{flag:'wx',mode:0o600});
    }
    const ciphertext=readFileSync(path);
    if(ciphertext.length>8192)throw new DomainError('NATIVE_PROBE_KEY_INVALID',409);
    const plaintext=await encryption.decrypt(ciphertext);
    if(!/^[a-f0-9]{64}$/.test(plaintext))throw new DomainError('NATIVE_PROBE_KEY_INVALID',409);
    return Buffer.from(plaintext,'hex');
}

/** F-backed dedicated distro custody, preserving the existing CurrentUser-encrypted key bytes. */
export async function openWslProbeKey(root:string,hasReceipts:boolean,distro:string):Promise<Buffer>{
    if(process.platform!=='win32'||distro!==WSL_ENVIRONMENT)
        throw new DomainError('NATIVE_PROBE_CUSTODY_SCOPE_DENIED',409);
    const rootIdentity=probeCustodyDirectoryIdentity(root);await verifyProbeCustodyEnvironment();
    const directory=within(root,'.runtime/controller/native-probe-custody'),legacy=within(root,'.runtime/controller/native-probe-custody/signing-key.dpapi');
    if(existsSync(directory)&&readdirSync(directory).some(n=>n!=='signing-key.dpapi'))throw new DomainError('NATIVE_PROBE_CUSTODY_COLLISION',409);
    const local=existsSync(legacy)?readFileSync(legacy):null;
    if(local&&(local.length<1||local.length>8192))throw new DomainError('NATIVE_PROBE_KEY_INVALID',409);
    const namespace=hash(rootIdentity),helper=probeCustodyHelper().source;
    const exchange=async(action:'read'|'import',cipher?:Buffer):Promise<Buffer|null>=>{
        const input=JSON.stringify({action,namespace,...(cipher?{ciphertext:cipher.toString('base64'),sha256:hash(cipher)}:{})});
        const result=await capture(join(process.env.SystemRoot??'C:/Windows','System32/wsl.exe'),['-d',distro,'--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3','-I','-c',helper],{cwd:root,env:childEnv(),input,timeoutMs:15000,maxBytes:32768});
        let value:unknown;try{value=JSON.parse(result.stdout);}catch{throw new DomainError('NATIVE_PROBE_CUSTODY_UNVERIFIED',409);}
        if(result.code!==0){const code=(value as {code?:unknown})?.code;throw new DomainError(['NATIVE_PROBE_CUSTODY_CONFLICT','NATIVE_PROBE_CUSTODY_COLLISION'].includes(String(code))?String(code):'NATIVE_PROBE_CUSTODY_UNVERIFIED',409);}
        const bytes=decodeProbeCustodyFrame(value,namespace,action);if(bytes&&cipher&&hash(cipher)!==hash(bytes))throw new DomainError('NATIVE_PROBE_CUSTODY_UNVERIFIED',409);
        return bytes;
    };
    const encryption=createWindowsCredentialEncryption();
    if(!await encryption.isAvailable())throw new DomainError('NATIVE_PROBE_ENCRYPTION_REQUIRED',409);
    let current=await exchange('read');
    if(current&&local&&hash(current)!==hash(local))throw new DomainError('NATIVE_PROBE_CUSTODY_CONFLICT',409);
    if(!current){
        if(!local&&hasReceipts)throw new DomainError('NATIVE_PROBE_KEY_MISSING',409);
        const cipher=local??Buffer.from(await encryption.encrypt(randomBytes(32).toString('hex')));
        // Validate the old ciphertext before the first import; never replace a malformed key.
        if(!/^[a-f0-9]{64}$/.test(await encryption.decrypt(cipher)))throw new DomainError('NATIVE_PROBE_KEY_INVALID',409);
        current=await exchange('import',cipher);
    }
    if(!current)throw new DomainError('NATIVE_PROBE_KEY_MISSING',409);
    const plaintext=await encryption.decrypt(current);
    if(!/^[a-f0-9]{64}$/.test(plaintext))throw new DomainError('NATIVE_PROBE_KEY_INVALID',409);
    return Buffer.from(plaintext,'hex');
}
export function decodeProbeCustodyFrame(raw:unknown,namespace:string,action:'read'|'import'):Buffer|null{
 const fail=():never=>{throw new DomainError('NATIVE_PROBE_CUSTODY_UNVERIFIED',409);};
 if(!raw||typeof raw!=='object'||Array.isArray(raw))fail();const v=raw as Record<string,unknown>;
 if(v.schema!=='dream-maker.probe-cipher-custody.v1'||v.namespace!==namespace)fail();
 if(action==='read'&&v.status==='MISSING'){if(Object.keys(v).length!==3||Object.keys(v).some(k=>!['schema','namespace','status'].includes(k)))fail();return null;}
 const fields=['schema','namespace','status','uid','directoryMode','fileMode','sha256','ciphertext'];
 if(Object.keys(v).length!==fields.length||Object.keys(v).some(k=>!fields.includes(k))||v.status!=='READY'||v.uid!==0||v.directoryMode!=='0700'||v.fileMode!=='0600'||typeof v.ciphertext!=='string'||v.ciphertext.length>12000)fail();
 const bytes=Buffer.from(v.ciphertext as string,'base64');if(bytes.length<1||bytes.length>8192||bytes.toString('base64')!==v.ciphertext||hash(bytes)!==v.sha256)fail();return bytes;
}
