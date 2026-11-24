import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {copyFile, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {createServer as http} from 'node:http';
import {createServer as https} from 'node:https';
import {dirname, join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const kit = dirname(fileURLToPath(import.meta.url));
const suite = 'F:/DreamMakerSuite';
const input = resolve(process.argv[2]);
const build = JSON.parse(await readFile(input));
const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha(await readFile(build.binary)), build.binarySHA256);
const work = await mkdtemp(join(dirname(input),'process-'));
const source = join(dirname(dirname(input)),'source');
const overlay = JSON.parse(await readFile(join(dirname(input),'overlay.json')));
const goRoot = join(suite,'runtime/go1.26.8-windows-amd64/go');
const testcert = await readFile(join(goRoot,'src/net/http/internal/testcert/testcert.go'),'utf8');
const cert = testcert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)[0];
const key = testcert.match(/-----BEGIN RSA TESTING KEY-----[\s\S]*?-----END RSA TESTING KEY-----/)[0].replaceAll('TESTING KEY','PRIVATE KEY');
const rootFile = join(work,'fixture_roots.go');
await writeFile(rootFile,'package main\nimport "crypto/x509"\nfunc init() { roots := x509.NewCertPool(); if !roots.AppendCertsFromPEM([]byte('+JSON.stringify(cert+'\n')+')) { panic("invalid fixture root") }; x509.SetFallbackRoots(roots) }\n');
overlay.Replace[join(source,'cmd/dream-maker-magpie/fixture_roots.go')] = rootFile;
const fixtureOverlay = join(work,'overlay.json');
await writeFile(fixtureOverlay,JSON.stringify(overlay));
const mirror = join(work,'exectest.exe');
execFileSync(join(goRoot,'bin/go.exe'),['build','-overlay',fixtureOverlay,'-buildvcs=false','-trimpath','-o',mirror,'./cmd/dream-maker-magpie'],{cwd:source,stdio:'inherit',env:{...process.env,GOENV:'off',GOWORK:'off',GOPROXY:'off',GOSUMDB:'off',GOTOOLCHAIN:'local',GOTELEMETRY:'off',CGO_ENABLED:'0',GOMODCACHE:join(suite,'caches/go-mod-20261111'),GOCACHE:join(suite,'caches/go-build'),GOPATH:join(suite,'caches/go-path'),GOTMPDIR:join(suite,'temp'),GOFLAGS:'-p=2 -mod=readonly'}});
const goldSource = await readFile(join(kit,'../v5/overlay/internal/gateway/dm_explicit_test.go'),'utf8');
const golden = goldSource.match(/const dmNativeFixture = `([\s\S]*?)`/)[1];
const frames = s => s.trimEnd().split('\n\n').map(block => {
  const [name,data] = block.split('\n');
  return {name,data:JSON.parse(data.slice(6))};
});
const host = 'fixture.example.com', path = '/v1/responses', model = 'native-only', provider = 'fixture';
const protocol = 'openai-responses', qualified = provider+'/'+model;
const baseBody = {model:qualified,instructions:'Read the supplied text.',input:[{type:'message',role:'user',content:[{type:'input_text',text:'fixture'}]}],stream:true,store:false,max_output_tokens:4};
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
  const accounts=[{...row(provider,0),capabilities:[{model,protocol,endpoint:'https://'+host+'/owned/responses'}]},
    {...row(provider,1),capabilities:[{model,protocol:'chat-completions',endpoint:'https://chat.example.com/v1/chat/completions'}]},
    {...row('old',2),model,chat:'https://old.example.com/v1',responses:'https://old.example.com/v1',anthropic:''}];
  let connects=0, requests=0, tlsFailures=0, fixtureError, reply=golden, expectedBody;
  const tls=https({cert,key},async(req,res)=>{
    try {
      assert.equal(req.method,'POST'); assert.equal(req.url,'/owned/responses');
      assert.equal(req.socket.servername,host); assert.equal(req.headers.host,host);
      assert.ok(req.headers.authorization==='Bearer '+accounts[0].key,'physical credential');
      assert.equal(req.headers['chatgpt-account-id'],undefined);
      const bytes=[]; for await(const chunk of req) bytes.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(bytes)),{...expectedBody,model});
      requests++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(reply);
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
  const env={SystemRoot:process.env.SystemRoot,Path:join(process.env.SystemRoot,'System32'),HOME:profile,USERPROFILE:profile,LOCALAPPDATA:profile,APPDATA:profile,XDG_CONFIG_HOME:join(cwd,'data'),TMP:profile,TEMP:profile,MAGPIE_NO_ACCOUNTS:'1',HTTPS_PROXY:'http://127.0.0.1:'+proxy.address().port,GODEBUG:'x509usefallbackroots=1'};
  const child=spawn(binary,[],{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stderr.resume();const closed=once(child,'close');const timer=setTimeout(()=>child.kill(),120000);
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  async function frame(obj){const raw=JSON.stringify(obj);child.stdin.write(raw+'\n');const line=await lines.next();assert.equal(line.done,false,'control closed');const ack=JSON.parse(line.value);if(obj.type)assert.equal(ack.controlHash,sha(raw));return ack;}
  try {
    const ready=await frame({schema:'dream-maker.magpie-control.v5',epoch,accounts});
    assert.equal(ready.qualification,'NOT_VERIFIED');assert.match(ready.address,/^127\.0\.0\.1:[0-9]+$/);
    assert.deepEqual(ready.accounts[0].capabilities,accounts[0].capabilities);
    let seq=0;
    async function check(name,runtime,role,options={}) {
      const {account=0,body=baseBody,mutate={},status=200}=options;
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
          reply=options.reply??golden;expectedBody=body;
          const post=()=>fetch('http://'+ready.address+path,{method:'POST',headers:{authorization:'Bearer '+a.token,'content-type':'application/json'},body:options.sentBody??raw,redirect:'error',signal:AbortSignal.timeout(15000)});
          const res=await post(),text=await res.text();if(fixtureError)throw fixtureError;
          assert.equal(res.status,status,name);if(status===200)assert.deepEqual(frames(text),expected,name);
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
      cases.push({mode,name,runtime,role,status,connects:connects-startConnects,upstreamRequests:requests-startRequests});
    }
    for(const runtime of ['opencode','cline'])for(const role of ['planner2','reviewer']){
      await check('read-only Responses',runtime,role,{status:mode==='frozen'?'issue-denied':mode==='production'?502:200});
    }
    if(mode==='exectest'){
      for(const runtime of ['opencode','cline']){
        for(const [name,options] of Object.entries({
          executor:{mutate:{role:'executor',roleId:'executor-1'}},planner1:{mutate:{role:'planner1',roleId:'planner1'}},
          'role mismatch':{mutate:{roleId:'reviewer'}},oauth:{mutate:{authentication:'oauth'}},'wrong route hash':{wrongHash:true},
          'wrong account cap':{account:1},legacy:{account:2},'wrong model':{mutate:{model:'other'}},'wrong protocol':{mutate:{protocol:'chat-completions',path:'/v1/chat/completions'}},'wrong auth ref':{mutate:{authRef:'auth_1'}},
          'wrong account ref':{mutate:{accountRef:'account_1'}},'wrong path':{mutate:{path:'/backend-api/codex/responses'}},'unfunded':{mutate:{maxOutputTokens:0}}
        }))await check(name,runtime,'planner2',{...options,status:'issue-denied'});
        await check('reservation substitution',runtime,'reviewer',{grantChange:{reservationId:'another'},status:'grant-denied'});
        for(const [name,fields] of Object.entries({tools:{tools:[]},toolChoice:{tool_choice:'none'},'tool input':{input:[{type:'function_call_output',call_id:'fixture',output:'value'}]},'nonstream':{stream:false},'stored':{store:true},'over body limit':{instructions:'x'.repeat(262144)},'missing token bound':{max_output_tokens:undefined},'over budget':{max_output_tokens:5}}))await check(name,runtime,'reviewer',{body:{...baseBody,...fields},status:403});
        await check('digest substitution',runtime,'planner2',{sentBody:JSON.stringify({...baseBody,instructions:'different'}),status:403});
        for(const [name,bad] of Object.entries({'served model':golden.replace(model,'other'),'unknown usage':golden.replace('"usage":','"missing_usage":'),'stream identity':golden.replace('resp_test','resp_other'),'event order':golden.replace('event: response.created','event: response.in_progress'),'usage':golden.replace('"output_tokens":4','"output_tokens":5'),'text divergence':golden.replace('héllo 世界','changed')}))await check(name,runtime,'reviewer',{reply:bad,status:502});
      }
      await check('other runtime','dsh','reviewer',{status:'issue-denied'});
    }
    child.stdin.end();assert.equal((await closed)[0],0);
  }finally{clearTimeout(timer);child.stdin.end();if(child.exitCode===null)child.kill();await closed;await new Promise(r=>proxy.close(r));}
}
await exercise('frozen',join(dirname(dirname(input)),'dream-maker-magpie.exe'));
await exercise('production',build.binary);
await exercise('exectest',mirror);
const result={binarySHA256:build.binarySHA256,fixtureBinarySHA256:sha(await readFile(mirror)),qualification:'NOT_VERIFIED',paidCalls:0,cases};
await writeFile(join(work,'results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({work,cases:cases.length,positive:cases.filter(x=>x.status===200).length}));
