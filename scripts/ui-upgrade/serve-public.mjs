/** Loopback-only static preview, not a remote-agent bridge or Netlify emulator. */
import {createServer} from 'node:http';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const publicDir=resolve(root,'ui-release/public');
export async function createPublicPreview(port=0){
 const allowed=['index.html','style.css','contracts.js','dom.js','views.js','ui.js','demo-api.js','demo-entry.js','sample.html','sample.css','sample.js','404.html','_redirects','_headers','NOTICE.txt'];
 for(const file of readdirSync(publicDir))if(!allowed.includes(file))throw Error('Unexpected public file: '+file);
 const entries=new Set(allowed.filter(n=>!n.startsWith('_')));
 const headers=Object.fromEntries(readFileSync(resolve(publicDir,'_headers'),'utf8').split('\n').filter(l=>l.startsWith('  ')).map(l=>{const i=l.indexOf(':');return[l.slice(2,i),l.slice(i+1).trim()];}));
 const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.txt':'text/plain; charset=utf-8'};
 const server=createServer((req,res)=>{
  for(const [k,v] of Object.entries(headers))res.setHeader(k,v);
  const addr=server.address(),expected='127.0.0.1:'+addr.port;
  if(![expected,'localhost:'+addr.port].includes(req.headers.host)){res.writeHead(403);res.end('HOST_DENIED');return;}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{allow:'GET, HEAD'});res.end('METHOD_DENIED');return;}
  let path;try{path=decodeURIComponent(new URL(req.url,'http://'+expected).pathname);}catch{res.writeHead(400);res.end('INVALID_PATH');return;}
  let file=['/','/workspace','/workspace/'].includes(path)?'index.html':path.slice(1),status=200;
  if(!entries.has(file)||file.includes('/')||file.includes('\\')){file='404.html';status=404;}
  const data=readFileSync(resolve(publicDir,file));res.writeHead(status,{'content-type':mime[extname(file)]||'application/octet-stream','content-length':data.length});res.end(req.method==='HEAD'?undefined:data);
 });
 await new Promise((yes,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',yes);});
 return{origin:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(yes=>{server.closeAllConnections();server.close(yes);})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const port=Number(process.argv[2]||4328);if(!Number.isSafeInteger(port)||port<0||port>65535)throw Error('Port must be 0..65535');
 const preview=await createPublicPreview(port);console.log('UI_DEMO_ONLY '+preview.origin+' (no API, no agents)');
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await preview.close();process.exit(0);});
}
