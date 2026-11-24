// Actual local HTTP gateway with synthetic upstream events. No account or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DeepSeekGateway} from '../../dist/server/deepseek-gateway.js';
import {responsesEvents} from '../../dist/server/flow/responses-wire.js';

const model='gpt-6-luna', content='{"tasks":["offline"]}';
const events=responsesEvents({id:'offline_response',model,content,toolCalls:[],usage:{prompt_tokens:1,completion_tokens:2}});
const reasoningItem={id:'reasoning_offline',type:'reasoning',summary:[{type:'summary_text',text:'offline reasoning'}]};
const reasoningEvents=[
 {type:'response.output_item.added',output_index:0,item:{id:reasoningItem.id,type:'reasoning',summary:[]}},
 {type:'response.reasoning_summary_part.added',item_id:reasoningItem.id,output_index:0,summary_index:0,part:{type:'summary_text',text:''}},
 {type:'response.reasoning_summary_text.delta',item_id:reasoningItem.id,output_index:0,summary_index:0,delta:'offline reasoning'},
 {type:'response.reasoning_summary_text.done',item_id:reasoningItem.id,output_index:0,summary_index:0,text:'offline reasoning'},
 {type:'response.reasoning_summary_part.done',item_id:reasoningItem.id,output_index:0,summary_index:0,part:{type:'summary_text',text:'offline reasoning'}},
 {type:'response.output_item.done',output_index:0,item:reasoningItem},
];
const eventBlock=value=>'event: '+value.type+'\ndata: '+JSON.stringify(value)+'\n\n';
function withEvent(wire,event,position='afterCreated'){
 const blocks=wire.split('\n\n').filter(Boolean),created=blocks.findIndex(block=>block.startsWith('event: response.created\n'));
 assert.notEqual(created,-1);
 blocks.splice(position==='beforeCreated'?created:created+1,0,eventBlock(event).trimEnd());
 return blocks.join('\n\n')+'\n\n';
}
function withReasoning(wire,{includeItem=true}={}){
 const blocks=wire.split('\n\n').filter(Boolean),out=[];
 for(const block of blocks){
  out.push(block);
  if(block.startsWith('event: response.created\n')){
   for(const event of reasoningEvents){
    if(!includeItem&&event.type==='response.output_item.added')continue;
    out.push(eventBlock(event).trimEnd());
   }
  }
  if(block.startsWith('event: response.completed\n')){
   const data=block.split('\n').find(line=>line.startsWith('data: '));
   const completed=JSON.parse(data.slice(6));
   completed.response.output.unshift(reasoningItem);
   out[out.length-1]='event: response.completed\ndata: '+JSON.stringify(completed)+'\n\n';
  }
 }
 return out.join('\n\n').trimEnd()+'\n\n';
}
for(const mode of ['complete','interrupted','different final text','tool item','unauthorized']){
 test('native Responses planner via local HTTP: '+mode,async()=>{
  let sends=0,reserved=0,outcome=null;
  const turn={},budget={
   reserveIncludedPlanner(proof){assert.equal(proof,turn);reserved++;return {id:'offline_hold',reservedMicros:0};},
   settle(_id,_usage,status){outcome=status;}
  };
  let wire=events;
  if(mode==='interrupted')wire=wire.slice(0,wire.indexOf('event: response.completed'));
  if(mode==='different final text')wire=events.split('\n\n').filter(Boolean).map(block=>{
   const type=block.match(/^event: ([^\n]+)/)?.[1];
   if(type!=='response.output_text.done')return block;
   const data=block.split('\n').find(line=>line.startsWith('data: '));
   const event=JSON.parse(data.slice(6));
   event.text='different';
   return eventBlock(event).trimEnd();
  }).join('\n\n')+'\n\n';
  if(mode==='tool item')wire=wire.replace('"type":"message"','"type":"function_call"');
  const magpie={role:'planner2',provider:'openai',responseModel:model,upstream:'http://127.0.0.1:1/backend-api/codex/responses',concreteRoute:{authentication:'oauth'},
   prepare(raw){return {body:raw,binding:{role:'planner2'}};},assertSafeResponse(){},
   async send(_p,_id,_signal,credentials){assert.equal(credentials.turn,turn);assert.equal(credentials.authorization,'Bearer synthetic');sends++;return new Response(wire,{headers:{'content-type':'text/event-stream'}});},async close(){}};
  const gateway=new DeepSeekGateway(budget,()=>assert.fail('metered price requested'),'',128,1,()=>assert.fail('direct send'),'responses',true,undefined,undefined,undefined,magpie,undefined,model,()=>turn);
  try{
   const {url,token}=await gateway.start();
   const res=await fetch(url+'/responses',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer synthetic','x-dm-gateway':mode==='unauthorized'?'other':token},body:JSON.stringify({model,stream:true,store:false,max_output_tokens:128})});
   const text=await res.text();
   if(mode==='complete'){assert.equal(res.status,200,text);assert.equal(gateway.confirmedSupervisorOutput(model,content).outcome,'COMPLETE');}
   else if(mode==='unauthorized'){assert.equal(res.status,401);assert.equal(reserved,0);}
    else{
     assert.equal(res.status,502,text);assert.notEqual(outcome,'COMPLETE');assert.ok(!text.includes('event:'));assert.throws(()=>gateway.confirmedSupervisorOutput(model,content));
     const receipt=gateway.receipts()[0];
     if(mode==='different final text'){
      assert.equal(receipt.protocolLastEventType,'response.output_text.done');
      assert.match(receipt.protocolLastEventDetail,/text=MISMATCH/);
     }
    }
   assert.equal(sends,mode==='unauthorized'?0:1);
  }finally{await gateway.close();}
 });
}

for(const mode of ['reasoning summary','reasoning summary before item']){
 test('native Responses planner protocol boundary: '+mode,async()=>{
  let sends=0,outcome=null;
  const turn={},budget={
   reserveIncludedPlanner(proof){assert.equal(proof,turn);return {id:'offline_hold',reservedMicros:0};},
   settle(_id,_usage,status){outcome=status;}
  };
  const wire=withReasoning(events,{includeItem:mode!=='reasoning summary before item'});
  const magpie={role:'planner2',provider:'openai',responseModel:model,upstream:'http://127.0.0.1:1/backend-api/codex/responses',concreteRoute:{authentication:'oauth'},
   prepare(raw){return {body:raw,binding:{role:'planner2'}};},assertSafeResponse(){},
   async send(){sends++;return new Response(wire,{headers:{'content-type':'text/event-stream'}});},async close(){}};
  const gateway=new DeepSeekGateway(budget,()=>assert.fail('metered price requested'),'',128,1,()=>assert.fail('direct send'),'responses',true,undefined,undefined,undefined,magpie,undefined,model,()=>turn);
  try{
   const {url,token}=await gateway.start();
   const res=await fetch(url+'/responses',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer synthetic','x-dm-gateway':token},body:JSON.stringify({model,stream:true,store:false,max_output_tokens:128})});
   const text=await res.text(),receipt=gateway.receipts()[0];
   if(mode==='reasoning summary'){
    assert.equal(res.status,200,text);
    assert.equal(gateway.confirmedSupervisorOutput(model,content).outcome,'COMPLETE');
    assert.equal(receipt.protocolEventCount,14);
    assert.equal(receipt.protocolLastEventType,'response.completed');
    assert.equal(receipt.networkFailureClass,null);
   }else{
    assert.equal(res.status,502,text);
    assert.notEqual(outcome,'COMPLETE');
    assert.equal(receipt.outcome,'MODEL_GATEWAY_COMPLETION_INVALID');
    assert.equal(receipt.networkFailureClass,null);
    assert.ok(!text.includes('event:'));
   }
   assert.equal(sends,1);
  }finally{await gateway.close();}
 });
}

for(const mode of ['metadata auxiliary event','metadata before created','malformed metadata']){
 test('native Responses planner protocol boundary: '+mode,async()=>{
  let sends=0,outcome=null;
  const turn={},budget={
   reserveIncludedPlanner(proof){assert.equal(proof,turn);return {id:'offline_hold',reservedMicros:0};},
   settle(_id,_usage,status){outcome=status;}
  };
  const metadata=mode==='malformed metadata'?{type:'response.metadata',metadata:['unexpected']}:{type:'response.metadata',response_id:'resp_offline',metadata:{verified:true},headers:{'x-offline':'synthetic'}};
  const wire=withEvent(events,metadata,mode==='metadata before created'?'beforeCreated':'afterCreated');
  const magpie={role:'planner2',provider:'openai',responseModel:model,upstream:'http://127.0.0.1:1/backend-api/codex/responses',concreteRoute:{authentication:'oauth'},
   prepare(raw){return {body:raw,binding:{role:'planner2'}};},assertSafeResponse(){},
   async send(){sends++;return new Response(wire,{headers:{'content-type':'text/event-stream'}});},async close(){}};
  const gateway=new DeepSeekGateway(budget,()=>assert.fail('metered price requested'),'',128,1,()=>assert.fail('direct send'),'responses',true,undefined,undefined,undefined,magpie,undefined,model,()=>turn);
  try{
   const {url,token}=await gateway.start();
   const res=await fetch(url+'/responses',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer synthetic','x-dm-gateway':token},body:JSON.stringify({model,stream:true,store:false,max_output_tokens:128})});
   const text=await res.text(),receipt=gateway.receipts()[0];
   if(mode==='metadata auxiliary event'){
    assert.equal(res.status,200,text);
    assert.equal(gateway.confirmedSupervisorOutput(model,content).outcome,'COMPLETE');
    assert.equal(receipt.protocolLastEventType,'response.completed');
    assert.equal(receipt.networkFailureClass,null);
   }else{
    assert.equal(res.status,502,text);
    assert.notEqual(outcome,'COMPLETE');
    assert.equal(receipt.outcome,'MODEL_GATEWAY_COMPLETION_INVALID');
    assert.equal(receipt.networkFailureClass,null);
    assert.ok(!text.includes('event:'));
   }
   assert.equal(sends,1);
  }finally{await gateway.close();}
 });
}

for(const mode of ['empty streaming item id','unknown streaming item id']){
 test('native Responses text streaming binds an omitted item id only at completion: '+mode,async()=>{
  let sends=0,outcome=null;
  const turn={},budget={
   reserveIncludedPlanner(proof){assert.equal(proof,turn);return {id:'offline_hold',reservedMicros:0};},
   settle(_id,_usage,status){outcome=status;}
  };
  const blocks=events.split('\n\n').filter(Boolean);
  const created=blocks.find(block=>block.startsWith('event: response.created\n'));
  const completed=blocks.find(block=>block.startsWith('event: response.completed\n'));
  assert.ok(created&&completed);
  const streamedItemId=mode==='empty streaming item id'?'':'msg_unknown';
  const wire=[
   created,
   eventBlock({type:'response.output_text.delta',item_id:streamedItemId,output_index:0,content_index:0,delta:content}).trimEnd(),
   eventBlock({type:'response.output_text.done',item_id:streamedItemId,output_index:0,content_index:0,text:content}).trimEnd(),
   completed,
  ].join('\n\n')+'\n\n';
  const magpie={role:'planner2',provider:'openai',responseModel:model,upstream:'http://127.0.0.1:1/backend-api/codex/responses',concreteRoute:{authentication:'oauth'},
   prepare(raw){return {body:raw,binding:{role:'planner2'}};},assertSafeResponse(){},
   async send(){sends++;return new Response(wire,{headers:{'content-type':'text/event-stream'}});},async close(){}};
  const gateway=new DeepSeekGateway(budget,()=>assert.fail('metered price requested'),'',128,1,()=>assert.fail('direct send'),'responses',true,undefined,undefined,undefined,magpie,undefined,model,()=>turn);
  try{
   const {url,token}=await gateway.start();
   const res=await fetch(url+'/responses',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer synthetic','x-dm-gateway':token},body:JSON.stringify({model,stream:true,store:false,max_output_tokens:128})});
   const text=await res.text();
   if(mode==='empty streaming item id'){
    assert.equal(res.status,200,text);
    assert.equal(gateway.confirmedSupervisorOutput(model,content).outcome,'COMPLETE');
   }else{
    assert.equal(res.status,502,text);
    assert.notEqual(outcome,'COMPLETE');
   }
   assert.equal(sends,1);
  }finally{await gateway.close();}
 });
}
