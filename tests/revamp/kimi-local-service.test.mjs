// OFFLINE lifecycle counterexamples. No OAuth, real key, provider or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {childEnv} from '../../dist/server/security.js';
import {harness,root} from '../helpers.mjs';
import {createApp} from '../../dist/server/http.js';
import * as service from '../../dist/server/kimi-local-service.js';
import {parseWslProxyBinding} from '../../dist/server/providers/codex-transport.js';
const base='/opt/dream-maker-controller';
const hex='a'.repeat(64);
const profile=()=>({schema:'dream-maker.kimi-local-service.v1',distro:'DreamMaker-Acceptance-F-20261101-R2',supervisor:base+'/dm-kimi-service/supervisor.py',bridge:base+'/dm-kimi-service/bridge.py',connector:base+'/dm-kimi-service/connect.py',node:base+'/toolchain/node/bin/node',program:base+'/kimi-source/apps/kimi-code/dist/main.mjs',home:base+'/kimi-home-2.2.0',port:58713,hashes:{supervisor:hex,bridge:hex,connector:hex,node:hex,program:hex}});
const config={planner1:{provider:'kimi',accountRef:'OFFLINE_ACCOUNT'},kimi:{enabled:true,baseUrl:'http://127.0.0.1:58713',tokenFile:'F:/DreamMakerSuite/runtime/kimi/control-token.dpapi'},clash:{enabled:false}};

test('P1 service profile refuses credentials, arbitrary argv, unsafe paths, public binds and missing pins',()=>{
 assert.equal(service.validateKimiServiceProfile(profile(),config).port,58713);
 for(const bad of [{...profile(),key:'secret'}, {...profile(),args:['--anything']},{...profile(),home:'/home/shared'}, {...profile(),program:base+'/../other'}, {...profile(),distro:'other distro'}, {...profile(),port:0},{...profile(),hashes:{...profile().hashes,program:''}}])
  assert.throws(()=>service.validateKimiServiceProfile(bad,config),{code:'KIMI_SERVICE_PROFILE_INVALID'});
 assert.throws(()=>service.validateKimiServiceProfile(profile(),{...config,kimi:{...config.kimi,baseUrl:'http://0.0.0.0:58713'}}),{code:'KIMI_SERVICE_BINDING_MISMATCH'});
 assert.throws(()=>service.validateKimiServiceProfile(profile(),{...config,planner1:{provider:'openai'}}),{code:'KIMI_SERVICE_BINDING_MISMATCH'});
});

test('the Settings canonical loopback root slash preserves the same exact local service binding',()=>{
 assert.equal(service.validateKimiServiceProfile(profile(),{...config,kimi:{...config.kimi,baseUrl:config.kimi.baseUrl+'/'}}).port,58713);
});

test('CFW-enabled Kimi startup requires a verified private WSL proxy and sends it only inside bounded metadata',async()=>{
 const clashConfig={...config,clash:{enabled:true}};
 let spawned=0;
 await assert.rejects(service.startKimiLocalService({
  product:'dream-maker',env:{DM_KIMI_SERVICE_PROFILE:'F:/selected.json'},config:clashConfig,
  readProfile:()=>profile(),spawn:()=>{spawned++;throw Error('NO_SPAWN');}
 }),{code:'KIMI_CONTROLLED_NETWORK_REQUIRED'});
 assert.equal(spawned,0);

 const proc=child(),env={DM_KIMI_SERVICE_PROFILE:'F:/selected.json',OPENAI_API_KEY:'MUST_NOT_ENTER_REQUEST'};
 const started=service.startKimiLocalService({
  product:'dream-maker',env,config:clashConfig,readProfile:()=>profile(),
  resolveWslProxy:async requested=>{
   assert.equal(requested.distro,profile().distro);
   return parseWslProxyBinding('http://172.27.48.1:7890/');
  },
  spawn:(_cmd,_args)=>{spawned++;return proc;},timeoutMs:1000
 });
 const request=JSON.parse((await new Promise(resolve=>{
  let text='';proc.stdin.on('data',chunk=>{text+=chunk.toString();if(text.includes('\n'))resolve(text);});
 })).split('\n')[0]);
 assert.equal(spawned,1);
 assert.deepEqual(request.network,{
  schema:'dream-maker.kimi-wsl-proxy.v1',
  environment:{
   HTTP_PROXY:'http://172.27.48.1:7890/',http_proxy:'http://172.27.48.1:7890/',
   HTTPS_PROXY:'http://172.27.48.1:7890/',https_proxy:'http://172.27.48.1:7890/',
   ALL_PROXY:'http://172.27.48.1:7890/',all_proxy:'http://172.27.48.1:7890/',
   NO_PROXY:'localhost,127.0.0.1,::1,[::1]',no_proxy:'localhost,127.0.0.1,::1,[::1]'
  }
 });
 assert.equal(JSON.stringify(request).includes('MUST_NOT_ENTER_REQUEST'),false);
 proc.stdout.write(JSON.stringify({schema:'dream-maker.kimi-service-event.v1',type:'READY',serviceId:request.serviceId,socket:base+'/owned-kimi-services/'+request.serviceId+'/control.sock',port:58713})+'\n');
 const runtime=await started;
 const stopped=runtime.stop();
 proc.stdout.write(JSON.stringify({schema:'dream-maker.kimi-service-event.v1',type:'CLEANUP',serviceId:request.serviceId,proven:true,remainingPids:[]})+'\n');
 proc.emit('close',0,null);await stopped;
});

