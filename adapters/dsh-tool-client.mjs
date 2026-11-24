// Trusted-runtime loopback client, no paid API, redirect, retry or fallback.
export function toolClient(url,token){
    const target=new URL(url);
    if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!target.port||target.pathname!=='/tools'||target.username||target.password||target.search||target.hash||!token)throw Error('TOOL_CLIENT_BINDING_DENIED');
    return async(name,args,signal)=>{
        const response=await fetch(target,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({name,args}),signal:AbortSignal.any([signal,AbortSignal.timeout(65000)])});
        if(!response.headers.get('content-type')?.includes('application/json'))throw Error('TOOL_CLIENT_RESPONSE_DENIED');
        const reader=response.body?.getReader();if(!reader)throw Error('TOOL_CLIENT_RESPONSE_DENIED');
        let bytes=0;const chunks=[];
        try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>2400000)throw Error('TOOL_CLIENT_RESPONSE_LIMIT');chunks.push(value);}}
        finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
        const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!result||typeof result!=='object'||Array.isArray(result))throw Error('TOOL_CLIENT_RESPONSE_DENIED');
        if(!response.ok)throw Error(typeof result.error==='string'&&/^[A-Z0-9_]{1,80}$/.test(result.error)?result.error:'TOOL_CLIENT_FAILED');
        return result;
    };
}
