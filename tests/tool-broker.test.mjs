// Actual loopback broker, no model requests and no substitute OS acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startToolBroker } from '../dist/server/tool-broker.js';
import { toolClient } from '../adapters/dsh-tool-client.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('tool broker rejects wrong bearer, browser Origin and caller-supplied role without dispatch',async t=>{
 let calls=0;const broker=await startToolBroker({dispatch:async()=>{calls++;return{ok:true};}});t.after(()=>broker.close());
 async function request(extra={},body={name:'desk_read',args:{path:'x'}}){return fetch(broker.url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+broker.token,...extra},body:JSON.stringify(body)});}
 assert.equal((await request({authorization:'Bearer wrong'})).status,401);
 assert.equal((await request({origin:'http://127.0.0.1:4317'})).status,403);
 assert.equal((await request({origin:''})).status,403);
 assert.equal((await request({}, {role:'executor',name:'desk_read',args:{path:'x'}})).status,403);
 assert.equal(calls,0);
 const result=await toolClient(broker.url,broker.token)('desk_read',{path:'x'},new AbortController().signal);assert.equal(result.ok,true);assert.equal(calls,1);
 assert.throws(()=>toolClient('https://example.invalid/tools','x'),/BINDING_DENIED/);
});
test('broker close aborts an active operation before owned listener shutdown',async()=>{
 let entered;const started=new Promise(r=>entered=r);
 const broker=await startToolBroker({dispatch:async(_role,_name,_args,signal)=>{entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return{cancelled:true};}});
 const response=toolClient(broker.url,broker.token)('desk_run',{},new AbortController().signal).catch(()=>null);
 await started;await broker.close();await response;
});

test('tool client caps streamed response bytes without trusting Content-Length',async t=>{
 const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({text:'x'.repeat(2400000)}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 await assert.rejects(toolClient(`http://127.0.0.1:${server.address().port}/tools`,'synthetic')('desk_read',{},new AbortController().signal),/TOOL_CLIENT_RESPONSE_LIMIT/);
});