test('disabled startup and standalone DreamFlow never inspect or start a P1 service',async()=>{
 let touched=0;
 for(const [product,env]of [['dream-maker',{}],['dreamflow',{DM_KIMI_SERVICE_PROFILE:'F:/profile.json'}]]){
  assert.equal(await service.startKimiLocalService({product,env,config,readProfile:()=>{touched++;throw Error();},spawn:()=>{touched++;throw Error();}}),null);
 }
 assert.equal(touched,0);
});

function child(){const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.stdin=new PassThrough();p.killed=false;p.kill=()=>{p.killed=true;return true;};return p;}
async function fixture(ready={},trailing=[],options={}){
 const proc=child(),env={DM_KIMI_SERVICE_PROFILE:'F:/DreamMakerSuite/runtime/kimi/service.json',DEEPSEEK_API_KEY:'OFFLINE_SECRET'},seen=[];
 const started=service.startKimiLocalService({product:'dream-maker',env,config,readProfile:()=>profile(),spawn:(cmd,args,options)=>{seen.push({cmd,args,options});return proc;},timeoutMs:1000,signal:options.signal,onEvent:options.onEvent});
 const input=await new Promise(resolve=>{let text='';proc.stdin.on('data',chunk=>{text+=chunk.toString();if(text.includes('\n'))resolve(text);});});
 const request=JSON.parse(input.split('\n')[0]);
 if(!options.holdReady)proc.stdout.write([JSON.stringify({schema:'dream-maker.kimi-service-event.v1',type:'READY',serviceId:request.serviceId,socket:base+'/owned-kimi-services/'+request.serviceId+'/control.sock',port:58713,...ready}),...trailing.map(v=>JSON.stringify({schema:'dream-maker.kimi-service-event.v1',serviceId:request.serviceId,...v}))].join('\n')+'\n');
 return {proc,env,seen,request,started};
}

test('an explicitly selected service supplies only its bound connector environment; shutdown requires guest cleanup',async()=>{
 const f=await fixture(),runtime=await f.started;
 assert.equal(f.seen.length,1);assert.equal(f.seen[0].options.shell,false);
 assert.equal(f.seen[0].options.env.DEEPSEEK_API_KEY,undefined);
 assert.equal(f.env.DM_KIMI_BRIDGE,'1');assert.equal(f.env.DM_KIMI_BRIDGE_ACCOUNT,'OFFLINE_ACCOUNT');
 const stopped=runtime.stop();assert.equal(f.proc.killed,false);
 f.proc.stdout.write(JSON.stringify({schema:'dream-maker.kimi-service-event.v1',type:'CLEANUP',serviceId:f.request.serviceId,proven:true,remainingPids:[]})+'\n');
 f.proc.emit('close',0,null);await stopped;
 assert.equal(f.env.DM_KIMI_BRIDGE,undefined);assert.equal(f.env.DEEPSEEK_API_KEY,'OFFLINE_SECRET');
 await runtime.stop();
});

test('a host exit without matching guest cleanup remains uncertain and does not silently restore the selected connection',async()=>{
 const f=await fixture(),runtime=await f.started,stopped=runtime.stop();
 f.proc.emit('close',0,null);await assert.rejects(stopped,{code:'KIMI_SERVICE_CLEANUP_UNPROVEN'});
 assert.equal(f.env.DM_KIMI_BRIDGE,'1');
});

