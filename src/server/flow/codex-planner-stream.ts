import type {NativeUsage} from '../native-budget.js';
import {DomainError,object} from '../security.js';

const invalid=():never=>{throw new DomainError('MODEL_GATEWAY_COMPLETION_INVALID',502);};
/** Inspect native Responses SSE before releasing any supervisor output to Codex. */
export class CodexPlannerStream {
 private id='';
 private messageId='';
  private messageItemSeen=false;
  private readonly reasoningItemIds=new Set<string>();
 // The tool round trip: a call item opens, streams its arguments, closes, and the next
 // model round replays it. The executor arm of this wire (codex exec under an owned
 // executor id) is answered with up to sixteen of them, so the same validation the paid
 // planner lane runs on messages is stated here for calls.
 private readonly closedCalls=new Map<string,{call:string;name:string;arguments:string}>();
 private calls=0;
 private openCall:{id:string;call:string;name:string;arguments:string}|null=null;
 private text='';
 private created=false;
  eventCount=0;
  lastEventType:string|null=null;
  lastEventDetail:string|null=null;
 completed=false;
 private observedModel='';
 /** `callsAllowed` is the executor arm of this wire: only that lane is answered with function_call
  * items. The paid planner lane keeps the single-message shape it has always had. */
 constructor(private readonly model:string,private readonly paid?:{qualifiedModel:string;maxInputTokens:number;maxOutputTokens:number},
  private readonly callsAllowed=false){}
 observe(event:Record<string,unknown>):{id:string;text:string;calls:{itemId:string;callId:string;name:string;arguments:string}[];usage:NativeUsage|null;usageLimitExceeded:boolean}|undefined{
  if(this.completed) return invalid();
  const type=event.type;
   this.eventCount++;
   this.lastEventType=typeof type==='string'&&/^response\.[a-z0-9_.-]{1,120}$/.test(type)?type:null;
  if(type==='response.created'||type==='response.in_progress'||type==='response.completed'){
   const response=object(event.response);
    this.lastEventDetail=`${type}:response_status=${typeof response.status==='string'&&response.status.length<=32?response.status:'INVALID'}:error=${response.error==null?'NONE':'PRESENT'}:output_length=${Array.isArray(response.output)?String(response.output.length):'INVALID'}`;
   if(typeof response.id!=='string'||!/^[-A-Za-z0-9_]{1,200}$/.test(response.id)||typeof response.model!=='string'||
      response.model!==this.model&&response.model!==this.paid?.qualifiedModel||
      this.paid&&this.observedModel&&response.model!==this.observedModel||
      this.id&&this.id!==response.id||(!this.created)!==(type==='response.created'))return invalid();
   this.id=response.id;this.observedModel=response.model;this.created=true;
   if(type!=='response.completed'){
    if(response.status!=='in_progress'||!Array.isArray(response.output)||response.output.length)return invalid();
    return;
   }
   if(response.status!=='completed'||response.error!=null||!Array.isArray(response.output))return invalid();
   const items=response.output.map(object);
   if(items.some(i=>i.type!=='message'&&i.type!=='reasoning'&&(i.type!=='function_call'||!this.callsAllowed)))return invalid();
   // Every call the transcript closed has to be echoed once, member by member, in order.
   const echoedCalls=items.filter(i=>i.type==='function_call');
   if(echoedCalls.length!==this.closedCalls.size)return invalid();
   let echo=0;
   for(const item of items){
    if(item.type!=='function_call')continue;
    const call=this.closedCalls.get(item.id as string);
    if(!call||item.call_id!==call.call||item.name!==call.name||item.arguments!==call.arguments||item.status!=='completed'||item.role!==undefined&&item.role!=='')return invalid();
    echo+=1;
   }
   if(echo!==this.closedCalls.size)return invalid();
   const reasoning=items.filter(i=>i.type==='reasoning');
   if(reasoning.length!==this.reasoningItemIds.size||reasoning.some(i=>typeof i.id!=='string'||!this.reasoningItemIds.has(i.id))||
      [...this.reasoningItemIds].some(id=>reasoning.filter(i=>i.id===id).length!==1))return invalid();
   const messages=items.filter(i=>i.type==='message');
   if(!this.callsAllowed){
    // The planner lane answers in text exactly once; a call is not its answer.
    if(messages.length!==1||!this.text.trim())return invalid();
   }else{
    if(messages.length>1)return invalid();
    // An executor closes a turn on its calls alone; only a turn that asked for nothing
    // has to carry the answer text, and a turn with calls may still describe them.
    if(this.calls>0&&messages.length===0&&this.text.trim())return invalid();
    if(this.calls===0&&(messages.length!==1||!this.text.trim()))return invalid();
   }
   if(messages.length===1){
    const m=messages[0];
    if(m.status!=='completed'||m.role!=='assistant'||typeof m.id!=='string'||!m.id||this.messageId&&m.id!==this.messageId||!Array.isArray(m.content)||m.content.length!==1)return invalid();
    this.messageId=m.id;
    const part=object(m.content[0]);if(part.type!=='output_text'||part.text!==this.text)return invalid();
   }else if(this.text.trim())return invalid();
   let usage:NativeUsage|null=null,usageLimitExceeded=false;
   if(response.usage!=null){
    const u=object(response.usage),cached=u.input_tokens_details==null?undefined:object(u.input_tokens_details).cached_tokens;
    if(![u.input_tokens,u.output_tokens].every(v=>Number.isSafeInteger(v)&&Number(v)>=0))return invalid();
    if(this.paid){
     if(u.total_tokens!==undefined&&(!Number.isSafeInteger(u.total_tokens)||u.total_tokens!==Number(u.input_tokens)+Number(u.output_tokens)))return invalid();
     usageLimitExceeded=Number(u.input_tokens)>this.paid.maxInputTokens||Number(u.output_tokens)>this.paid.maxOutputTokens;
    }
    if(cached!==undefined&&(!Number.isSafeInteger(cached)||Number(cached)<0||Number(cached)>Number(u.input_tokens)))return invalid();
    if(cached!==undefined)usage={inputTokens:Number(u.input_tokens),outputTokens:Number(u.output_tokens),cacheHitTokens:Number(cached)};
   }
   // The calls are part of the answer on the executor arm of this wire: the round trip the CLI
   // replays next turn is exactly these items, in this order, with these argument strings.
   const calls=[...this.closedCalls.entries()].map(([itemId,call])=>Object.freeze({itemId,callId:call.call,name:call.name,arguments:call.arguments}));
   this.completed=true;return{id:this.id,text:this.text,calls,usage,usageLimitExceeded};
  }
  if(!this.created)return invalid();
  if(type==='response.metadata'){
   if(event.metadata!==undefined&&(!event.metadata||typeof event.metadata!=='object'||Array.isArray(event.metadata)))return invalid();
   if(event.headers!==undefined&&(!event.headers||typeof event.headers!=='object'||Array.isArray(event.headers)))return invalid();
   if(event.response_id!==undefined&&(typeof event.response_id!=='string'||!event.response_id||
      event.response_id.length>200||event.response_id.includes('\0')))return invalid();
   this.lastEventDetail=`response.metadata:metadata=${event.metadata===undefined?'ABSENT':'OBJECT'}:headers=${event.headers===undefined?'ABSENT':'OBJECT'}:response_id=${event.response_id===undefined?'ABSENT':'BOUNDED_STRING'}`;
   return;
  }
  if(type==='response.output_item.added'||type==='response.output_item.done'){
   const item=object(event.item);
     if(item.type==='message'){
      const part=Array.isArray(item.content)&&item.content.length===1?object(item.content[0]):null;
      this.lastEventDetail=`${type}:MESSAGE:item_id=${typeof item.id!=='string'?'INVALID':this.messageId?item.id===this.messageId?'MATCH':'MISMATCH':'UNBOUND'}:role=${typeof item.role==='string'&&item.role.length<=32?item.role:'INVALID'}:content_length=${Array.isArray(item.content)?item.content.length:'INVALID'}:text=${part?.type==='output_text'&&part.text===this.text?'MATCH':'MISMATCH'}`;
     }
   if(item.type==='reasoning'){
    if(typeof item.id!=='string'||!/^[-A-Za-z0-9_]{1,200}$/.test(item.id)||
       item.summary!==undefined&&!Array.isArray(item.summary)||item.content!==undefined&&!Array.isArray(item.content))return invalid();
    if(type==='response.output_item.added'){
     if(this.reasoningItemIds.has(item.id))return invalid();
     this.reasoningItemIds.add(item.id);
    }else if(!this.reasoningItemIds.has(item.id))return invalid();
    return;
   }
   // A function call the executor asked for: it opens empty, streams its arguments, and closes
   // with them settled. `exec_command` and the rest of the CLI's own tools are named here, so the
   // name and the call id are the whole identity of the round trip this turn replays.
   if(item.type==='function_call'){
    if(!this.callsAllowed)return invalid();
    if(typeof item.id!=='string'||!/^[-A-Za-z0-9_]{1,200}$/.test(item.id)||typeof item.call_id!=='string'||!/^[-A-Za-z0-9_]{1,200}$/.test(item.call_id)||
       typeof item.name!=='string'||!item.name||item.name.length>128||this.calls>16)return invalid();
    this.lastEventDetail=`${type}:FUNCTION_CALL:item_id=${typeof item.id!=='string'?'INVALID':'BOUNDED'}:name=${item.name}:call_id=${typeof item.call_id!=='string'?'INVALID':'BOUNDED'}`;
    if(type==='response.output_item.added'){
     if(this.openCall||this.closedCalls.has(item.id)||(item.arguments!==undefined&&item.arguments!=='')||
        item.status!==undefined&&item.status!=='in_progress')return invalid();
     this.calls+=1;
     this.openCall={id:item.id,call:item.call_id,name:item.name,arguments:''};
     return;
    }
    const closed=this.openCall;
    if(!closed||closed.id!==item.id||closed.call!==item.call_id||closed.name!==item.name||item.status!=='completed'||
       item.arguments!==closed.arguments)return invalid();
    this.openCall=null;
    this.closedCalls.set(item.id,{call:closed.call,name:closed.name,arguments:closed.arguments});
    return;
   }
   if(type==='response.output_item.added'){if(this.openCall)return invalid();}
   if(item.type!=='message'||item.role!=='assistant'||typeof item.id!=='string'||!item.id||!Array.isArray(item.content))return invalid();
   if(type==='response.output_item.added'){
    if(this.messageId||item.content.length)return invalid();
    this.messageId=item.id;
     this.messageItemSeen=true;
    }else{
     if(item.content.length!==1||object(item.content[0]).type!=='output_text'||object(item.content[0]).text!==this.text||this.messageId&&item.id!==this.messageId)return invalid();
     this.messageId=item.id;
     this.messageItemSeen=true;
    }
   return;
  }
  if(type==='response.function_call_arguments.delta'||type==='response.function_call_arguments.done'){
   if(!this.callsAllowed)return invalid();
   const open=this.openCall;
   if(!open||typeof event.item_id!=='string'||event.item_id!==open.id||event.output_index!==undefined&&!Number.isSafeInteger(event.output_index))return invalid();
   if(type==='response.function_call_arguments.delta'){
    if(typeof event.delta!=='string'||open.arguments.length+event.delta.length>65536)return invalid();
    open.arguments+=event.delta;
    this.lastEventDetail='response.function_call_arguments.delta:item_id=MATCH:length='+String(open.arguments.length);
    return;
   }
   if(typeof event.arguments!=='string'||event.arguments!==open.arguments)return invalid();
   try{const parsed:unknown=JSON.parse(open.arguments);if(parsed===null||typeof parsed!=='object'||Array.isArray(parsed))return invalid();}catch{return invalid();}
   this.lastEventDetail='response.function_call_arguments.done:item_id=MATCH:length='+String(open.arguments.length);
   return;
  }
  if(type==='response.reasoning_summary_part.added'||type==='response.reasoning_summary_part.done'||
     type==='response.reasoning_summary_text.delta'||type==='response.reasoning_summary_text.done'||
     type==='response.reasoning_text.delta'||type==='response.reasoning_text.done'){
   if(typeof event.item_id!=='string'||!this.reasoningItemIds.has(event.item_id))return invalid();
   if(type.startsWith('response.reasoning_summary_')&&
      (!Number.isSafeInteger(event.summary_index)||Number(event.summary_index)<0||Number(event.summary_index)>999))return invalid();
   if(type==='response.reasoning_summary_part.added'||type==='response.reasoning_summary_part.done'){
    const part=object(event.part);
    if(part.type!=='summary_text'||typeof part.text!=='string')return invalid();
   }else if(type==='response.reasoning_summary_text.delta'||type==='response.reasoning_text.delta'){
    if(typeof event.delta!=='string')return invalid();
   }else if(type==='response.reasoning_summary_text.done'||type==='response.reasoning_text.done'){
    if(typeof event.text!=='string')return invalid();
   }
   return;
  }
  if(type==='response.output_text.delta')this.lastEventDetail='response.output_text.delta:item_id='+(typeof event.item_id!=='string'?'MISSING':event.item_id===this.messageId?'MATCH':'MISMATCH')+':message_id_set='+(this.messageId?'YES':'NO')+':event_item_id_length='+(typeof event.item_id==='string'?String(Buffer.byteLength(event.item_id,'utf8')):'INVALID')+':message_item_seen='+(this.messageItemSeen?'YES':'NO')+':content_index='+(Number.isSafeInteger(event.content_index)?String(event.content_index):'INVALID')+':delta='+(typeof event.delta==='string'?'STRING':'INVALID');
  if(type==='response.output_text.done')this.lastEventDetail='response.output_text.done:item_id='+(typeof event.item_id!=='string'?'MISSING':event.item_id===this.messageId?'MATCH':'MISMATCH')+':content_index='+(Number.isSafeInteger(event.content_index)?String(event.content_index):'INVALID')+':text='+(typeof event.text==='string'&&event.text===this.text?'MATCH':'MISMATCH')+':expected_length='+String(Buffer.byteLength(this.text,'utf8'))+':event_length='+(typeof event.text==='string'?String(Buffer.byteLength(event.text,'utf8')):'INVALID');
  if(typeof event.item_id!=='string'||event.content_index!==0||(this.messageId?event.item_id!==this.messageId:event.item_id!==''))return invalid();
  if(type==='response.output_text.delta'&&typeof event.delta==='string'){this.text+=event.delta;return;}
  if(type==='response.output_text.done'&&event.text===this.text)return;
  if(type==='response.content_part.added'||type==='response.content_part.done'){
   const part=object(event.part);
   this.lastEventDetail=`${type}:item_id=${typeof event.item_id!=='string'?'MISSING':event.item_id===this.messageId?'MATCH':'MISMATCH'}:content_index=${Number.isSafeInteger(event.content_index)?String(event.content_index):'INVALID'}:part_type=${typeof part.type==='string'&&part.type.length<=32?part.type:'INVALID'}:text=${part.type==='output_text'&&part.text===(type==='response.content_part.added'?'':this.text)?'MATCH':'MISMATCH'}`;
   if(part.type==='output_text'&&part.text===(type==='response.content_part.added'?'':this.text))return;
  }
  return invalid();
 }
}