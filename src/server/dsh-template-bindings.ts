import {isAbsolute,resolve} from 'node:path';
import {DomainError} from './security.js';
/** One roster for startup admission, audit and the adapter; include the SDK actually launched. */
export function dshTemplateBindingFiles(template:Record<string,unknown>):string[]{
    const invalid=():never=>{throw new DomainError('NATIVE_DSH_TEMPLATE_INVALID',409);};
    if(!template||typeof template.sdkRoot!=='string'||!isAbsolute(template.sdkRoot)||
        !Array.isArray(template.patches)||!Array.isArray(template.dependencyFiles))invalid();
    const files=[template.hostModule,template.eventModule,template.hostScript,template.dshBin,
        resolve(template.sdkRoot as string,'lib/index.js'),template.verifierModule,...template.patches as unknown[],...template.dependencyFiles as unknown[]];
    if(files.length>256||files.some(p=>typeof p!=='string'||p.length>4096||p.includes('\0')||!isAbsolute(p)))invalid();
    return [...new Set(files as string[])];
}