test('a cleanup event with another identity cannot settle the owned service',async()=>{
 const f=await fixture(),runtime=await f.started,stopped=runtime.stop();
 f.proc.stdout.write(JSON.stringify({schema:'dream-maker.kimi-service-event.v1',type:'CLEANUP',serviceId:'kimi_service_'+'0'.repeat(20),proven:true,remainingPids:[]})+'\n');
 f.proc.emit('close',0,null);await assert.rejects(stopped,{code:'KIMI_SERVICE_CLEANUP_UNPROVEN'});
});

test('a late shutdown never overwrites a subsequent explicit environment selection',async()=>{
 const f=await fixture(),runtime=await f.started;
 f.env.DM_KIMI_BRIDGE_SOCKET='/opt/dream-maker-controller/new/control.sock';
 const stopped=runtime.stop();f.proc.stdout.write(JSON.stringify({schema:'dream-maker.kimi-service-event.v1',type:'CLEANUP',serviceId:f.request.serviceId,proven:true,remainingPids:[]})+'\n');f.proc.emit('close',0,null);await stopped;
 assert.equal(f.env.DM_KIMI_BRIDGE_SOCKET,'/opt/dream-maker-controller/new/control.sock');
 assert.equal(f.env.DM_KIMI_BRIDGE,'1');assert.equal(f.env.DM_KIMI_BRIDGE_CONNECTOR,profile().connector);
});

test('READY followed by FAILED in the same transport chunk cannot admit a dead service',async()=>{
 const f=await fixture({},[{type:'FAILED'}]);
 const admission=await Promise.race([f.started.then(()=> 'ADMITTED',()=> 'REJECTED'),new Promise(resolve=>setTimeout(()=>resolve('WAITING_FOR_CLEANUP'),10))]);
 f.proc.stdout.write(JSON.stringify({schema:'dream-maker.kimi-service-event.v1',type:'CLEANUP',serviceId:f.request.serviceId,proven:true,remainingPids:[]})+'\n');f.proc.emit('close',1,null);
 assert.equal(admission,'WAITING_FOR_CLEANUP');
 await assert.rejects(f.started,{code:'KIMI_SERVICE_START_FAILED'});
 assert.equal(f.env.DM_KIMI_BRIDGE,undefined);
});

test('a cancelled startup does not read a profile or spawn the WSL service',async()=>{
 const controller=new AbortController();controller.abort();let touched=0;
 await assert.rejects(service.startKimiLocalService({product:'dream-maker',config,env:{DM_KIMI_SERVICE_PROFILE:'F:/selected.json'},signal:controller.signal,readProfile:()=>{touched++;return profile();},spawn:()=>{touched++;throw Error('NO_SPAWN');}}),{code:'KIMI_SERVICE_START_CANCELLED'});
 assert.equal(touched,0);
});

test('cancellation during startup joins the original guest cleanup before rejecting',async()=>{
 const controller=new AbortController(),f=await fixture({},[],{signal:controller.signal,holdReady:true});controller.abort();
 const channelClosed=f.proc.stdin.writableEnded;
 f.proc.stdout.write(JSON.stringify({schema:'dream-maker.kimi-service-event.v1',type:'CLEANUP',serviceId:f.request.serviceId,proven:true,remainingPids:[]})+'\n');f.proc.emit('close',0,null);
 await assert.rejects(f.started,{code:'KIMI_SERVICE_START_CANCELLED'});assert.equal(channelClosed,true);
});

test('safe service evidence uses fixed vocabularies rather than accepting arbitrary uppercase peer text',async()=>{
 const events=[],f=await fixture({},[{type:'FAILED',reason:'OFFLINE_SECRET'}],{onEvent:e=>events.push(e)});
 f.proc.stdout.write(JSON.stringify({schema:'dream-maker.kimi-service-event.v1',type:'CLEANUP',serviceId:f.request.serviceId,proven:true,remainingPids:[],stage:'OFFLINE_SECRET',errno:16})+'\n');f.proc.emit('close',1,null);
 await assert.rejects(f.started,{code:'KIMI_SERVICE_START_FAILED'});
 assert.equal(JSON.stringify(events).includes('OFFLINE_SECRET'),false);
 assert.equal(events.find(e=>e.type==='CLEANUP').errno,16);
});

