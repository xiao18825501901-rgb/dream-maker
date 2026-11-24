// Existing dm/verify contract. The operator's sealed oracle is never supplied by generated code.
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WslVerifier } from '../dist/server/wsl-verifier.js';
import { DomainError, hash, object, within } from '../dist/server/security.js';
import {resourceImplementationFiles} from '../dist/server/sandbox-resource.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const implementation=['dist/server/wsl-sandbox.js','dist/server/wsl-verifier.js','scripts/isolation/wsl-worker.py','dist/server/security.js','dist/server/workspace.js','dist/server/process.js',...resourceImplementationFiles];
export function createAuditedWslVerifier(raw,audit) {
    const config=structuredClone(raw),evidence=structuredClone(audit.evidenceFiles??[]);
    if(config.schema!=='dream-maker.wsl-verifier-binding.v1'||!isAbsolute(config.registryRoot))throw new DomainError('VERIFIER_REGISTRY_BINDING_REQUIRED',409);
    const plans=object(config.plans);
    return async(input,emit,signal)=>{
        for(const name of implementation){const path=within(root,name);if(!evidence.some(f=>resolve(f.path)===path&&f.sha256===hash(readFileSync(path))))throw new DomainError('VERIFIER_IMPLEMENTATION_NOT_AUDITED',409);}
        const item=object(plans[input.specHash]);
        const path=within(config.registryRoot,item.relativePath);
        if(!evidence.some(f=>resolve(f.path)===path&&f.sha256===item.sha256)||hash(readFileSync(path))!==item.sha256)
            throw new DomainError('TRUSTED_VERIFIER_PLAN_NOT_AUDITED',409);
        const rel=relative(resolve(input.workspace),resolve(config.registryRoot));
        if(!rel||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel)))throw new DomainError('VERIFIER_REGISTRY_INSIDE_SOURCE_DENIED',409);
        const verifier=new WslVerifier(root,config.registryRoot,()=>({relativePath:item.relativePath,sha256:item.sha256}));
        return verifier.verify({...input,signal},emit);
    };
}
export async function verify(input,emit,signal) {
    const configPath=resolve(root,'config/wsl-verifier.local.json'),auditPath=process.env.DM_NATIVE_AUDIT_PATH;
    if(!auditPath)throw new DomainError('NATIVE_AUDIT_REQUIRED',409);
    const audit=JSON.parse(readFileSync(auditPath,'utf8'));
    if(audit.status!=='LIVE_READY')throw new DomainError('NATIVE_AUDIT_NOT_READY',409);
    if(!audit.evidenceFiles?.some(f=>resolve(f.path)===configPath&&f.sha256===hash(readFileSync(configPath))))
        throw new DomainError('VERIFIER_CONFIG_NOT_AUDITED',409);
    return createAuditedWslVerifier(JSON.parse(readFileSync(configPath,'utf8')),audit)(input,emit,signal);
}
