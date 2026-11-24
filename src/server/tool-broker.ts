import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { DomainError, object, text, safeEqual, registerCredentialEnv } from './security.js';
interface ControllerTools {dispatch(role:'executor',name:string,args:unknown,signal:AbortSignal):Promise<Record<string,unknown>>}
// This token reaches only the trusted DSH runtime; sandbox children have no network or token.
export async function startToolBroker(tools:ControllerTools) {
    let token=randomBytes(32).toString('hex'),closing=false;
    const controllers=new Set<AbortController>(),handlers=new Set<Promise<void>>();
    const server=createServer((req,res)=>{
        const handler=(async()=>{
            const controller=new AbortController();controllers.add(controller);
            const disconnected=()=>{if(!res.writableFinished)controller.abort();};res.once('close',disconnected);
            try{
                const address=server.address(),port=address&&typeof address!=='string'?address.port:0;
                if(closing)throw new DomainError('TOOL_BROKER_CLOSING',503);
                if(req.headers.host!==`127.0.0.1:${port}`||req.headers.origin!==undefined)throw new DomainError('TOOL_BROKER_ORIGIN_DENIED',403);
                if(!safeEqual(req.headers.authorization??'','Bearer '+token))throw new DomainError('TOOL_BROKER_UNAUTHORIZED',401);
                if(req.method!=='POST'||req.url!=='/tools'||!req.headers['content-type']?.startsWith('application/json'))throw new DomainError('TOOL_BROKER_ROUTE_DENIED',403);
                let bytes=0;const chunks:Buffer[]=[];
                for await(const chunk of req){bytes+=chunk.length;if(bytes>2400000)throw new DomainError('TOOL_BROKER_BODY_LIMIT',413);chunks.push(chunk);}
                const body=object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                if(Object.keys(body).some(k=>!['name','args'].includes(k)))throw new DomainError('TOOL_BROKER_SCOPE_DENIED',403);
                const result=await tools.dispatch('executor',text(body.name,80),body.args,controller.signal);
                res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(result));
            }catch(e){if(!res.destroyed&&!res.headersSent){res.writeHead(e instanceof DomainError?e.status:500,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:e instanceof DomainError?e.code:'NATIVE_TOOL_FAILED'}));}}
            finally{res.off('close',disconnected);controllers.delete(controller);}
        })();
        handlers.add(handler);void handler.finally(()=>handlers.delete(handler));
    });
    server.headersTimeout=5000;server.requestTimeout=10000;
    server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();
    if(!address||typeof address==='string')throw new DomainError('TOOL_BROKER_BINDING_FAILED',500);
    registerCredentialEnv('DM_TOOL_PROXY_TOKEN');
    return {url:`http://127.0.0.1:${address.port}/tools`,token,async close(){closing=true;for(const c of controllers)c.abort();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await Promise.all(handlers);token='';}};
}