test('Linux readiness requires an owned loopback listener, and uncertain cleanup leaves durable home exclusion',()=>{
 const py="import sys,json,runpy,tempfile; from pathlib import Path; m=runpy.run_path(sys.argv[1]); port=58713; own={'77'}; check=m['listener_matches']; valid={'address':'0100007F','port':port,'state':'0A','inode':'77'}; results=[check([],own,port),check([valid],own,port),check([{**valid,'inode':'88'}],own,port),check([{**valid,'address':'00000000'}],own,port)];\nwith tempfile.TemporaryDirectory(prefix='dm-m24-lock-') as d:\n home=Path(d); marker=m['reserve_home'](home,'kimi_service_'+'a'*20,'boot-offline');m['clear_home'](home,marker,False)\n try:m['reserve_home'](home,'kimi_service_'+'b'*20,'boot-offline');results.append('UNSAFE_REUSE')\n except ValueError:results.append('DENIED')\n m['clear_home'](home,marker,True);m['reserve_home'](home,'kimi_service_'+'b'*20,'boot-offline');results.append('AFTER_PROOF_ONLY')\nprint(json.dumps(results))";
 const output=execFileSync('python',['-c',py,resolve('scripts/kimi-p1/owned-service.py')],{env:{...childEnv(),PYTHONDONTWRITEBYTECODE:'1'},windowsHide:true,encoding:'utf8'});
 assert.deepEqual(JSON.parse(output),[false,true,false,false,'DENIED','AFTER_PROOF_ONLY']);
});

test('guest cleanup waits for populated/threads and reaping, tolerates transient EBUSY, and never claims an occupied group is clean',()=>{
 const py="import sys,json,runpy,errno; m=runpy.run_path(sys.argv[1]);\nclass Child:\n def wait(self,timeout):return 0\nclass Group:\n def __init__(self,busy=False):self.busy=busy;self.attempts=0;self.name=''\n def __truediv__(self,name):self.name=name;return self\n def write_text(self,value):return None\n def read_text(self):return {'cgroup.procs':'99' if self.busy else '', 'cgroup.threads':'99' if self.busy else '', 'cgroup.events':'populated 1' if self.busy else 'populated 0'}[self.name]\n def rmdir(self):\n  self.attempts+=1\n  if self.attempts==1:raise OSError(errno.EBUSY,'busy')\ng=Group();a=m['settle_owned_group'](g,Child(),0.2);b=m['settle_owned_group'](Group(True),Child(),0.05);print(json.dumps({'clean':a['proven'],'attempts':g.attempts,'occupied':b['proven']}))";
 const out=execFileSync('python',['-c',py,resolve('scripts/kimi-p1/owned-service.py')],{env:{...childEnv(),PYTHONDONTWRITEBYTECODE:'1'},windowsHide:true,encoding:'utf8'});
 assert.deepEqual(JSON.parse(out),{clean:true,attempts:2,occupied:false});
});

test('home recovery refuses a changed marker or unrelated group and only releases its own recorded identity',()=>{
 const py="import sys,json,runpy,tempfile,hashlib;from pathlib import Path;m=runpy.run_path(sys.argv[1]);sid='kimi_service_'+'a'*20;boot='11111111-1111-1111-1111-111111111111';results=[]\nwith tempfile.TemporaryDirectory(prefix='dm-m24-reconcile-') as d:\n home=Path(d);raw=m['reserve_home'](home,sid,boot);digest=hashlib.sha256(raw).hexdigest();group=Path('/sys/fs/cgroup/dream-maker-kimi-services')/('dm-'+sid)\n for expected,target in [('0'*64,group),(digest,Path('/not-owned'))]:\n  try:m['reconcile_pending_home'](home,sid,expected,target,boot);results.append('UNSAFE')\n  except ValueError:results.append('DENIED')\n proof=m['reconcile_pending_home'](home,sid,digest,group,boot);results.extend([proof['proven'],(home/'.dm-owned-service.pending.json').exists()])\nprint(json.dumps(results))";
 const out=execFileSync('python',['-c',py,resolve('scripts/kimi-p1/owned-service.py')],{env:{...childEnv(),PYTHONDONTWRITEBYTECODE:'1'},windowsHide:true,encoding:'utf8'});
 assert.deepEqual(JSON.parse(out),['DENIED','DENIED',true,false]);
});

test('the Linux supervisor independently rejects extra fields, traversal, unpinned code and arbitrary service identity before any process is created',()=>{
 const input={...profile(),serviceId:'kimi_service_'+'a'.repeat(20),instanceId:'kimi_service_'+'a'.repeat(20),accountRef:'OFFLINE_ACCOUNT'};
 const script="import sys,json,runpy; m=runpy.run_path(sys.argv[1]); raw=json.loads(sys.stdin.read()); results=[]\nfor p in raw:\n try:m['validate_profile'](p);results.append('VALID')\n except ValueError:results.append('DENIED')\nprint(json.dumps(results))";
 const cases=[input,{...input,args:['--other']},{...input,home:base+'/../daily-home'},{...input,hashes:{...input.hashes,program:'none'}},{...input,serviceId:'../../not-owned'}];
 const stdout=execFileSync('python',['-c',script,resolve('scripts/kimi-p1/owned-service.py')],{input:JSON.stringify(cases),encoding:'utf8',env:{...childEnv(),PYTHONDONTWRITEBYTECODE:'1'},windowsHide:true});
 assert.deepEqual(JSON.parse(stdout),['VALID','DENIED','DENIED','DENIED','DENIED']);
});

