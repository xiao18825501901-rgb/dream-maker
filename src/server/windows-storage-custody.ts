import {readFileSync} from 'node:fs';import {resolve,relative,sep,isAbsolute} from 'node:path';import {StringDecoder} from 'node:string_decoder';
import {own} from './process.js';import {DomainError,childEnv,hash,id,object,within} from './security.js';
import {currentProcessOwnership} from './flow/process-ownership.js';

export interface StorageCustody {
    /** Includes caller cancellation, keeper failure and the bounded scope deadline. */
    readonly signal:AbortSignal;
    /** Metadata only; these are trusted controller directories, not model file paths. */
    directory(relative:string,create?:boolean):Promise<{path:string;identity:string}>;
    image(relativeDirectory:string,operation:string,bytes:number,sha256:string):Promise<{path:string;bytes:number;sha256:string}>;
    /** Pins an existing controller-owned file and verifies its exact bytes. */
    file(relative:string,bytes:number,sha256:string):Promise<{path:string;bytes:number;sha256:string}>;
    /** Required before trusted I/O and transaction commit after any await. */
    assertActive():void;
}
const schema='dream-maker.storage-custody.v1';
const validHash=(v:string)=>typeof v==='string'&&v.length===64&&/^[a-f0-9]{64}$/.test(v);
function validateRelative(value:string){
    if(typeof value!=='string'||value.length>512||value!==''&&value.split('/').some(p=>!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(p)||p.endsWith('.')||/[\r\n]/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
        throw new DomainError('STORAGE_CUSTODY_PATH_DENIED',409);
}
const bootstrap=String.raw`$ErrorActionPreference='Stop';$dmBytes=[IO.File]::ReadAllBytes($env:DM_STORAGE_CUSTODY_SOURCE);$dmHasher=[Security.Cryptography.SHA256]::Create();try{$dmHash=[BitConverter]::ToString($dmHasher.ComputeHash($dmBytes)).Replace('-','').ToLowerInvariant()}finally{$dmHasher.Dispose()};if($dmHash -cne $env:DM_STORAGE_CUSTODY_SOURCE_SHA256){throw 'STORAGE_KEEPER_SOURCE_CHANGED'};& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($dmBytes)))`;

/** Owned OS handles only. This grants no data/role authority, parses no business
 * SQLite and is not exposed to HTTP. The original Store/Dispatch remain owners. */
export async function withWindowsStorageCustody<T>(root:string,directory:string,action:(lease:StorageCustody)=>Promise<T>,options:{signal?:AbortSignal;timeoutMs?:number;keepAliveOnAbort?:boolean}={}):Promise<T>{
    if(process.platform!=='win32')throw new DomainError('WINDOWS_STORAGE_CUSTODY_REQUIRED',409);
    if(!currentProcessOwnership())throw new DomainError('STORAGE_CUSTODY_OWNERSHIP_REQUIRED',409);
    if(typeof action!=='function'||options.keepAliveOnAbort!==undefined&&typeof options.keepAliveOnAbort!=='boolean')throw new DomainError('STORAGE_CUSTODY_INPUT_DENIED',409);
    if(options.signal!==undefined&&(options.signal===null||typeof options.signal!=='object'||typeof options.signal.aborted!=='boolean'||
        typeof options.signal.addEventListener!=='function'||typeof options.signal.removeEventListener!=='function'))throw new DomainError('STORAGE_CUSTODY_INPUT_DENIED',409);
    if(options.signal?.aborted)throw new DomainError('RUN_CANCELLED',409);
    const timeout=options.timeoutMs??120000;
    if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>120000)throw new DomainError('STORAGE_CUSTODY_TIME_LIMIT',409);
    // The approved base is the product root the caller actually owns, plus the historical operator
    // directory so existing installations keep working. Both are derived here rather than read from
    // module scope: a failure-peer test rebuilds this exact function body with a fixed identifier
    // list, and any module-level name would be a ReferenceError there.
    const scope=resolve(directory),base=resolve(root),historicalBase=resolve('F:/DreamMakerSuite');
    // Either root is acceptable: the install the product actually runs from, or the historical
    // operator directory where earlier installations and their evidence already live.
    const inside=(rootPath:string,full:string)=>{const child=relative(rootPath,full);
        return full===rootPath||!!child&&!child.startsWith('..')&&!child.includes(':')&&!child.startsWith(sep);};
    for(const path of [root,directory]){const full=resolve(path);
        if(!isAbsolute(path)||!(inside(base,full)||inside(historicalBase,full)))throw new DomainError('STORAGE_CUSTODY_PATH_DENIED',409);}
    const source=within(root,'scripts/isolation/windows-storage-keeper.ps1'),library=within(root,'scripts/isolation/windows-storage-pin.cs');
    const sourceHash=hash(readFileSync(source)),libraryHash=hash(readFileSync(library)),nonce=id('storage_custody');
    const binary=resolve(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    const owned=own(binary,['-NoLogo','-NoProfile','-NonInteractive','-Command',bootstrap],{cwd:root,windowsJobRoot:root,
        env:childEnv({DM_STORAGE_CUSTODY_SOURCE:source,DM_STORAGE_CUSTODY_SOURCE_SHA256:sourceHash,DM_STORAGE_CUSTODY_LIBRARY:library,
            DM_STORAGE_CUSTODY_LIBRARY_SHA256:libraryHash,DM_STORAGE_CUSTODY_DIRECTORY:scope,DM_STORAGE_CUSTODY_NONCE:nonce,
            // The keeper's own C# pin must accept the same roots this layer approves, or the
            // boundary is enforced twice with two different answers.
            DM_STORAGE_CUSTODY_SCOPES:[base,historicalBase].join(';')})});
    let active=false,closing=false,closedAck=false,readyObserved=false,error:Error|null=null,actionError:Error|null=null,sequence=0,outputBytes=0,buffer='';
    const cancellation=new AbortController();
    const actionCancellation=new AbortController();
    const leaseSignal=AbortSignal.any([cancellation.signal,actionCancellation.signal]);
    type Waiter={type:string;id:number;resolve:(v:Record<string,unknown>)=>void;reject:(e:Error)=>void};let waiter:Waiter|null=null;
    const ready=new Promise<Record<string,unknown>>((res,rej)=>{waiter={type:'ready',id:0,resolve:res,reject:rej};});ready.catch(()=>{});
    const fail=(e:Error)=>{if(error)return;error=e;active=false;cancellation.abort(e);actionCancellation.abort(e);waiter?.reject(e);waiter=null;void owned.stop().catch(()=>{});};
    const cancel=(e:Error)=>{
        if(error||actionError)return;
        // A pinned Job can precede keeper readiness. Let its authenticated startup
        // finish so EOF can release handles and acknowledge close; never run action.
        // The original startup deadline still bounds an unresponsive keeper.
        if(!active||!readyObserved){actionError=e;actionCancellation.abort(e);return;}
        actionError=e;actionCancellation.abort(e);
        if(options.keepAliveOnAbort!==true){fail(e);return;}
        waiter?.reject(e);waiter=null;
    };
    const decoder=new StringDecoder('utf8');
    owned.child.stdout.on('data',(chunk:Buffer)=>{
        outputBytes+=chunk.length;if(outputBytes>262144){fail(new DomainError('STORAGE_CUSTODY_OUTPUT_LIMIT',409));return;}
        buffer+=decoder.write(chunk);
        while(buffer.includes('\n')){
            const index=buffer.indexOf('\n'),line=buffer.slice(0,index);buffer=buffer.slice(index+1);
            if(line.length>4096){fail(new DomainError('STORAGE_CUSTODY_PROTOCOL_INVALID',409));return;}
            let value:Record<string,unknown>;try{value=object(JSON.parse(line));}catch{fail(new DomainError('STORAGE_CUSTODY_PROTOCOL_INVALID',409));return;}
            if(value.schema!==schema||value.nonce!==nonce){fail(new DomainError('STORAGE_CUSTODY_PROTOCOL_INVALID',409));return;}
            if(closing&&value.type==='closed'&&value.id===0){closedAck=true;continue;}
            if(value.type==='error'){fail(new DomainError('STORAGE_CUSTODY_REFUSED',409));return;}
            const waiting=waiter;if(!waiting||waiting.type!==value.type||waiting.id!==value.id){fail(new DomainError('STORAGE_CUSTODY_PROTOCOL_INVALID',409));return;}
            waiter=null;if(value.type==='ready'){if(readyObserved||value.libraryHash!==libraryHash||typeof value.identity!=='string'||!/^[a-f0-9]+:[a-f0-9]+$/.test(value.identity)){fail(new DomainError('STORAGE_CUSTODY_PROTOCOL_INVALID',409));waiting.reject(error!);return;}readyObserved=true;}
            waiting.resolve(value);
        }
        if(buffer.length>4096)fail(new DomainError('STORAGE_CUSTODY_OUTPUT_LIMIT',409));
    });
    owned.child.stderr.on('data',(chunk:Buffer)=>{outputBytes+=chunk.length;if(outputBytes>262144)fail(new DomainError('STORAGE_CUSTODY_OUTPUT_LIMIT',409));});
    owned.child.stdout.on('error',()=>fail(new DomainError('STORAGE_CUSTODY_TRANSPORT_FAILED',409)));
    owned.child.stderr.on('error',()=>fail(new DomainError('STORAGE_CUSTODY_TRANSPORT_FAILED',409)));
    owned.child.stdin.on('error',()=>{if(!closing)fail(new DomainError('STORAGE_CUSTODY_TRANSPORT_FAILED',409));});
    void owned.closed.then(()=>{if(!closing)fail(new DomainError('STORAGE_CUSTODY_EXITED',409));});
    const abort=()=>cancel(new DomainError('RUN_CANCELLED',409));options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted)abort();
    const timer=setTimeout(()=>{const e=new DomainError('STORAGE_CUSTODY_TIMEOUT',409);if(!active)fail(e);else cancel(e);},timeout);
    const assertActive=()=>{if(error)throw error;if(!active||cancellation.signal.aborted)throw new DomainError(cancellation.signal.aborted?'RUN_CANCELLED':'STORAGE_CUSTODY_CLOSED',409);};
    const rpc=async(type:string,fields:Record<string,unknown>)=>{
        assertActive();if(actionError)throw actionError;if(waiter||sequence>=128){const e=new DomainError('STORAGE_CUSTODY_BUSY_OR_LIMIT',409);fail(e);throw e;}
        const frame=JSON.stringify({id:++sequence,op:type,...fields})+'\n';if(Buffer.byteLength(frame)>4096)throw new DomainError('STORAGE_CUSTODY_INPUT_LIMIT',409);
        const response=new Promise<Record<string,unknown>>((res,rej)=>{waiter={type,id:sequence,resolve:res,reject:rej};});
        owned.child.stdin.write(frame,e=>{if(e)fail(new DomainError('STORAGE_CUSTODY_TRANSPORT_FAILED',409));});
        const value=await response;assertActive();return value;
    };
    const protocolFailure=():never=>{const e=new DomainError('STORAGE_CUSTODY_PROTOCOL_INVALID',409);fail(e);throw e;};
    const lease:StorageCustody={assertActive,signal:leaseSignal,
        async directory(name,create=false){validateRelative(name);if(typeof create!=='boolean')throw new DomainError('STORAGE_CUSTODY_INPUT_DENIED',409);const v=await rpc('directory',{relative:name,create});
            if(typeof v.identity!=='string'||!/^[a-f0-9]+:[a-f0-9]+$/.test(v.identity))return protocolFailure();return {path:resolve(scope,name),identity:v.identity};},
        async image(name,operation,bytes,sha256){validateRelative(name);if(!validHash(operation)||!validHash(sha256)||!Number.isSafeInteger(bytes)||bytes<512||bytes>67108864||bytes%512)throw new DomainError('STORAGE_CUSTODY_INPUT_DENIED',409);
            const v=await rpc('image',{relative:name,operation,bytes,sha256});if(v.bytes!==bytes||v.sha256!==sha256)return protocolFailure();return {path:resolve(scope,name,operation+'.sqlite'),bytes,sha256};},
        async file(name,bytes,sha256){validateRelative(name);if(!validHash(sha256)||!Number.isSafeInteger(bytes)||bytes<1||bytes>67108864)throw new DomainError('STORAGE_CUSTODY_INPUT_DENIED',409);
            const v=await rpc('file',{relative:name,bytes,sha256});if(v.bytes!==bytes||v.sha256!==sha256)return protocolFailure();return {path:resolve(scope,name),bytes,sha256};}
    };
    let value!:T,failed:unknown,actionFailed=false;
    try{await Promise.all([owned.ready,ready]);if(error)throw error;if(actionError)throw actionError;active=true;value=await action(lease);if(actionError)throw actionError;assertActive();}
    catch(e){actionFailed=true;failed=e;}
    finally{
        active=false;closing=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);
        owned.child.stdin.end();
        const exit=await Promise.race([owned.closed,new Promise<null>(res=>setTimeout(()=>res(null),3000))]);
        await owned.stop();
        const closeFailure=exit===null||exit.code!==0||exit.signal!==null||!closedAck||buffer.length
            ?new DomainError('STORAGE_CUSTODY_CLOSE_UNVERIFIED',409):null;
        const closeUnverified=closeFailure??error;
        if(closeUnverified){
            if(closeFailure&&(closeUnverified as Error&{cause?:unknown}).cause===undefined){
                const cause=actionFailed&&error&&failed!==error
                    ?new AggregateError([failed,error],'STORAGE_CUSTODY_ACTION_AND_TRANSPORT_FAILURE')
                    :actionFailed?failed:error;
                if(cause!==undefined)Object.defineProperty(closeUnverified,'cause',{value:cause,enumerable:false,configurable:true});
            }
            throw closeUnverified;
        }
    }
    if(actionFailed)throw failed;return value;
}
