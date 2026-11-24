import {execFileSync} from 'node:child_process';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {childEnv,DomainError,registerCredentialEnv,safeEqual} from './security.js';
import type {Config} from '../shared/types.js';

const selectedReference='windows-user:Dream_Maker_dsh';
const target='DEEPSEEK_API_KEY';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
function readWindowsUserCredential():string{
    if(process.platform!=='win32')throw new DomainError('DSH_CREDENTIAL_REFERENCE_UNAVAILABLE',409);
    // Fixed registry scope and fixed name: no caller string is inserted into PowerShell.
    return execFileSync(join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo','-NoProfile','-NonInteractive','-Command',"[Console]::Out.Write([Environment]::GetEnvironmentVariable('Dream_Maker_dsh','User'))"],
        {cwd:root,env:childEnv(),windowsHide:true,timeout:15000,maxBuffer:16384,encoding:'utf8',stdio:['ignore','pipe','ignore']});
}
/** Explicit trusted startup selection only. Never read from HTTP, model output or an imported plan. */
export function installDshControllerCredential(config:Config['dsh'],options:{env?:NodeJS.ProcessEnv;readUser?:()=>string}={}){
    const env=options.env??process.env,reference=env.DM_DSH_CREDENTIAL_REFERENCE;
    if(reference===undefined||reference==='session')return {reference:'session',targetEnv:config.keyEnv,installed:false,restore(){}};
    if(reference!==selectedReference||config.keyEnv!==target||config.model!=='deepseek-flash')
        throw new DomainError('DSH_CREDENTIAL_REFERENCE_DENIED',409);
    let value:string;
    try{
        value=(options.readUser??readWindowsUserCredential)();
        if(typeof value!=='string'||!/^[\x21-\x7e]{8,8192}$/.test(value))throw Error();
    }catch{throw new DomainError('DSH_CREDENTIAL_REFERENCE_UNAVAILABLE',409);}
    const previous=env[target];
    if(previous!==undefined&&!safeEqual(previous,value))throw new DomainError('DSH_CREDENTIAL_REFERENCE_CONFLICT',409);
    registerCredentialEnv(target);registerCredentialEnv('Dream_Maker_dsh');
    env[target]=value;
    return {reference:selectedReference,targetEnv:target,installed:true,restore(){
        // A later explicit replacement belongs to its caller; never overwrite it during shutdown.
        if(env[target]!==value)return;
        if(previous===undefined)delete env[target];else env[target]=previous;
    }};
}
