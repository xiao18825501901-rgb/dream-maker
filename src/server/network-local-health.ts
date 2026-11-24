import{connect}from'node:net';
import{
 CODEX_CONTROL_TARGET_HOSTS,
 type CodexControlTargetHost,
 type LocalProxyHealth,
 type OpenAiTlsProbe
}from'../shared/network-contexts.js';
import{DomainError}from'./security.js';
const cancelled=()=>new DomainError('NETWORK_CHECK_CANCELLED',409);
function wait(ms:number,signal:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{
 const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);resolve();},abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(cancelled());},timer=setTimeout(done,ms);
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
});}
function tcp(host:string,port:number,signal:AbortSignal):Promise<LocalProxyHealth['samples'][number]>{return new Promise((resolve,reject)=>{
 const started=Date.now(),socket=connect({host,port});let finished=false;
 const finish=(state:LocalProxyHealth['samples'][number]['state'])=>{if(finished)return;finished=true;signal.removeEventListener('abort',abort);socket.destroy();resolve({at:new Date().toISOString(),state,elapsedMs:Math.max(0,Date.now()-started)});};
 const abort=()=>{if(finished)return;finished=true;signal.removeEventListener('abort',abort);socket.destroy();reject(cancelled());};
 socket.setTimeout(2000);socket.once('connect',()=>finish('CONNECTED'));socket.once('timeout',()=>finish('TIMEOUT'));socket.on('error',e=>finish((e as NodeJS.ErrnoException).code==='ECONNREFUSED'?'REFUSED':(e as NodeJS.ErrnoException).code==='ECONNRESET'?'RESET':'UNAVAILABLE'));
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
});}
const noTls=(target:OpenAiTlsProbe['target']):OpenAiTlsProbe=>({state:'NOT_TESTED',target,protocol:null,authorized:false,alpn:null,elapsedMs:null,selectedNode:null,selectionMatchesExpected:null,nodeChainMatched:false,errorClass:null,httpRequestSent:false,modelCalls:0});
const failedTls=(target:OpenAiTlsProbe['target'],error:unknown):OpenAiTlsProbe=>{
 const code=typeof(error as {code?:unknown})?.code==='string'?String((error as {code:string}).code):'TLS_PROBE_FAILED';
 return{...noTls(target),state:'FAILED',errorClass:/^[A-Z0-9_]{1,80}$/.test(code)?code:'TLS_PROBE_FAILED'};
};
/** Six local TCP reads plus separate OpenAI API, Codex-login and DeepSeek
 * Executor target TLS checks. This is not an inference, role-session,
 * WebSocket, OAuth or service-eligibility test and never chooses nodes. */
export async function observeLocalProxyHealth(input:{
 proxyUrl:string;
 controller:{version:(signal?:AbortSignal)=>Promise<unknown>};
 signal:AbortSignal;
 tlsProbe?:()=>Promise<OpenAiTlsProbe>;
 codexTlsProbe?:()=>Promise<OpenAiTlsProbe>;
 codexControlTlsProbes?:Partial<Record<CodexControlTargetHost,()=>Promise<OpenAiTlsProbe>>>;
 deepSeekTlsProbe?:()=>Promise<OpenAiTlsProbe>;
},pause=wait):Promise<LocalProxyHealth>{
 let url:URL;try{url=new URL(input.proxyUrl);}catch{throw new DomainError('NETWORK_LOCAL_TARGET_REQUIRED',409);}
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.port)throw new DomainError('NETWORK_LOCAL_TARGET_REQUIRED',409);
 const check=()=>{if(input.signal.aborted)throw cancelled();};check();
 const startedAt=new Date().toISOString(),read=async()=>{try{await input.controller.version(input.signal);check();return true;}catch{check();return false;}};
 const first=await read(),samples:LocalProxyHealth['samples']=[];
 const host=url.hostname==='localhost'?'127.0.0.1':url.hostname.replace(/^\[|\]$/g,'');
 for(let i=0;i<6;i++){if(i)await pause(2000,input.signal);check();samples.push(await tcp(host,Number(url.port),input.signal));}
 const last=await read();check();const readable=first&&last;
 const probe=async(target:OpenAiTlsProbe['target'],fn?:()=>Promise<OpenAiTlsProbe>)=>{
  if(!fn)return noTls(target);
  try{const value=await fn();check();return value;}catch(error){check();return failedTls(target,error);}
 };
 const [openAiTls,codexTls,deepSeekTls]=await Promise.all([
  probe('api.openai.com:443',input.tlsProbe),
  probe('chatgpt.com:443',input.codexTlsProbe),
  probe('api.deepseek.com:443',input.deepSeekTlsProbe)
 ]);
 const codexControlTlsProbes=input.codexControlTlsProbes?await Promise.all(
   CODEX_CONTROL_TARGET_HOSTS.map(host=>probe(`${host}:443`,input.codexControlTlsProbes?.[host]))
 ):undefined;
 return{schema:'dream-maker.local-proxy-health.v1',scope:'LOCAL_CFW_AND_OPENAI_TLS_NO_HTTP',startedAt,completedAt:new Date().toISOString(),state:readable&&samples.every(s=>s.state==='CONNECTED')?'SHORT_WINDOW_OK':'INTERRUPTED',address:url.hostname+':'+url.port,controller:readable?'READABLE':'UNAVAILABLE',samples,websocket:'NOT_TESTED',modelCalls:0,oauthAttempts:0,networkSettingsChanged:false,openAiTls,codexTls,deepSeekTls,...(codexControlTlsProbes?{codexControlTlsProbes}:{})};
}
