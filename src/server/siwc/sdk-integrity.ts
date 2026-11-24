import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** Reproducible identity of all built SDK outputs. This is a supplementary local
 * integrity check, NOT a signature, license approval, npm supply-chain audit or
 * independent proof of a correct build. Trust the expected value only after a
 * reviewed pinned source build, never from the inspected checkout itself. */
export function computeSdkBuildHash(directory: string): {sha256:string; files:number} {
  const root=realpathSync(resolve(directory));
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw Error('SIWC_BUILD_ROOT_INVALID');
  const seen: Array<{name:string;sha256:string;size:number}>=[];
  function walk(dir:string):void {
    for(const item of readdirSync(dir,{withFileTypes:true})) {
      const full=join(dir,item.name),stat=lstatSync(full);
      if (stat.isSymbolicLink() || !stat.isFile()&&!stat.isDirectory()) throw Error('SIWC_BUILD_SPECIAL_FILE_DENIED');
      if (stat.isDirectory()) { walk(full);continue; }
      if (stat.size > 16*1024*1024)throw Error('SIWC_BUILD_OUTPUT_OVERSIZE');
      const name=relative(root,full).split(sep).join('/');
      if(!name || name.split('/').some(x=>x==='..'||x==='.') || !/^[A-Za-z0-9_./-]+$/.test(name))throw Error('SIWC_BUILD_PATH_INVALID');
      const bytes=readFileSync(full);
      seen.push({name,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length});
      if (seen.length>200)throw Error('SIWC_BUILD_TOO_MANY_FILES');
    }
  }
  walk(root);seen.sort((a,b)=>a.name.localeCompare(b.name,'en'));
  if(!seen.some(x=>x.name==='index.js') || !seen.some(x=>x.name==='index.d.ts'))throw Error('SIWC_BUILD_ENTRY_MISSING');
  const hash=createHash('sha256');
  for(const file of seen)hash.update(file.name+'\0'+file.size+'\0'+file.sha256+'\n');
  return {sha256:hash.digest('hex'),files:seen.length};
}
