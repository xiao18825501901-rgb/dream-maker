import {resolve} from 'node:path';

// Only exact files discovered by the existing walker may be passed to Node.
export function selectTestFiles(discovered,targets,root){
 if(!targets.length)return discovered;
 const known=new Set(discovered),selected=new Set();
 for(const target of targets){
  const file=resolve(root,target);
  if(target.startsWith('-')||!known.has(file))throw new Error('TEST_TARGET_NOT_DISCOVERED: '+target);
  selected.add(file);
 }
 return [...selected];
}
