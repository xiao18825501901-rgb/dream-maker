import {createServer} from 'node:http';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,dirname,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url)),dist=resolve(root,'dist');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
/** Static local UI review only. No Engine, API, credentials, proxy, upload or database. */
export async function createReviewServer({product='dream-maker',port=4328}={}){
 if(!['dream-maker','dreamflow'].includes(product)||!Number.isSafeInteger(port)||port<0||port>65535)throw Error('Invalid review server options');
 const entry=product==='dreamflow'?'frontend-review-flow-app.js':'frontend-review-app.js';
 const files=new Map(),seen=new Set();
 async function add(name){
  if(seen.has(name))return;seen.add(name);
  const file=resolve(dist,'web',name),canonical=await realpath(file),allowed=['web','shared'].some(dir=>{const rel=relative(resolve(dist,dir),canonical);return rel&&!rel.startsWith('..')&&!rel.includes(':')&&!rel.startsWith(sep);});
  if(!allowed||!['.js','.html','.css'].includes(extname(name))||/local-api|(?:^|\/)server\//.test(name))throw Error('Review graph leaves static boundary');
  const bytes=await readFile(canonical);files.set(new URL(name,'http://review.invalid/').pathname,{bytes,type:types[extname(name)]});
  if(extname(name)==='.js')for(const match of bytes.toString('utf8').matchAll(/^\s*(?:import\s+(?:[^\n;]*?\sfrom\s*)?|export\s+[^\n;]*?\sfrom\s*)['"]([^'"]+)['"]/gm)){
   if(!match[1].startsWith('.'))throw Error('Review cannot load external modules');await add(relative(resolve(dist,'web'),resolve(dirname(file),match[1])).split(sep).join('/'));
  }
 }
 await add(entry);await add('style.css');
 for(const name of ['sample.html','sample.css','sample.js']){
  const bytes=await readFile(resolve(root,'src/web/sample',name));files.set('/'+name,{bytes,type:types[extname(name)]});
 }
 const raw=await readFile(resolve(dist,'web','index.html'),'utf8');
 const html=raw
  .replace(/<title>[^<]*<\/title>/,`<title>${product==='dreamflow'?'DreamFlow':'Dream Maker'} · 本地前端导览</title>`)
  .replace(/<link id="chat-style"[^>]*>/,`<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css"></link>`)
  .replace(/<script type="module" src="\/chat-entry\.js"><\/script>/,`<script type="module" src="/${entry}"></script>`)
  .replace(/<main class="dc-splash"[\s\S]*?<\/main>/,'<main aria-label="Dream Maker"><p role="status">正在打开前端演示，不连接账户或模型…</p></main>');
 if(!html.includes(`src="/${entry}"`))throw Error('Review homepage did not take the review entry');
 files.set('/',{bytes:Buffer.from(html),type:types['.html']});
 let expectedHost='';
 const server=createServer((req,res)=>{
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"};
  const finish=(status,text)=>{res.writeHead(status,{...headers,'Content-Type':'text/plain; charset=utf-8'});res.end(text);};
  if(req.headers.host!==expectedHost||req.headers.origin&&req.headers.origin!=='http://'+expectedHost){finish(403,'Local review only');return;}
  if(!['GET','HEAD'].includes(req.method)){finish(405,'Static review only');return;}
  let path;try{path=decodeURIComponent(new URL(req.url,'http://'+expectedHost).pathname);}catch{finish(400,'Invalid path');return;}
  if(path.includes('\\')||path.includes('\0')){finish(404,'Not found');return;}
  const value=files.get(path);if(!value){finish(404,'Not found');return;}
  // The fixed sample keeps its opaque sandbox origin. Only its two public static
  // resources permit that origin to load them; controller/module resources stay same-origin.
  const responseHeaders=path.startsWith('/sample.')?{...headers,'Content-Security-Policy':headers['Content-Security-Policy'].replace("frame-ancestors 'none'","frame-ancestors 'self'"),...(['/sample.css','/sample.js'].includes(path)?{'Cross-Origin-Resource-Policy':'cross-origin'}:{})}:headers;
  res.writeHead(200,{...responseHeaders,'Content-Type':value.type});res.end(req.method==='HEAD'?undefined:value.bytes);
 });
 server.requestTimeout=5000;server.headersTimeout=5000;server.maxRequestsPerSocket=100;
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',ok);});
 expectedHost='127.0.0.1:'+server.address().port;
 return {url:'http://'+expectedHost+'/',product,files:[...files.keys()],close:()=>new Promise((ok,fail)=>{server.close(error=>error?fail(error):ok());server.closeIdleConnections();})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const product=process.argv[2]??'dream-maker',app=await createReviewServer({product,port:product==='dreamflow'?4329:4328});
 process.stdout.write(JSON.stringify({pid:process.pid,url:app.url,product,kind:'FRONTEND_REVIEW_SYNTHETIC_NO_API'})+'\n');
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void app.close().then(()=>process.exit(0)));
}
