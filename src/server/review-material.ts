import { DomainError, hasSecret,hash } from './security.js';

/** JSON strings can contain another serialized JSON document (planText, taskData,
 * stdin and source files). Scan decoded values as well as the outer text. */
export function assertReviewMaterialSafe(value:unknown):void {
    const pending:{value:unknown;key?:string;contextText?:string;depth:number}[]=[{value,depth:0}],seen=new Set<object>(),scanned=new Set<string>(),scannedKeys=new Set<string>(),counted=new Set<string>();
    let bytes=0,nodes=0;
    while(pending.length){
        const item=pending.pop()!;
        if(++nodes>100000||item.depth>64)throw new DomainError('REVIEW_PACKET_LIMIT',413);
        if(typeof item.value==='string'){
            const text=item.value;
            if(hasSecret(text)||(item.key!==undefined&&hasSecret(JSON.stringify({[item.key]:text})))||
                item.contextText!==undefined&&hasSecret(JSON.stringify({[text]:item.contextText})))
                throw new DomainError('REVIEW_SECRET_IN_MATERIAL',403);
            const contextual=item.contextText!==undefined||item.key!==undefined;
            const checked=contextual?scannedKeys:scanned,identity=item.contextText!==undefined?hash({direction:'KEY',key:text,value:item.contextText}):item.key!==undefined?hash({direction:'VALUE',key:item.key,value:text}):text;
            if(checked.has(identity))continue;checked.add(identity);if(!counted.has(text)){counted.add(text);bytes+=Buffer.byteLength(text);}
            if(bytes>8*512000)throw new DomainError('REVIEW_PACKET_LIMIT',413);
            if(item.contextText!==undefined)pending.push({value:item.contextText,key:text,depth:item.depth+1});
            // Logs need not be a single JSON document. Decode valid JSON escapes for
            // scanning even inside prefixes/JSONL, without altering the actual evidence.
            const unescaped=text.replace(/\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/g,escape=>JSON.parse('"'+escape+'"') as string);
            if(unescaped!==text)pending.push({value:unescaped,key:item.key,contextText:item.contextText,depth:item.depth+1});
            if(/^[\s]*[\[{"]/.test(text)){
                let decoded:unknown;try{decoded=JSON.parse(text);}catch{continue;}
                if(decoded!==text)pending.push({value:decoded,key:typeof decoded==='string'?item.key:undefined,contextText:typeof decoded==='string'?item.contextText:undefined,depth:item.depth+1});
            }
        }else if(item.value&&typeof item.value==='object'&&!seen.has(item.value)){
            seen.add(item.value);
            for(const [key,child] of Object.entries(item.value)){
                if(hasSecret(key))throw new DomainError('REVIEW_SECRET_IN_MATERIAL',403);
                pending.push({value:child,key,depth:item.depth+1});
                if(/[\\"'\u0000-\u001f]/.test(key))pending.push({value:key,contextText:typeof child==='string'?child:undefined,depth:item.depth+1});
            }
        }
    }
}
