// OFFLINE process/protocol fixture, never Codex or a provider.
import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})){
 const q=JSON.parse(line),mode=q.params.mode;
 if(mode==='unicode'){
  const bytes=Buffer.from(JSON.stringify({id:q.id,result:{text:'中文说明😀'}})+'\n');
  for(const byte of bytes){process.stdout.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,2));}
 }else if(mode==='coalesced'){
  const frame=JSON.stringify({method:'fixture',params:{text:'x'.repeat(999820)}})+'\n';
  process.stdout.write(frame+frame+JSON.stringify({id:q.id,result:{ok:true}})+'\n');
 }else{
  const text=mode==='foreign-text'?q.params.text+'changed':q.params.text;
  const item={type:mode==='agent'?'agentMessage':'userMessage',id:'OFFLINE_ITEM',content:[{type:'text',text,text_elements:[]}]};
  process.stdout.write(JSON.stringify({method:'item/completed',params:{threadId:mode==='foreign-thread'?'OTHER':'OFFLINE_THREAD',turnId:'OFFLINE_TURN',item}})+'\n'+JSON.stringify({id:q.id,result:{ok:true}})+'\n');
 }
}
