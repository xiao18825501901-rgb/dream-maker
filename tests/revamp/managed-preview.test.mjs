// Protocol-only doubles; not a browser, source qualification or Live model test.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as preview from '../../dist/web/preview.js';
const tasks=title=>[{id:'t1',title,done:false}];
const view=(revision=0,title='')=>({schema:'dream-maker.managed-data.v1',projectId:'project_1',kind:'FIXED_DEMO_TASKS_V1',revision,tasks:title?tasks(title):[],dataHash:revision?'b'.repeat(64):null,contentHash:revision?'c'.repeat(64):null,usage:{versions:revision,bytes:100,operations:revision},limits:{versions:1000,bytes:8000000,operations:5000,payloadBytes:100000},scope:'FIXED_DEMO_DATA_ONLY',nativeExecutionGranted:false});
function setup(client){const replies=[],bridge=new preview.ManagedPreviewBridge(client,'http://127.0.0.1:4317'),url=bridge.prepare('http://127.0.0.1:4567/token/','run_1','a'.repeat(64)),source={postMessage:data=>replies.push(data)};bridge.bind({src:url,contentWindow:source});const channel=new URL(url).searchParams.get('dm_channel');return {bridge,replies,source,url,event:(op,revision,values={})=>({origin:'null',source,data:{type:'dm-preview-data',version:2,channel,requestId:crypto.randomUUID(),op,...(op==='write'?{revision,tasks:tasks('用户改动')}:{}),...values}})};}
test('managed frame writes the exact revision it displayed, without fetching and rebasing before a write',async()=>{
 const calls=[];const h=setup({async read(...args){calls.push(['read',...args]);return view(1,'已经显示的内容');},async write(...args){calls.push(['write',...args]);return {...view(2,'用户改动'),operation:{hash:'d'.repeat(64),appliedRevision:2,replayed:false}};}});
 assert.equal(new URL(h.url).searchParams.get('dm_data'),'2');await h.bridge.receive(h.event('read'));await h.bridge.receive(h.event('write',1));
 assert.equal(calls.length,2);assert.equal(calls[1][0],'write');assert.equal(calls[1][4],1);assert.deepEqual(h.replies.at(-1).tasks,tasks('用户改动'));assert.equal(h.replies.at(-1).revision,2);
 await h.bridge.receive(h.event('write',1));assert.equal(calls.length,2);assert.equal(h.replies.at(-1).error,'MANAGED_DATA_CONFLICT');
});
test('foreign windows, broad fields and version1 cannot trigger managed controller calls',async()=>{
 let calls=0;const h=setup({async read(){calls++;return view();},async write(){calls++;return view();}}),ev=h.event('read');
 for(const bad of [{...ev,source:{}},{...ev,origin:'http://127.0.0.1:4567'},{...ev,data:{...ev.data,version:1}},{...ev,data:{...ev.data,url:'https://unapproved.invalid'}},{...ev,data:{...ev.data,op:'exec'}}])assert.equal(await h.bridge.receive(bad),false);
 assert.equal(calls,0);assert.equal(h.replies.length,0);
});
test('a write without a displayed revision is denied and conflict preserves unsaved frame data',async()=>{
 let writes=0;const h=setup({async read(){return view(4,'原始内容');},async write(){writes++;throw Object.assign(Error('conflict'),{code:'MANAGED_DATA_CONFLICT'});}});
 await h.bridge.receive(h.event('write',0));assert.equal(writes,0);await h.bridge.receive(h.event('read'));await h.bridge.receive(h.event('write',4));assert.equal(writes,1);
 assert.equal(h.replies.at(-1).error,'MANAGED_DATA_CONFLICT');assert.equal('tasks' in h.replies.at(-1),false);
});
test('a late data reply is not delivered after the original frame is cleared',async()=>{
 let done;const h=setup({read:()=>new Promise(r=>{done=r;}),write:async()=>view()});const operation=h.bridge.receive(h.event('read'));h.bridge.clear();done(view(1,'迟到内容'));await operation;assert.equal(h.replies.length,0);
});
