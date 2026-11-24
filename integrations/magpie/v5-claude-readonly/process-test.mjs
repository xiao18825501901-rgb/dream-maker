import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {copyFile, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {createServer as http} from 'node:http';
import {createServer as https} from 'node:https';
import {dirname, join, resolve} from 'node:path';
import {createInterface} from 'node:readline';

import {kit, audited, root, goRoot, go} from './reproduce.mjs';
import {relative, isAbsolute} from 'node:path';
const input = resolve(process.argv[2]);
const rel=relative(root,input);
assert.ok(!rel.startsWith('..') && !isAbsolute(rel));
const build = JSON.parse(await readFile(input));
const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha(await readFile(build.binary)), build.binarySHA256);
const work = await mkdtemp(join(dirname(input),'process-'));
const source=build.source;
const overlay = JSON.parse(await readFile(join(dirname(input),'overlay.json')));
const testcert = await readFile(join(goRoot,'src/net/http/internal/testcert/testcert.go'),'utf8');
const cert = testcert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)[0];
const key = testcert.match(/-----BEGIN RSA TESTING KEY-----[\s\S]*?-----END RSA TESTING KEY-----/)[0].replaceAll('TESTING KEY','PRIVATE KEY');
const rootFile = join(work,'fixture_roots.go');
await writeFile(rootFile,'package main\nimport "crypto/x509"\nfunc init() { roots := x509.NewCertPool(); if !roots.AppendCertsFromPEM([]byte('+JSON.stringify(cert+'\n')+')) { panic("invalid fixture root") }; x509.SetFallbackRoots(roots) }\n');
overlay.Replace[join(source,'cmd/dream-maker-magpie/fixture_roots.go')] = rootFile;
const fixtureOverlay = join(work,'overlay.json');
await writeFile(fixtureOverlay,JSON.stringify(overlay));
const mirror = join(work,'exectest.exe');
go(['build','-overlay',fixtureOverlay,'-buildvcs=false','-trimpath','-o',mirror,'./cmd/dream-maker-magpie']);
const goldSource = await readFile(join(kit,'v5/overlay/internal/gateway/dm_explicit_test.go'),'utf8');
const golden = goldSource.match(/const dmNativeFixture = `([\s\S]*?)`/)[1];
const frames = s => s.trimEnd().split('\n\n').map(block => {
  const [name,data] = block.split('\n');
  return {name,data:JSON.parse(data.slice(6))};
});
const host='fixture.example.com', model='native-only', provider='fixture', qualified=provider+'/'+model;
const responses='openai-responses', chat='chat-completions';
const wires={
 [responses]:{path:'/v1/responses',suffix:'/responses',body:{model:qualified,instructions:'Read the supplied text.',input:[{type:'message',role:'user',content:[{type:'input_text',text:'fixture'}]}],stream:true,store:false,max_output_tokens:4}},
 [chat]:{path:'/v1/chat/completions',suffix:'/chat/completions',body:{model:qualified,messages:[{role:'system',content:'Read the supplied text.'},{role:'user',content:'fixture'}],max_tokens:4,stream:false}}
};
const completion={id:'chat_1',object:'chat.completion',model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'héllo 世界'}}],usage:{prompt_tokens:9,completion_tokens:4,prompt_tokens_details:{cached_tokens:2},total_tokens:13}};
const expected = frames(golden);
assert.equal(expected.length,9);
for(const f of expected) if(f.data.response) f.data.response.model=qualified;
const epoch='fixture_epoch';
const cases=[];
async function exercise(mode, executable) {
  const cwd=join(work,mode), profile=join(cwd,'profile');
  await mkdir(profile,{recursive:true});
  await mkdir(join(cwd,'data'));
  const binary=join(cwd,'dream-maker-magpie.exe');
  await copyFile(executable,binary);
  const row=(provider,i) => ({provider,authentication:'api_key',authRef:'auth_'+i,accountRef:'account_'+i,key:'FIXTURE_'+i+'_'+randomBytes(20).toString('hex')});
  // Two keys for the same provider and model, distinct paths for both wires.
  const capabilities=i=>Object.keys(wires).map(protocol=>({model,protocol,endpoint:'https://'+host+'/owned/'+i+wires[protocol].suffix}));
  const accounts=[0,1].map(i=>({...row(provider,i),capabilities:capabilities(i)}));
  accounts.push({...row('old',2),model,chat:'https://old.example.com/v1',responses:'https://old.example.com/v1',anthropic:''});
  accounts.push({...row(provider,3),capabilities:[{model,protocol:chat,endpoint:'https://'+host+'/chat-only/chat/completions'}]});
  accounts.push({...row(provider,4),capabilities:[{model,protocol:responses,endpoint:'https://'+host+'/responses-only/responses'}]});
  let physical, replyType;
  let connects=0, requests=0, tlsFailures=0, fixtureError, reply=golden, expectedBody;
  const tls=https({cert,key},async(req,res)=>{
    try {
      assert.equal(req.method,'POST');assert.equal(req.url,physical.path);
      assert.equal(req.socket.servername,host);assert.equal(req.headers.host,host);
      assert.ok(req.headers.authorization==='Bearer '+physical.key,'physical credential');
      for(const k of ['cookie','x-api-key','proxy-authorization','x-dm-gateway','chatgpt-account-id','anthropic-version'])assert.equal(req.headers[k],undefined);
      const bytes=[]; for await(const chunk of req) bytes.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(bytes)),{...expectedBody,model});
      requests++;res.writeHead(200,{'Content-Type':replyType});res.end(reply);
    } catch(error) {fixtureError=error;res.writeHead(500);res.end();}
  });
  tls.on('tlsClientError',()=>tlsFailures++);
  const proxy=http();
  proxy.on('connect',(req,socket,head)=>{
    connects++;
    if(req.url!==host+':443'){socket.destroy();return;}
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if(head.length)socket.unshift(head);
    tls.emit('connection',socket);
  });
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const env={SystemRoot:process.env.SystemRoot,Path:join(process.env.SystemRoot,'System32'),HOME:profile,USERPROFILE:profile,LOCALAPPDATA:profile,APPDATA:profile,XDG_CONFIG_HOME:join(cwd,'data'),TMP:profile,TEMP:profile,MAGPIE_NO_ACCOUNTS:'1',HTTPS_PROXY:'http://127.0.0.1:'+proxy.address().port,...(mode==='exectest'?{GODEBUG:'x509usefallbackroots=1'}:{})};
  const child=spawn(binary,[],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stderr.resume();const closed=once(child,'close');const timer=setTimeout(()=>child.kill(),120000);
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  async function frame(obj){const raw=JSON.stringify(obj);child.stdin.write(raw+'\n');const line=await lines.next();assert.equal(line.done,false,'control closed');const ack=JSON.parse(line.value);if(obj.type)assert.equal(ack.controlHash,sha(raw));return ack;}
  try {
    const ready=await frame({schema:'dream-maker.magpie-control.v5',epoch,accounts});
    assert.equal(ready.qualification,'NOT_VERIFIED');assert.match(ready.address,/^127\.0\.0\.1:[0-9]+$/);
    assert.deepEqual(ready.accounts[0].capabilities,accounts[0].capabilities);
    let seq=0;
    async function check(name,protocol,role,options={}) {
      const {path,body:baseBody}=wires[protocol];
      const {account=0,body=baseBody,mutate={},status=200}=options;
      const runtime='claude';
      const row=accounts[account];const ref=row.provider+'/'+sha(row.key).slice(0,10);
      assert.equal(ready.accounts[account].upstreamAccountRef,ref);
      const raw=JSON.stringify(body);const startConnects=connects,startRequests=requests,startFailures=tlsFailures;
      const a={provider:row.provider,model,runtime,protocol,role,roleId:role,accountRef:row.accountRef,authRef:row.authRef,authentication:'api_key',upstreamAccountRef:ref,epoch,id:'grant_'+(++seq),token:randomBytes(32).toString('hex'),projectId:'project',flowId:'flow',reservationId:'reservation_'+seq,configurationHash:sha('configuration'),bindingHash:sha('binding'),method:'POST',path,bodyHash:sha(raw),expiresAtMs:Date.now()+55000,maxInputTokens:1048576,maxOutputTokens:4,...mutate};
      const {accountRef,authRef,authentication}=a;
      a.routeHash=options.wrongHash?sha('other'):sha(JSON.stringify({accountRef,authRef,authentication,model:a.model,protocol:a.protocol,provider:a.provider,runtime:a.runtime,upstreamAccountHash:sha(a.upstreamAccountRef)}));
      const issue=await frame({type:'issue',request:a});
      if(status==='issue-denied') {
        assert.equal(issue.accepted,false,name);assert.equal(connects,startConnects,name);
      } else {
        assert.equal(issue.accepted,true,name);
        const grant=await frame({type:'grant',admission:{...a,upstreamKey:issue.upstreamKey,upstreamKeyId:issue.upstreamKeyId,...options.grantChange}});
        if(status==='grant-denied'){assert.equal(grant.accepted,false,name);assert.equal(connects,startConnects,name);}
        else {
          assert.equal(grant.accepted,true,name);assert.equal(grant.reservationId,a.reservationId);
          reply=options.reply??(protocol===chat?JSON.stringify(completion):golden);expectedBody=body;
          physical={key:row.key,path:'/owned/'+account+wires[protocol].suffix};
          replyType=options.replyType??(protocol===chat?'application/json':'text/event-stream');
          const post=()=>fetch('http://'+ready.address+path,{method:'POST',headers:{authorization:'Bearer '+a.token,'content-type':'application/json'},body:options.sentBody??raw,redirect:'error',signal:AbortSignal.timeout(15000)});
          const res=await post(),text=await res.text();if(fixtureError)throw fixtureError;
           assert.equal(res.status,status,name);
           if(status===200) {
             if(protocol===chat)assert.deepEqual(JSON.parse(text),completion,name);
             else assert.deepEqual(frames(text),expected,name);
           }
          else assert.ok(!text.includes('héllo'),name);
          const replay=await post();await replay.arrayBuffer();assert.equal(replay.status,403,name);
          assert.equal(connects-startConnects,status===403?0:1,name);
          assert.equal(requests-startRequests,mode==='exectest'&&status!==403?1:0,name);
          if(mode==='production')assert.equal(tlsFailures-startFailures,1,name);
          const ledgerFile=join(cwd,'data/usage.jsonl');
          const ledger=(await readFile(ledgerFile,'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
          const rows=ledger.filter(entry=>entry.callerKeyId===issue.upstreamKeyId);
          assert.equal(rows.length,status===403?0:1,name);
          if(rows.length){
            const [entry]=rows;assert.equal(entry.status,status,name);assert.equal(entry.req,qualified,name);assert.equal(entry.ep,path,name);
            if(status===200){assert.equal(entry.served,model);assert.equal(entry.providerKeyId,ref.split('/')[1]);assert.deepEqual([entry.in,entry.out,entry.cache_read],[7,4,2]);}
            else if(mode==='production')assert.ok(!entry.served,name);
          }
        }
      }
      cases.push({mode,name,protocol,role,status,account,connects:connects-startConnects,tlsFailures:tlsFailures-startFailures,upstreamRequests:requests-startRequests});
    }
    for(const protocol of [chat,responses])for(const [i,role] of ['planner2','reviewer'].entries()) {
      await check('exact account and protocol',protocol,role,{account:i,status:mode==='frozen'?'issue-denied':mode==='production'?502:200});
    }
    if(mode==='exectest')for(const protocol of [chat,responses]){
      for(const [name,options] of Object.entries({
        executor:{mutate:{role:'executor',roleId:'executor-1'}},planner1:{mutate:{role:'planner1',roleId:'planner1'}},'role mismatch':{mutate:{roleId:'reviewer'}},oauth:{mutate:{authentication:'oauth'}},'wrong route hash':{wrongHash:true},'other capability':{account:protocol===chat?4:3},legacy:{account:2},'wrong model':{mutate:{model:'other'}},'wrong auth reference':{mutate:{authRef:'auth_1'}},'wrong account reference':{mutate:{accountRef:'account_1'}},'wrong path':{mutate:{path:'/backend-api/codex/responses'}},unfunded:{mutate:{maxOutputTokens:0}}
      }))await check(name,protocol,'planner2',{...options,status:'issue-denied'});
      await check('reservation substitution',protocol,'reviewer',{grantChange:{reservationId:'another'},status:'grant-denied'});
      const body=wires[protocol].body;
      const mutations=protocol===chat?{stream:{stream:true},'missing output limit':{max_tokens:undefined},'requested over budget':{max_tokens:5},'nested call':{messages:[body.messages[0],{role:'user',content:'fixture',tool_calls:[]}]},'non-text message':{messages:[body.messages[0],{role:'user',content:[{type:'image'}]}]},'wrong role':{messages:[body.messages[0],{role:'tool',content:'fixture'}]}}:{'nonstream':{stream:false},stored:{store:true},'over body limit':{instructions:'x'.repeat(262144)},'missing output limit':{max_output_tokens:undefined},'requested over budget':{max_output_tokens:5},'tool result':{input:[{type:'function_call_output',call_id:'fixture',output:'value'}]}};
      for(const [name,fields] of Object.entries({...mutations,tools:{tools:[]},'tool choice':{tool_choice:'none'}}))await check(name,protocol,'reviewer',{body:{...body,...fields},status:403});
      await check('digest substitution',protocol,'planner2',{sentBody:JSON.stringify({...body,extra:true}),status:403});
      if(protocol===chat){
        const withMessage=fields=>({...completion,choices:[{...completion.choices[0],message:{...completion.choices[0].message,...fields}}]});
        const withUsage=fields=>({...completion,usage:{...completion.usage,...fields}});
        for(const [name,bad] of Object.entries({'wrong served model':{...completion,model:'other'},'returned tool':withMessage({tool_calls:[{id:'t'}]}),'refusal':withMessage({refusal:'declined'}),'blank text':withMessage({content:' '}),'absent cache':withUsage({prompt_tokens_details:undefined}),'contradictory cache':withUsage({prompt_cache_hit_tokens:1}),'absent usage':{...completion,usage:undefined},'negative cache':withUsage({prompt_tokens_details:{cached_tokens:-1}}),'cache write':withUsage({cache_write_tokens:1}),'excess cache':withUsage({prompt_tokens_details:{cached_tokens:10}}),'over output':withUsage({completion_tokens:5,total_tokens:14}),'over input':withUsage({prompt_tokens:1048577,total_tokens:1048581}),'wrong total':withUsage({total_tokens:8})}))await check(name,protocol,'reviewer',{reply:JSON.stringify(bad),status:502});
      }else{
        for(const [name,bad] of Object.entries({'wrong served model':golden.replace(model,'other'),'missing usage':golden.replace('"usage":','"missing_usage":'),'absent cache':golden.replace('"cached_tokens"','"other_tokens"'),'cache write':golden.replace('"cached_tokens":2','"cached_tokens":2,"cache_write_tokens":1'),'cache creation':golden.replace('"input_tokens":9','"cache_creation_input_tokens":1,"input_tokens":9'),'stream identity':golden.replace('resp_test','resp_other'),'event order':golden.replace('event: response.created','event: response.in_progress'),'over output':golden.replace('"output_tokens":4','"output_tokens":5'),'over input':golden.replace('"input_tokens":9','"input_tokens":1048577'),'text divergence':golden.replace('héllo 世界','changed')}))await check(name,protocol,'reviewer',{reply:bad,status:502});
      }
    }
    child.stdin.end();assert.equal((await closed)[0],0);
  }finally{clearTimeout(timer);child.stdin.end();if(child.exitCode===null)child.kill();await closed;await new Promise(r=>proxy.close(r));}
}
await exercise('frozen',audited);
await exercise('production',build.binary);
await exercise('exectest',mirror);
const result={binarySHA256:build.binarySHA256,fixtureBinarySHA256:sha(await readFile(mirror)),baselineSHA256:build.baselineSHA256,qualification:'NOT_VERIFIED',externalModelCalls:0,paidCalls:0,cases};
await writeFile(join(work,'results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({work,cases:cases.length,positive:cases.filter(x=>x.status===200).length}));
