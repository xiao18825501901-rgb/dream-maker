import type {NativeExecutionFactory} from '../engine.js';
import type {CustomFlowConfigSnapshot} from '../../shared/flow-configuration.js';
import {DomainError} from '../security.js';
import {assertCustomDirectRoles} from './custom-role-identity.js';

/** Only the controller constructs this factory. No config/HTTP flag can replace it. */
export function customNativeFactory(factory:NativeExecutionFactory|undefined){
 if(!factory||typeof factory.assertCustomReady!=='function'||typeof factory.custom!=='function'||typeof factory.verify!=='function'||typeof factory.close!=='function')throw new DomainError('CUSTOM_MAGPIE_SECURITY_REQUIRED',409,'自定义模式的真实运行器和资格检查尚未接通。');
 return factory as NativeExecutionFactory&Required<Pick<NativeExecutionFactory,'assertCustomReady'|'custom'>>;
}
export function assertCustomQualification(factory:NativeExecutionFactory|undefined,snapshot:CustomFlowConfigSnapshot):void {
 const owned=customNativeFactory(factory);assertCustomDirectRoles(snapshot);
 const result:unknown=owned.assertCustomReady(structuredClone(snapshot));
 if(result!==undefined){
  // This is a synchronous read of owned evidence. Neither a boolean nor a future
  // result may become a build grant; an invalid async rejection stays observed.
  if(result instanceof Promise)void result.catch(()=>{});
  throw new DomainError('CUSTOM_QUALIFICATION_RESULT_INVALID',409);
 }
}
