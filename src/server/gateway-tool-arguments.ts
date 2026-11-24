import {DomainError,object} from './security.js';
type Fragment={id:string;name:string;arguments:string;initial?:unknown};
export type GatewayToolArgumentFailureDetail=
 |'JSON_PARSE'|'JSON_DUPLICATE_KEY'|'JSON_NESTING_LIMIT'|'JSON_SHAPE'
 |'TOOL_ARGUMENTS_TYPE'|'TOOL_ARGUMENTS_OBJECT'|'TOOL_ARGUMENTS_CONFLICT'
 |'TOOL_CALLS_TYPE'|'TOOL_CALLS_LIMIT'|'TOOL_CALL_TYPE'|'TOOL_CALL_INDEX'
 |'TOOL_CALL_FUNCTION_TYPE'|'TOOL_CALL_ID'|'TOOL_CALL_NAME'|'TOOL_CALL_ARGUMENTS_TYPE'
 |'FUNCTION_CALL_TYPE'|'FUNCTION_CALL_NAME'|'FUNCTION_CALL_ARGUMENTS'
 |'MESSAGES_BLOCK_TYPE'|'MESSAGES_INDEX'|'MESSAGES_TOOL_ID'|'MESSAGES_TOOL_NAME'
 |'MESSAGES_DELTA_TYPE'|'MESSAGES_PARTIAL_JSON'|'MESSAGES_EVENT_ORDER'|'MESSAGES_TOOL_LIMIT'
 |'TOOL_CALL_INCOMPLETE';
export class GatewayToolArgumentError extends DomainError {
 constructor(public readonly detail:GatewayToolArgumentFailureDetail){super('MODEL_GATEWAY_TOOL_ARGUMENTS_INVALID',502);}
}
const invalid=(detail:GatewayToolArgumentFailureDetail):never=>{throw new GatewayToolArgumentError(detail);};
/** One interpretation of the raw JSON: check all decoded strings and reject duplicate
 * keys (including escaped aliases) before discarded arguments can reach an SDK.
 * An iterative scan avoids recursive parsing; input and nesting are bounded. */
export function parseGatewayJson(raw:string,safe:(text:string)=>void):unknown {
 try{
  safe(raw);const parsed=JSON.parse(raw);
  type Frame={kind:'object';keys:Set<string>;expectKey:boolean}|{kind:'array'};
  const frames:Frame[]=[];let offset=0;
  const symbols=(end:number)=>{
   for(;offset<end;offset++){
    const char=raw[offset],top=frames.at(-1);
    if(char==='{'||char==='['){if(frames.length>=256)return invalid('JSON_NESTING_LIMIT');frames.push(char==='{'?{kind:'object',keys:new Set<string>(),expectKey:true}:{kind:'array'});}
    else if(char==='}'||char===']'){if(!top||top.kind!==(char==='}'?'object':'array'))return invalid('JSON_SHAPE');frames.pop();}
    else if(char===','&&top?.kind==='object')top.expectKey=true;
   }
  };
  // The alternatives do not overlap, so the scan is linear rather than backtracking.
  for(const match of raw.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)){
   symbols(match.index!);const decoded=JSON.parse(match[0]) as string,top=frames.at(-1);safe(decoded);
   if(top?.kind==='object'&&top.expectKey){if(top.keys.has(decoded))return invalid('JSON_DUPLICATE_KEY');top.keys.add(decoded);top.expectKey=false;}
   offset=match.index!+match[0].length;
  }
  symbols(raw.length);if(frames.length)return invalid('JSON_SHAPE');return parsed;
 }
 catch(error){if(error instanceof DomainError)throw error;return invalid('JSON_PARSE');}
}
/** Decode complete tool arguments before the SDK can assemble/execute them.
 * The caller also bounds the whole upstream response to 2MB and withholds tool events. */
