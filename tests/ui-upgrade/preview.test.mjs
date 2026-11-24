import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewStorageBridge, previewTasks } from '../../dist/web/preview.js';

test('opaque preview storage rejects foreign windows, origins, channels and arbitrary operations', () => {
  const data=new Map(),replies=[];
  const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
  const bridge=new PreviewStorageBridge(()=>storage,'http://127.0.0.1:4317');
  const url=bridge.prepare('http://127.0.0.1:4567/token/','run_123','a'.repeat(64));
  const channel=new URL(url).searchParams.get('dm_channel');
  const source={postMessage:(v,target)=>replies.push({v,target})};
  bridge.bind({src:url,contentWindow:source});
  const payload={type:'dm-preview-storage',version:1,channel,requestId:'request-1',op:'write',tasks:[{id:'task1',title:'本地任务',done:false}]};
  const valid={origin:'null',source,data:payload};
  for (const ev of [{...valid,source:{}},{...valid,origin:'http://127.0.0.1:4567'},
    {...valid,data:{...payload,channel:'wrong'}},{...valid,data:{...payload,op:'fetch'}},
    {...valid,data:{...payload,url:'https://example.invalid'}}]) assert.equal(bridge.receive(ev),false);
  assert.equal(data.size,0);
  assert.equal(bridge.receive(valid),true);
  assert.equal(data.size,1);
  assert.deepEqual(replies[0].v.tasks,payload.tasks);
  assert.equal(bridge.receive({...valid,data:{...payload,requestId:'request-2',op:'read',tasks:undefined}}),true);
  bridge.clear();assert.equal(bridge.receive(valid),false);
});

test('preview storage bounds data and never accepts credential or configuration fields',()=>{
  assert.throws(()=>previewTasks([{id:'x',title:'task',done:false,apiKey:'x'}]));
  assert.throws(()=>previewTasks(Array.from({length:201},(_,i)=>({id:String(i),title:'x',done:false}))));
  assert.throws(()=>previewTasks([{id:'x',title:'t'.repeat(121),done:false}]));
  assert.throws(()=>previewTasks([{id:'x',title:'t',done:'true'}]));
  assert.throws(()=>previewTasks([{id:'x',title:'t',done:false},{id:'x',title:'t',done:false}]));
  assert.deepEqual(previewTasks([]),[]);
});
