import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
export const PUBLIC_FILES=['index.html','style.css','contracts.js','dom.js','views.js','ui.js','demo-api.js','demo-entry.js','sample.html','sample.css','sample.js','404.html','_redirects','_headers','NOTICE.txt'];
export function publicIntegrity(root) {
    const dir=resolve(root,'ui-release/public'),receipt=JSON.parse(readFileSync(resolve(root,'ui-release/build-receipt.json'),'utf8'));
    if(!Array.isArray(receipt.sourceFiles)||!receipt.sourceFiles.length)throw Error('PUBLIC_SOURCE_PROOF_REQUIRED');
    for(const f of receipt.sourceFiles){
        if(!/^src\/web\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(f.path)||f.path.includes('..'))throw Error('PUBLIC_SOURCE_PROOF_INVALID');
        const source=resolve(root,f.path);
        if(lstatSync(source).isSymbolicLink()||createHash('sha256').update(readFileSync(source)).digest('hex')!==f.sha256)throw Error('PUBLIC_SOURCE_CHANGED');
    }
    for(const p of [resolve(root,'ui-release'),dir])if(lstatSync(p).isSymbolicLink())throw Error('PUBLIC_LINK_DENIED');
    const actual=readdirSync(dir).sort();
    if(JSON.stringify(actual)!==JSON.stringify([...PUBLIC_FILES].sort())||receipt.files.length!==PUBLIC_FILES.length)throw Error('PUBLIC_ALLOWLIST_MISMATCH');
    const files=PUBLIC_FILES.map(path=>{
        const file=resolve(dir,path);if(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())throw Error('PUBLIC_LINK_DENIED');
        const data=readFileSync(file),sha256=createHash('sha256').update(data).digest('hex');
        if(!receipt.files.some(f=>f.path===path&&f.sha256===sha256&&f.bytes===data.length))throw Error('PUBLIC_HASH_MISMATCH');
        return {path,sha256,bytes:data.length};
    });
    return {dir,files,hash:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
}
