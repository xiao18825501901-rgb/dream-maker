// Mechanical import of absent hash-verified files; existing files become review candidates only.
import { readFileSync, writeFileSync, lstatSync, mkdirSync } from 'node:fs';
import { resolve, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { within, childEnv } from '../../dist/server/security.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const pack=resolve(process.argv[2]??'');
const digest=b=>createHash('sha256').update(b).digest('hex');
const raw=readFileSync(resolve(pack,'PATCH_MANIFEST.json'));
if(digest(raw)!=='0fac465cf479d5c19e454fea19b10f9877f1692fb8277d033d0658cb2d4bf542')throw Error('UNREVIEWED_PATCH_MANIFEST');
const m=JSON.parse(raw);
const items=m.files.map(f=>{
  const dest=within(root,f.path),source=within(resolve(pack,'overlay'),f.path);
  const bytes=readFileSync(source);
  if(digest(bytes)!==f.newSha256)throw Error('OVERLAY_CHANGED');
  if(!f.oldSha256&&lstatSync(dest,{throwIfNoEntry:false}))throw Error('NEW_FILE_COLLISION:'+f.path);
  if(f.oldSha256){const base=within(resolve(pack,'base'),f.path);if(digest(readFileSync(base))!==f.oldSha256)throw Error('BASE_CHANGED');}
  return {...f,dest,source,bytes};
});
const report={schema:'dream-maker.siwc-manual-merge.v1',parent:'f17a0e2',at:new Date().toISOString(),imported:[],candidates:[]};
for(const f of items){
  if(!f.oldSha256){mkdirSync(dirname(f.dest),{recursive:true});within(root,f.path);writeFileSync(f.dest,f.bytes,{flag:'wx'});report.imported.push(f.path);continue;}
  const candidate=resolve(root,'.runtime/siwc-merge-candidates',f.path);
  const currentSha256=digest(readFileSync(f.dest));
  const r=spawnSync('git',['merge-file','--stdout','--diff3','-L','CURRENT','-L','BASE','-L','R2',f.dest,resolve(pack,'base',f.path),f.source],{env:childEnv(),encoding:'utf8',maxBuffer:2000000,timeout:5000});
  if(r.error||r.status===null||r.status<0||r.status>127)throw Error('MERGE_CANDIDATE_FAILED');
  mkdirSync(dirname(candidate),{recursive:true});writeFileSync(candidate,r.stdout,{flag:'wx'});
  report.candidates.push({path:f.path,currentSha256,baseSha256:f.oldSha256,overlaySha256:f.newSha256,conflictCount:r.status,candidate:relative(root,candidate).split(sep).join('/')});
}
writeFileSync(resolve(root,'docs/siwc/R2_MERGE_CANDIDATES.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({imported:report.imported.length,candidates:report.candidates}));
