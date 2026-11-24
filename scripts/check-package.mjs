// Verify an extracted release without installing packages or altering any files.
import {readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const manifest=JSON.parse(readFileSync(join(root,'FILE_MANIFEST.json'),'utf8'));
if(manifest.schema!=='dream-maker.file-manifest.v1'||!Array.isArray(manifest.files))throw Error('MANIFEST_SCHEMA');
const seen=new Set();let checked=0;
for(const entry of manifest.files){
  if(typeof entry.path!=='string'||entry.path.startsWith('/')||/[\\:\0]/.test(entry.path)||entry.path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('MANIFEST_PATH');
  if(seen.has(entry.path))throw Error('MANIFEST_DUPLICATE');seen.add(entry.path);
  let current=root;
  for(const part of entry.path.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw Error('SYMLINK:'+entry.path);}
  if(!lstatSync(current).isFile())throw Error('NOT_A_FILE:'+entry.path);
  const bytes=readFileSync(current),digest=createHash('sha256').update(bytes).digest('hex');
  if(bytes.length!==entry.bytes||digest!==entry.sha256)throw Error('CONTENT_CHANGED:'+entry.path);
  checked++;
}
console.log(JSON.stringify({schema:'dream-maker.package-check.v1',status:'PASS',checked,scope:'listed release files only; user runtime/local configuration excluded',changesMade:false},null,2));
