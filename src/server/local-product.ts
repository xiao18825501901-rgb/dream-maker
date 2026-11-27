import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createApp } from './http.js';
import {createNativeOwner} from './native-owner.js';
import { acquireServerLock } from './server-lock.js';
import type { Product } from '../shared/product.js';
import {assertProjectStorage} from './workspace-location.js';
import {Settings} from './config.js';
import {installDshControllerCredential} from './controller-dsh-credential.js';
import {startKimiLocalService,type KimiLocalService} from './kimi-local-service.js';
import {DomainError} from './security.js';
import {ClashService} from './clash-service.js';
import {resolveWslProxyBindingForDistro} from './providers/codex-wsl-proxy.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function releaseFailedStartupLock(lock:{release:()=>boolean},error:unknown):boolean{
    // Failed listening is normally settled by createApp. If that cleanup is uncertain, keep the
    // live instance's original lock so another controller cannot write while it retains resources.
    if(error&&typeof error==='object'&&(error as {code?:unknown}).code==='APPLICATION_CLOSE_UNCERTAIN')return false;
    return lock.release();
}
export async function startLocalProduct(product:Product){
const data = resolve(process.env.DM_DATA_DIR || resolve(root, '.runtime'));
assertProjectStorage(root,data,{allowAdditionalDataRoots:true});
mkdirSync(data, { recursive: true, mode: 0o700 });
const lock = resolve(data, 'server.lock');
const serverLock = acquireServerLock(lock, { dataDir: data });
let app: Awaited<ReturnType<typeof createApp>>|undefined;
let credentials:ReturnType<typeof installDshControllerCredential>|undefined;
let kimiService:KimiLocalService|null=null;
let startupError:unknown,settleStartup:()=>void;
const startupController=new AbortController(),startupSettled=new Promise<void>(resolve=>{settleStartup=resolve;});
let stopping=false;
const removeSignals=()=>{process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);};
async function stop(){
    if(stopping)return;stopping=true;startupController.abort();await startupSettled;
    if(startupError&&typeof startupError==='object'&&(startupError as {code?:unknown}).code==='APPLICATION_CLOSE_UNCERTAIN')throw startupError;
    await app?.close();credentials?.restore();serverLock.release();removeSignals();process.exit(0);
}
const onSignal=()=>{void stop().catch(()=>console.error('APPLICATION_CLOSE_UNCERTAIN'));};
// Register before the first asynchronous service/credential startup, so Ctrl+C joins guest cleanup.
process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
try {
    const configPath=resolve(process.env.DM_CONFIG || resolve(root, 'config/local.json'));
    const settings=new Settings(configPath),config=settings.value;
    const clash=new ClashService(
        ()=>settings.value,
        resolve(data,'controller','clash-route'),
        observation=>{app?.store.event(null,null,'network.routed-request',observation);}
    );
    credentials=installDshControllerCredential(config.dsh);
    process.once('exit',credentials.restore);
    const startKimi=()=>startKimiLocalService({product,config,signal:startupController.signal,resolveWslProxy:profile=>
        resolveWslProxyBindingForDistro(profile.distro,root,clash.childEnvironment(),{signal:startupController.signal}),
    onEvent:event=>{
        const folder=resolve(data,'kimi-service-events');mkdirSync(folder,{recursive:true,mode:0o700});
        appendFileSync(resolve(folder,String(event.serviceId)+'.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n',{mode:0o600});
    }});
    // A configured Kimi server owns a long-lived Linux process. Start it only
    // while the same CFW selection lease is active, and give the verified
    // private WSL gateway to the supervisor/Node child. Other roles still
    // acquire their own leases later; this startup lease is released after the
    // child environment has been fixed.
    kimiService=product!=='dreamflow'&&process.env.DM_KIMI_SERVICE_PROFILE
        ?await clash.withRun('kimi-service-start',startupController.signal,startKimi)
        :await startKimi();
    if(startupController.signal.aborted)throw new DomainError('KIMI_SERVICE_START_CANCELLED',409);
    app = await createApp({ root, data, configPath,settings,clash,port:Number(process.env.DM_PORT || (product==='dreamflow'?4318:4317)),nativeOwnerBuilder:createNativeOwner,product,kimiLocalService:kimiService??undefined,onClosed:()=>{credentials?.restore();serverLock.release();removeSignals();} });
    if(startupController.signal.aborted){await app.close();throw new DomainError('KIMI_SERVICE_START_CANCELLED',409);}
}
catch (e) {
    startupError=e;
    try{await kimiService?.stop();}catch{startupError=new DomainError('APPLICATION_CLOSE_UNCERTAIN',409);throw startupError;}
    releaseFailedStartupLock(serverLock,e);
    if(!e||typeof e!=='object'||(e as {code?:unknown}).code!=='APPLICATION_CLOSE_UNCERTAIN')credentials?.restore();
    removeSignals();
    throw e;
}
finally{settleStartup!();}
console.log((product==='dreamflow'?'DreamFlow':'Dream Maker')+' 0.1.0 · local development preview');
console.log('Open this one-time local URL (do not share it):');
// A piped/file stdout is block-buffered in Node, so a long-running local service would never
// flush this line to a log or a spawning parent. Write the token to a 0600 file as well: the
// launcher, the operator and any acceptance harness can read it without tailing a TTY.
try{writeFileSync(resolve(data,'bootstrap-token.txt'),app.bootstrap,{encoding:'utf8',mode:0o600});}catch{}
console.log(app.bootstrapUrl);
{
    const url=app.bootstrapUrl;
    const open=process.env.DM_NO_OPEN_BROWSER==='1'?null:
        process.platform==='win32'?['cmd',['/c','start','',url]]:
        process.platform==='darwin'?['open',[url]]:['xdg-open',[url]];
    let opened=false;
    if(open){
        try{spawn(open[0] as string,open[1] as string[],{detached:true,stdio:'ignore',windowsHide:true}).unref();opened=true;}
        catch{opened=false;}
    }
    process.stderr.write('OPEN_WORKBENCH '+JSON.stringify({opened,product})+'\n');
}
console.log(product==='dreamflow'?'User-supplied plans. Import does not approve or start a build.':'Default: DEMO / Laya OFF. No cloud model calls until you explicitly choose Live.');
// An app that just disappears leaves a black box: run_81f0ce0b1520206a4b49 was orphaned in REPAIRING
// with an empty stderr and no exit code anywhere. Record why this process ended, redacted, so the next
// disappearance is a fact instead of a guess. No behaviour change: nothing is swallowed or retried.
{
    const trail = resolve(data, 'app-exit.log');
    const note = (kind: string, detail: string) => {
        try { appendFileSync(trail, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind, detail: detail.slice(0, 800) }) + '\n'); } catch { }
    };
    process.on('exit', code => note('exit', 'code=' + code));
    process.on('uncaughtException', error => { note('uncaughtException', String((error as Error)?.stack ?? error)); });
    process.on('unhandledRejection', reason => { note('unhandledRejection', String((reason as Error)?.stack ?? reason)); });
}
return app;
}
