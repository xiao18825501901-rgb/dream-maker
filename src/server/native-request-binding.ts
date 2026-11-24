import type {NativeRequestBinding} from '../shared/native-request.js';
import {DomainError,hasSecret,object} from './security.js';
const fields=['schema','projectId','runId','engineeringMode','configurationHash','planVersionHash','specHash','dispatchId','generation','role','roleId','work','bodyHash','routeHash'];
const ref=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
/** Exact internal contract; no URLs, credential/proof fields or mutable object aliases. */
export function nativeRequestBinding(raw:unknown,role:string):NativeRequestBinding {
 const fail=():never=>{throw new DomainError('NATIVE_REQUEST_BINDING_INVALID',409);};
 let value:Record<string,unknown>,work:Record<string,unknown>;try{value=object(raw);work=object(value.work);}catch{return fail();}
 if(Object.keys(value).length!==fields.length||fields.some(k=>!Object.hasOwn(value,k))||value.schema!=='dream-maker.native-request-binding.v1'||
  !['classic','custom'].includes(String(value.engineeringMode))||!['planner2','executor','reviewer'].includes(role)||value.role!==role||
  !['projectId','runId','dispatchId','generation','roleId'].every(k=>ref(value[k]))||!['configurationHash','planVersionHash','specHash','bodyHash','routeHash'].every(k=>digest(value[k]))||
  (role==='executor'?value.roleId==='planner2'||value.roleId==='reviewer':value.roleId!==role)||hasSecret(JSON.stringify(value)))return fail();
 if(work.kind==='QUALIFICATION'){if(value.engineeringMode!=='custom'||!exact(work,['kind','probeId','bindingHash'])||typeof work.probeId!=='string'||!/^custom_probe_[A-Za-z0-9_-]{1,100}$/.test(work.probeId)||!digest(work.bindingHash))return fail();}
 else if(role!=='executor'){if(work.kind!=='SUPERVISION'||!exact(work,['kind']))return fail();}
 else if(work.kind==='TASK'){if(!exact(work,['kind','taskIdHash','executorSliceId'])||!digest(work.taskIdHash)||work.executorSliceId!==null&&!ref(work.executorSliceId))return fail();}
 else if(work.kind==='REPAIR'){if(!exact(work,['kind','round','inputHash'])||!Number.isSafeInteger(work.round)||Number(work.round)<1||!digest(work.inputHash))return fail();}
 else return fail();
 return structuredClone(value) as unknown as NativeRequestBinding;
}