export class GatewayToolArguments {
 private messages=new Map<number,Fragment>();private closedMessages=new Set<number>();
 private chat=new Map<number,Fragment>();
 constructor(private safe:(text:string)=>void){}
 private index(value:unknown,detail:GatewayToolArgumentFailureDetail):number {if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)>1023)return invalid(detail);return Number(value);}
 private append(previous:string,value:unknown,detail:GatewayToolArgumentFailureDetail):string {if(value===undefined)return previous;if(typeof value!=='string')return invalid(detail);return previous+value;}
 private record(value:unknown,detail:GatewayToolArgumentFailureDetail):Record<string,unknown>{try{return object(value);}catch{return invalid(detail);}}
 private checkInput(value:unknown,encoded=false):void {
  if(value===undefined||encoded&&value==='')return;
  try{
   if(encoded&&typeof value!=='string')return invalid('TOOL_ARGUMENTS_TYPE');
   const parsed=encoded?parseGatewayJson(String(value),this.safe):value;
   this.record(parsed,'TOOL_ARGUMENTS_OBJECT');this.safe(JSON.stringify(parsed));
  }catch(error){if(error instanceof DomainError)throw error;return invalid('TOOL_ARGUMENTS_OBJECT');}
 }
 private check(fragment:Fragment){
  this.safe(fragment.id);this.safe(fragment.name);this.checkInput(fragment.initial);this.checkInput(fragment.arguments,true);
  if(fragment.arguments&&fragment.initial!==undefined&&Object.keys(this.record(fragment.initial,'TOOL_ARGUMENTS_OBJECT')).length)return invalid('TOOL_ARGUMENTS_CONFLICT');
 }
 messagesContent(part:Record<string,unknown>):void {if(part.type==='tool_use')this.checkInput(part.input);}
 messagesEvent(value:Record<string,unknown>):void {
  if(value.type==='content_block_start'){
   const block=this.record(value.content_block??{},'MESSAGES_BLOCK_TYPE');if(block.type!=='tool_use')return;
   const index=this.index(value.index,'MESSAGES_INDEX');if(this.messages.has(index)||this.closedMessages.has(index))return invalid('MESSAGES_EVENT_ORDER');if(this.messages.size+this.closedMessages.size>=1024)return invalid('MESSAGES_TOOL_LIMIT');
   const fragment={id:this.append('',block.id,'MESSAGES_TOOL_ID'),name:this.append('',block.name,'MESSAGES_TOOL_NAME'),arguments:'',initial:block.input};this.check(fragment);this.messages.set(index,fragment);
  }else if(value.type==='content_block_delta'){
   const delta=this.record(value.delta??{},'MESSAGES_DELTA_TYPE');if(delta.type!=='input_json_delta')return;
   const fragment=this.messages.get(this.index(value.index,'MESSAGES_INDEX'));if(!fragment)return invalid('MESSAGES_EVENT_ORDER');if(typeof delta.partial_json!=='string')return invalid('MESSAGES_PARTIAL_JSON');fragment.arguments+=delta.partial_json;
  }else if(value.type==='content_block_stop'){
   const index=this.index(value.index,'MESSAGES_INDEX'),fragment=this.messages.get(index);if(!fragment)return;
   this.check(fragment);this.messages.delete(index);this.closedMessages.add(index);
  }
 }
 chatOutput(output:Record<string,unknown>,streaming:boolean):void {
   if(output.tool_calls!==undefined&&output.tool_calls!==null){
   if(!Array.isArray(output.tool_calls))return invalid('TOOL_CALLS_TYPE');
   if(output.tool_calls.length>1024)return invalid('TOOL_CALLS_LIMIT');
   output.tool_calls.forEach((raw,position)=>{
    const call=this.record(raw,'TOOL_CALL_TYPE'),index=streaming?this.index(call.index,'TOOL_CALL_INDEX'):position,fn=this.record(call.function??{},'TOOL_CALL_FUNCTION_TYPE');
    const fragment=streaming?(this.chat.get(index)??{id:'',name:'',arguments:''}):{id:'',name:'',arguments:''};
    fragment.id=this.append(fragment.id,call.id,'TOOL_CALL_ID');fragment.name=this.append(fragment.name,fn.name,'TOOL_CALL_NAME');fragment.arguments=this.append(fragment.arguments,fn.arguments,'TOOL_CALL_ARGUMENTS_TYPE');
    if(streaming){if(!this.chat.has(index)&&this.chat.size>=1024)return invalid('TOOL_CALLS_LIMIT');this.chat.set(index,fragment);}else this.check(fragment);
   });
  }
   if(output.function_call!==undefined&&output.function_call!==null){
   const fn=this.record(output.function_call,'FUNCTION_CALL_TYPE'),fragment=streaming?(this.chat.get(1024)??{id:'',name:'',arguments:''}):{id:'',name:'',arguments:''};
   fragment.name=this.append(fragment.name,fn.name,'FUNCTION_CALL_NAME');fragment.arguments=this.append(fragment.arguments,fn.arguments,'FUNCTION_CALL_ARGUMENTS');
   if(streaming)this.chat.set(1024,fragment);else this.check(fragment);
  }
 }
 complete():void {if(this.messages.size)return invalid('TOOL_CALL_INCOMPLETE');for(const fragment of this.chat.values())this.check(fragment);this.chat.clear();}
}
