import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { DomainError } from '../security.js';
export type ResearchTransport = (url: string, init?: RequestInit) => Promise<Response>;
type Address = { address: string; family: number };
const blocked = new BlockList(), globalV6 = new BlockList();
for (const [base,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)
    blocked.addSubnet(base,prefix,'ipv4');
globalV6.addSubnet('2000::',3,'ipv6'); blocked.addSubnet('2001:db8::',32,'ipv6');
const publicAddress = (address: string) => isIP(address) === 4 ? !blocked.check(address,'ipv4')
    : isIP(address) === 6 && globalV6.check(address,'ipv6') && !blocked.check(address,'ipv6');

/** Separate egress policy. Model endpoints and their credentials never enter here. */
export function researchTarget(raw: string, method = 'GET'): URL {
    const u = new URL(raw);
    if (method.toUpperCase() !== 'GET' || u.protocol !== 'https:' || u.username || u.password || u.port || u.hash)
        throw new DomainError('RESEARCH_TARGET_DENIED',403);
    const github = u.hostname === 'api.github.com' && (u.pathname === '/search/repositories'
        || /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/(?:commits|git\/trees\/[a-f0-9]{40}(?:[a-f0-9]{24})?|contents\/[A-Za-z0-9_./%~-]+))?$/.test(u.pathname));
    const gitlab = u.hostname === 'gitlab.com' && (u.pathname === '/api/v4/projects'
        || /^\/api\/v4\/projects\/(?:[A-Za-z0-9_.-]|%2F)+(?:\/repository\/(?:commits|tree|files\/(?:[A-Za-z0-9_.~-]|%[A-Fa-f0-9]{2})+))?$/.test(u.pathname));
    const queryKeys = ['q','per_page','page','sha','ref','ref_name','recursive','search','visibility','simple','path'];
    if ((!github && !gitlab) || [...u.searchParams.keys()].some(key=>!queryKeys.includes(key)) || /[\\\r\n\0]/.test(raw))
        throw new DomainError('RESEARCH_TARGET_DENIED',403);
    return u;
}

/** Reuse the same no-credential and read-only request contract for direct and CFW egress. */
export function researchRequestTarget(raw: string, init: RequestInit = {}): URL {
    const target = researchTarget(raw, init.method);
    const headerNames: string[] = [];
    new Headers(init.headers).forEach((_value, key) => headerNames.push(key));
    if (init.body != null || headerNames.some(key => !['accept','user-agent','x-github-api-version'].includes(key)))
        throw new DomainError('RESEARCH_CREDENTIALS_DENIED',403);
    return target;
}

/** Anonymous HTTPS, one public DNS resolution pinned into the actual TLS connection. */
export function createAnonymousResearchTransport(options: { resolve?: (host: string) => Promise<Address[]> } = {}): ResearchTransport {
    const resolve = options.resolve ?? (host=>lookup(host,{all:true}));
    return async (raw, init = {}) => {
        const target = researchRequestTarget(raw,init);
        const signal = AbortSignal.any([AbortSignal.timeout(12000),...(init.signal?[init.signal]:[])]);
        signal.throwIfAborted();
        let detach = () => {};
        let addresses: Address[];
        try {
            addresses = await Promise.race([resolve(target.hostname),new Promise<never>((_res,rej)=>{
                const abort=()=>rej(new DomainError('RESEARCH_CANCELLED',409));
                signal.addEventListener('abort',abort,{once:true}); detach=()=>signal.removeEventListener('abort',abort);
                if(signal.aborted)abort();
            })]);
        } catch (error) { throw error instanceof DomainError ? error : new DomainError('RESEARCH_DNS_UNAVAILABLE',503); }
        finally { detach(); }
        if (!addresses.length || addresses.some(a=>!publicAddress(a.address) || isIP(a.address)!==a.family))
            throw new DomainError('RESEARCH_DNS_NOT_PUBLIC',403);
        const address = addresses.find(a=>a.family===4) ?? addresses[0];
        signal.throwIfAborted();
        return new Promise<Response>((res,rej)=>{
            let settled=false,size=0; const chunks:Buffer[]=[];
            const finish=(error?:Error,value?:Response)=>{if(settled)return;settled=true;error?rej(error):res(value!);};
            const request=https.request(target,{method:'GET',agent:false,family:address.family,
                lookup:(_host,_opts,callback)=>callback(null,address.address,address.family),
                signal,headers:{accept:'application/json','accept-encoding':'identity','user-agent':'DreamMaker-Research/0.1',...(target.hostname==='api.github.com'?{'x-github-api-version':'2022-11-28'}:{})}},response=>{
                if(response.headers['content-encoding'] && response.headers['content-encoding']!=='identity'){
                    response.destroy();finish(new DomainError('SOURCE_ENCODING_DENIED',502));return;
                }
                response.on('data',(chunk:Buffer)=>{
                    size+=chunk.length;
                    if(size>1_800_000){response.destroy();finish(new DomainError('SOURCE_RESPONSE_TOO_LARGE',413));}else chunks.push(chunk);
                });
                response.once('error',()=>finish(new DomainError('SOURCE_INTERRUPTED',502)));
                response.once('aborted',()=>finish(new DomainError('SOURCE_INTERRUPTED',502)));
                response.once('end',()=>{
                    const headers=new Headers();
                    for(const [key,value]of Object.entries(response.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);
                    const status=response.statusCode??502;
                    finish(undefined,new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers}));
                });
            });
            request.once('error',()=>finish(new DomainError(signal.aborted?'RESEARCH_CANCELLED':'SOURCE_NETWORK_UNAVAILABLE',503)));
            request.end();
        });
    };
}
