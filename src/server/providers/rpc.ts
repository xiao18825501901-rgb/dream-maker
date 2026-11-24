import { own, type Owned } from '../process.js';
import { execFileSync } from 'node:child_process';
import { childEnv, DomainError, object, redact,hash } from '../security.js';
import type { ProcessCleanupProof } from '../flow/process-ownership.js';
import { probeProcessIdentity } from '../server-lock.js';
export interface RpcErrorEvidence {
    schema:'dream-maker.rpc-error-evidence.v1';method:string;rpcCode:number|null;errorHash:string;
    category:'INPUT_LENGTH_REJECTED'|'THREAD_NOT_FOUND'|'RPC_INPUT_REJECTED'|'UNCLASSIFIED';provesNoModelDispatch:false;
    failureCategories:readonly string[];httpStatus:number|null;policyRestricted:boolean;modelUnavailable:boolean;
}
const failurePatterns:readonly [string,RegExp][]=[['DSH_HOST_TIMEOUT',/run timeout reached/i],['AUTH_EXPIRED',/expired|refresh_token_reused|refresh token/i],['AUTH_REQUIRED',/not logged|login required|sign.in|authentication required/i],['AUTH_TOKEN',/token|credential/i],['NETWORK',/connect|network|dns|timed? ?out|request failed|error sending request/i],['UNSUPPORTED',/unknown variant|unknown field|invalid params|unsupported|not implemented|method not found/i],['RATE_LIMIT',/rate.?limit|quota|429/i],['MODEL_UNAVAILABLE',/model_not_found|model\s+is\s+unavailable|model\s+not\s+available|invalid_model/i],['FORBIDDEN',/forbidden|403/i],['UNAUTHORIZED',/unauthorized|401/i],['ACCOUNT',/account/i]];
const networkFailurePatterns:readonly [string,RegExp][]=[
    ['DNS_FAILURE',/\b(?:ENOTFOUND|EAI_AGAIN|EAI_NONAME)\b|getaddrinfo|no such host|dns\s+(?:lookup|resolution|error)/i],
    ['TLS_HANDSHAKE_FAILURE',/\b(?:ERR_TLS|ERR_SSL|CERT_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT)\b|tls\s+handshake|ssl\s+handshake|certificate\s+(?:verify|verification|has expired)/i],
    ['PROXY_CONNECTION_RESET',/(?:wsarecv.*(?:forcibly closed|reset)|connection forcibly closed|connection reset by peer|proxy\s+(?:connection\s+)?(?:reset|closed)|127[.]0[.]0[.]1:\d+.*(?:ECONNRESET|ECONNABORTED|EPIPE))/i],
    ['TCP_CONNECTION_FAILURE',/\bECONNREFUSED\b|connection refused|no route to host|network is unreachable|connectex|failed to connect/i],
    ['STREAM_INTERRUPTED',/\b(?:ECONNRESET|ECONNABORTED|EPIPE)\b|socket hang up|stream\s+(?:interrupted|closed|disconnected|reset)|response ended prematurely|unexpected eof|transport closed|connection closed/i]
];
function networkFailureCategory(message:string):string|null{
    return networkFailurePatterns.find(([,pattern])=>pattern.test(message))?.[0]??null;
}
export class RpcChildError extends DomainError {
    readonly evidence:Readonly<RpcErrorEvidence>;
    constructor(evidence:RpcErrorEvidence){super('RUNNER_RPC_ERROR',502);this.evidence=Object.freeze({...evidence,failureCategories:Object.freeze([...evidence.failureCategories])});}
}
/** Diagnostic labels only: remote error text never authorizes retries or changes state. */
export function rpcErrorEvidence(method:string,error:unknown):RpcErrorEvidence {
    const value=error!==null&&typeof error==='object'&&!Array.isArray(error)?error as Record<string,unknown>:{};
    const message=typeof value.message==='string'?value.message:'';
    const rpcCode=typeof value.code==='number'&&Number.isSafeInteger(value.code)&&value.code>=-2147483648&&value.code<=2147483647?value.code:null;
    const status=/\b(401|403|429)\b/.exec(message),httpStatus=status?Number(status[1]):null;
    const networkCategory=networkFailureCategory(message),categories=[...(networkCategory?[networkCategory]:[]),...failurePatterns.filter(([,pattern])=>pattern.test(message)).map(([category])=>category)];
    return {schema:'dream-maker.rpc-error-evidence.v1',method:['initialize','account/read','account/rateLimits/read','model/list','thread/start','thread/resume','turn/start','turn/interrupt','thread/read','thread/turns/list','dm/initialize','dm/run'].includes(method)?method:'OTHER',rpcCode,failureCategories:[...new Set(categories)],
        httpStatus,policyRestricted:/unsupported_country_region_territory|country,\s*region,\s*or\s*territory\s+not\s+supported|not\s+supported\s+in\s+(?:your\s+)?country,?\s*region,?\s*or\s*territory/i.test(message),
        modelUnavailable:/model_not_found|model\s+is\s+unavailable|model\s+not\s+available|invalid_model/i.test(message),
        errorHash:hash(error??null),category:/^Input exceeds the maximum length of [0-9]{1,10}\b/.test(message)?'INPUT_LENGTH_REJECTED':/^thread not found: /.test(message)?'THREAD_NOT_FOUND':rpcCode===-32600||rpcCode===-32602?'RPC_INPUT_REJECTED':'UNCLASSIFIED',provesNoModelDispatch:false};
}
/** Shared by read-only preflight and the actual wire registration. Bounds stay identical. */
export function expectedUserMessageFrameLimit(threadId:string,text:string):number{
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(threadId)||typeof text!=='string'||Buffer.byteLength(text)>2000000)throw new DomainError('RPC_EXPECTED_ECHO_LIMIT',409);
    const limit=Math.max(1000000,Buffer.byteLength(JSON.stringify(text))+32768);
    if(limit>2000000)throw new DomainError('RPC_EXPECTED_ECHO_LIMIT',409);return limit;
}
export class RpcPeer {
    private owned: Owned;
    private sequence = 0;
    private buffer = '';
    private frameBytes=0;
    private frameLimit=1000000;
    private decoder=new TextDecoder('utf-8',{fatal:true});
    private expectedEcho:{threadId:string;textHash:string}|undefined;
    private size = 0;
    private dead = false;
    private closing:Promise<void>|undefined;
    private pending = new Map<number, {
        resolve: (v: Record<string, unknown>) => void;
        reject: (e: Error) => void;
        timer: NodeJS.Timeout;
        method:string;
    }>();
    onNotification: (method: string, params: Record<string, unknown>) => void = () => { };
    onRequest: (method: string, params: Record<string, unknown>, id: string | number) => void = (m, p, id) => this.send({ id, error: { code: -32601, message: 'Client method not permitted' } });
    onFailure: (error: Error) => void = () => { };
    onRpcError: (evidence:RpcErrorEvidence) => void = () => { };
    constructor(command: string, args: string[], options: {
        cwd: string;
        env?: NodeJS.ProcessEnv;
        windowsJobRoot?:string;
        onIntent?:(processId:string|undefined)=>void;
    }, public timeoutMs = 10000) {
        this.owned = own(command, args, options);
        this.owned.child.stdout.on('data', (chunk: Buffer) => { this.size += chunk.length; if (this.size > 8000000) {
            this.fail(new DomainError('RPC_OUTPUT_LIMIT'));
            this.backgroundClose();
            return;
        }
        for(let start=0;start<chunk.length&&!this.dead;){
            const end=chunk.indexOf(10,start),part=chunk.subarray(start,end<0?chunk.length:end);
            this.frameBytes+=part.length;
            if(this.frameBytes>this.frameLimit){this.fail(new DomainError('RPC_LINE_TOO_LONG'));this.backgroundClose();return;}
            try{this.buffer+=this.decoder.decode(part,{stream:true});if(end>=0)this.buffer+=this.decoder.decode();}
            catch{this.fail(new DomainError('RPC_INVALID_UTF8',502));this.backgroundClose();return;}
            if(end<0)break;
            const line=this.buffer,large=this.frameBytes>1000000;this.buffer='';this.frameBytes=0;
            try{if(line.trim())this.receive(line,large);else if(large)throw new DomainError('RPC_LINE_TOO_LONG');}
            catch(error){this.fail(error instanceof DomainError?error:new DomainError('RPC_MESSAGE_SCHEMA',502));this.backgroundClose();}
            start=end+1;
        } });
        this.owned.child.stdin.on('error', () => this.fail(new DomainError('RPC_STDIN_CLOSED', 502)));
        this.owned.child.stderr.on('data', () => { }); // drain; credentials never copied into public events
        this.owned.child.on('error', () => this.fail(new DomainError('RUNNER_EXECUTABLE_UNAVAILABLE', 409)));
        void this.owned.closed.then(() => { if (!this.dead)
            this.fail(new DomainError('RUNNER_TRANSPORT_CLOSED', 502)); });
    }
    /** Only a controller-supplied, bounded input may justify its larger escaped echo.
     * This does not enlarge ordinary model output or the total 8MB output budget. */
    expectUserMessage(threadId:string,text:string):void{
        const limit=expectedUserMessageFrameLimit(threadId,text);
        if(this.frameBytes)throw new DomainError('RPC_EXPECTED_ECHO_LIMIT',409);
        this.expectedEcho={threadId,textHash:hash(text)};this.frameLimit=limit;
    }
    private isExpectedEcho(msg:Record<string,unknown>):boolean{
        const expected=this.expectedEcho;if(!expected)return false;
        const user=(raw:unknown)=>{const item=object(raw??{});if(item.type!=='userMessage'||!Array.isArray(item.content)||item.content.length!==1)return false;
            const text=object(item.content[0]);return text.type==='text'&&typeof text.text==='string'&&hash(text.text)===expected.textHash;};
        const params=object(msg.params??{});
        if(['item/started','item/completed'].includes(String(msg.method)))return params.threadId===expected.threadId&&user(params.item);
        if(msg.method==='turn/started'){const items=object(params.turn??{}).items;return params.threadId===expected.threadId&&Array.isArray(items)&&items.length===1&&user(items[0]);}
        if(typeof msg.id==='number'&&this.pending.get(msg.id)?.method==='turn/start'){const items=object(object(msg.result??{}).turn??{}).items;return Array.isArray(items)&&items.length===1&&user(items[0]);}
        return false;
    }
    private receive(line: string,large=false) {
        let msg: Record<string, unknown>;
        try {
            msg = object(JSON.parse(line));
        }
        catch {
            this.fail(new DomainError('RPC_INVALID_JSON', 502));
            this.backgroundClose();
            return;
        }
        if(large){
            let expected=false;
            try{expected=this.isExpectedEcho(msg);}
            catch{this.fail(new DomainError('RPC_MESSAGE_SCHEMA',502));this.backgroundClose();return;}
            if(!expected){this.fail(new DomainError('RPC_LINE_TOO_LONG'));this.backgroundClose();return;}
        }
        if (typeof msg.method === 'string') {
            let params:Record<string,unknown>;
            try{params=object(msg.params ?? {});}
            catch{this.fail(new DomainError('RPC_MESSAGE_SCHEMA',502));this.backgroundClose();return;}
            if (msg.id !== undefined)
                this.onRequest(msg.method, params, msg.id as string | number);
            else
                this.onNotification(msg.method, params);
            return;
        }
        if (typeof msg.id !== 'number')
            return;
        const pending = this.pending.get(msg.id);
        if (!pending)
            return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
            let evidence:RpcErrorEvidence;
            try{evidence=rpcErrorEvidence(pending.method,msg.error);}catch{pending.reject(new DomainError('RPC_ERROR_EVIDENCE_FAILED',502));return;}
            try{this.onRpcError(evidence);}catch(error){pending.reject(error instanceof Error?error:new DomainError('RPC_ERROR_EVIDENCE_FAILED',500));return;}
            if (process.env.DM_GATEWAY_TRACE === '1')
                console.error('RPC_CHILD_ERROR ' + JSON.stringify(evidence));
            pending.reject(new RpcChildError(evidence));
        }
        else {
            try {
                pending.resolve(object(msg.result ?? {}));
            }
            catch {
                pending.reject(new DomainError('RPC_RESULT_SCHEMA', 502));
            }
        }
    }
    private fail(e: Error) { if (this.dead)
        return; this.dead = true; for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(e);
    } this.pending.clear(); this.onFailure(e); }
    send(msg: unknown) { if (!this.dead && !this.owned.child.stdin.destroyed)
        this.owned.child.stdin.write(JSON.stringify(msg) + '\n'); }
    notify(method: string, params: unknown = {}) { this.send({ method, params }); }
    /** The actual child PID after any Windows Job wrapper is pinned. Identity
     * lookup is observation-only and never changes RPC admission. */
    async processInfo():Promise<{pid:number;identity:string|null;descendantPids?:number[];descendantIdentities?:{pid:number;identity:string}[]}|null>{
        await this.owned.ready;
        const pid=this.owned.targetPid?.()??this.owned.child.pid;
        if(!Number.isSafeInteger(pid)||Number(pid)<1)return null;
        let identity:string|null=null;
        try{identity=probeProcessIdentity(Number(pid));}catch{/* Missing identity remains unverified. */}
        if (!identity || process.platform !== 'win32') return { pid: Number(pid), identity };
        try {
            const script = [
                "$ErrorActionPreference='Stop'",
                `$rootPid=${Number(pid)}`,
                '$all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)',
                '$ids=@($rootPid)',
                '$frontier=@($rootPid)',
                'for($depth=0;$depth -lt 8 -and $frontier.Count -gt 0;$depth++){',
                '$next=@($all | Where-Object {$frontier -contains [int]$_.ParentProcessId} | ForEach-Object {[int]$_.ProcessId})',
                '$add=@($next | Where-Object {$ids -notcontains $_})',
                '$ids+=$add',
                '$frontier=$add',
                '}',
                '$live=@(Get-Process -Id @($ids|Select-Object -First 64) -ErrorAction SilentlyContinue | ForEach-Object {',
                '[pscustomobject]@{pid=[int]$_.Id;identity=(\'win32:\'+[string]$_.StartTime.ToUniversalTime().Ticks)}',
                '})',
                '$root=$live|Where-Object {$_.pid -eq $rootPid}|Select-Object -First 1',
                'if(!$root){throw \'ROOT_IDENTITY_UNAVAILABLE\'}',
                '[pscustomobject]@{identity=$root.identity;pids=@($live|ForEach-Object {$_.pid});identities=@($live)}|ConvertTo-Json -Compress -Depth 4'
            ].join(';');
            const raw = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
                encoding: 'utf8',
                env: childEnv(),
                windowsHide: true,
                timeout: 10000,
                maxBuffer: 256 * 1024,
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            if (raw) {
                const value = object(JSON.parse(raw));
                const identity = typeof value.identity === 'string' ? value.identity : '';
                const pids = Array.isArray(value.pids)
                    ? value.pids.map(Number).filter((item): item is number => Number.isSafeInteger(item) && item > 0 && item <= 2147483647)
                    : [];
                const identities = Array.isArray(value.identities)
                    ? value.identities.map(item=>object(item)).map(item=>({pid:Number(item.pid),identity:String(item.identity)})).filter(item=>
                        Number.isSafeInteger(item.pid)&&item.pid>0&&item.pid<=2147483647&&/^win32:\d+$/.test(item.identity))
                    : [];
                const rootIdentity=identities.find(item=>item.pid===Number(pid))?.identity;
                if (/^win32:\d+$/.test(identity) && rootIdentity===identity && pids.includes(Number(pid)))
                    return { pid: Number(pid), identity, descendantPids: [...new Set(pids)].slice(0, 64), descendantIdentities: identities.slice(0,64) };
            }
        } catch {
            // The caller can still perform a bounded fallback process-tree lookup.
        }
        return { pid: Number(pid), identity };
    }
    /** Resolves once the owned process is ready for its first bridge request. */
    get ready() { return this.owned.ready; }
    async request(method: string, params: unknown = {}, timeoutMs = this.timeoutMs): Promise<Record<string, unknown>> {
        await this.owned.ready;
        if (this.dead)
            return Promise.reject(new DomainError('RUNNER_TRANSPORT_CLOSED', 502));
        const n = ++this.sequence;
        return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(n); reject(new DomainError('RPC_REQUEST_TIMEOUT', 504)); }, timeoutMs); this.pending.set(n, { resolve, reject, timer,method }); this.send({ id: n, method, params }); });
    }
    /** Read-only inventories can end stdin normally; important for WSL's cross-OS child lifetime. */
    private shutdown(graceful:boolean):Promise<void>{
        if(!this.closing){
            this.closing=(async()=>{this.fail(new DomainError('RUNNER_CLOSED',409));
                if(graceful){if(!this.owned.child.stdin.destroyed)this.owned.child.stdin.end();await Promise.race([this.owned.closed,new Promise<void>(res=>{const timer=setTimeout(res,1200);timer.unref();})]);}
                await this.owned.stop();})();
            // Every background initiator consumes rejection. The original Promise remains rejected
            // for the runner's awaited finally; no cleanup failure is relabeled as successful.
            this.closing.catch(()=>{});
        }return this.closing;
    }
    private backgroundClose(){void this.shutdown(false).catch(()=>{});}
    finish(){return this.shutdown(true);}
    close(){return this.shutdown(false);}
    proveCleanup(proof:ProcessCleanupProof){this.owned.proveCleanup(proof);}
}