test('the Linux supervisor accepts one complete private proxy tuple and rejects partial, public or loopback-only metadata',()=>{
 const input={...profile(),serviceId:'kimi_service_'+'a'.repeat(20),instanceId:'kimi_service_'+'a'.repeat(20),accountRef:'OFFLINE_ACCOUNT'};
 const environment={
  HTTP_PROXY:'http://172.27.48.1:7890/',http_proxy:'http://172.27.48.1:7890/',
  HTTPS_PROXY:'http://172.27.48.1:7890/',https_proxy:'http://172.27.48.1:7890/',
  ALL_PROXY:'http://172.27.48.1:7890/',all_proxy:'http://172.27.48.1:7890/',
  NO_PROXY:'localhost,127.0.0.1,::1,[::1]',no_proxy:'localhost,127.0.0.1,::1,[::1]'
 };
 const valid={...input,network:{schema:'dream-maker.kimi-wsl-proxy.v1',environment}};
 const partial={...valid,network:{schema:'dream-maker.kimi-wsl-proxy.v1',environment:{...environment,HTTPS_PROXY:'http://172.27.48.1:7891/'}}};
 const publicProxy={...valid,network:{schema:'dream-maker.kimi-wsl-proxy.v1',environment:Object.fromEntries(Object.entries(environment).map(([k,v])=>[k,v.replaceAll('172.27.48.1','8.8.8.8')]))}};
 const loopback={...valid,network:{schema:'dream-maker.kimi-wsl-proxy.v1',environment:Object.fromEntries(Object.entries(environment).map(([k,v])=>[k,v.replaceAll('172.27.48.1','127.0.0.1')]))}};
 const wrongBypass={...valid,network:{schema:'dream-maker.kimi-wsl-proxy.v1',environment:{...environment,NO_PROXY:'*',no_proxy:'*'}}};
 const script="import sys,json,runpy; m=runpy.run_path(sys.argv[1]); raw=json.loads(sys.stdin.read()); results=[]\nfor p in raw:\n try:m['validate_profile'](p);results.append('VALID')\n except ValueError:results.append('DENIED')\nprint(json.dumps(results))";
 const stdout=execFileSync('python',['-c',script,resolve('scripts/kimi-p1/owned-service.py')],{input:JSON.stringify([valid,partial,publicProxy,loopback,wrongBypass]),encoding:'utf8',env:{...childEnv(),PYTHONDONTWRITEBYTECODE:'1'},windowsHide:true});
 assert.deepEqual(JSON.parse(stdout),['VALID','DENIED','DENIED','DENIED','DENIED']);
});

test('the original application close joins its explicitly owned P1 service exactly once',async t=>{
 const h=harness(t);let stopped=0,closed=0;
 const app=await createApp({root,data:resolve(h.dir,'http-service'),configPath:resolve(h.dir,'config.json'),port:0,
  nativeExecution:{assertReady:()=>{throw Error('OFFLINE_ONLY');},executor:()=>{throw Error('NO_MODEL');},verify:async()=>{throw Error('NO_MODEL');},close:async()=>{}},
  kimiLocalService:{stop:async()=>{stopped++;}},onClosed:()=>{closed++;}});
 await app.close();await app.close();assert.equal(stopped,1);assert.equal(closed,1);
});

test('unproven P1 cleanup keeps the original application close uncertain',async t=>{
 const h=harness(t);let closed=0;
 const app=await createApp({root,data:resolve(h.dir,'http-uncertain'),configPath:resolve(h.dir,'config.json'),port:0,
  nativeExecution:{assertReady:()=>{throw Error('OFFLINE_ONLY');},executor:()=>{throw Error('NO_MODEL');},verify:async()=>{throw Error('NO_MODEL');},close:async()=>{}},
  kimiLocalService:{stop:async()=>{throw Object.assign(Error('offline-unproven'),{code:'KIMI_SERVICE_CLEANUP_UNPROVEN'});}},onClosed:()=>{closed++;}});
 try{await assert.rejects(app.close(),{code:'APPLICATION_CLOSE_UNCERTAIN'});assert.equal(closed,0);}finally{if(app.store.db.isOpen)app.store.close();}
});
