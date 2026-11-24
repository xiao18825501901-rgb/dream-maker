// OFFLINE: the text reviewer may call only the exact DM gateway instance
// minted for its current probe/run. This is not a general localhost proxy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {jsonFetch,loopbackGatewayChatRequest} from '../../dist/server/security.js';

const token='a'.repeat(64);
const init=()=>({
  method:'POST',
  headers:{authorization:'Bearer '+token,'content-type':'application/json'},
  body:'{"model":"deepseek-v4-pro","messages":[],"max_tokens":1}'
});

test('the exact loopback gateway request reaches only its minted route', async t => {
  let requests=0;
  const server=createServer((req,res)=>{
    requests+=1;
    assert.equal(req.url,'/v1/chat/completions');
    assert.equal(req.headers.authorization,'Bearer '+token);
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({id:'offline_gateway_response'}));
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));

  const base='http://127.0.0.1:'+server.address().port+'/v1';
  const request=loopbackGatewayChatRequest({url:base,token});
  const result=await request(base+'/chat/completions',init());
  assert.equal(result.id,'offline_gateway_response');
  assert.equal(requests,1);
});

test('wrong origin path or bearer never reaches a loopback server', async t => {
  let requests=0;
  const server=createServer((_req,res)=>{
    requests+=1;
    res.writeHead(200,{'content-type':'application/json'});
    res.end('{}');
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));

  const base='http://127.0.0.1:'+server.address().port+'/v1';
  const request=loopbackGatewayChatRequest({url:base,token});
  for(const [url,options] of [
    ['http://127.0.0.1:1/v1/chat/completions',init()],
    [base+'/models',init()],
    [base+'/chat/completions',{...init(),headers:{authorization:'Bearer '+'b'.repeat(64),'content-type':'application/json'}}],
    [base+'/chat/completions',{...init(),method:'GET'}]
  ]) await assert.rejects(()=>request(url,options),{code:'NETWORK_TARGET_DENIED'});
  assert.equal(requests,0);
});

test('the gateway request factory refuses ambiguous or external addresses', () => {
  for(const url of [
    'http://localhost:4567/v1',
    'https://127.0.0.1:4567/v1',
    'http://user:pass@127.0.0.1:4567/v1',
    'http://127.0.0.1:4567/v2',
    'http://127.0.0.1:4567/v1?next=https://example.test',
    'http://127.0.0.1:4567/v1#fragment'
  ]) assert.throws(()=>loopbackGatewayChatRequest({url,token}),{code:'NETWORK_TARGET_DENIED'},url);
  for(const value of ['short','g'.repeat(64)]) assert.throws(()=>loopbackGatewayChatRequest({url:'http://127.0.0.1:4567/v1',token:value}),{code:'NETWORK_TARGET_DENIED'});
});

test('the public json allowlist still refuses unrelated loopback routes', async () => {
  await assert.rejects(
    ()=>jsonFetch('http://127.0.0.1:4567/v1/chat/completions',init()),
    {code:'NETWORK_TARGET_DENIED'}
  );
});
