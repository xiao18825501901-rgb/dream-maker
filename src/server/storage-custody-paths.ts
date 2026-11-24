import {DomainError} from './security.js';
import type {StorageCustody} from './windows-storage-custody.js';

export const STORAGE_CUSTODY_PARENT_DIRECTORY_LIMIT=128;

function deny():never{throw new DomainError('STORAGE_CUSTODY_PATH_DENIED',409);}

function checkedPath(value:string){
 if(typeof value!=='string'||!value||value.length>512||value.includes('\\')||value.startsWith('/')||/[\r\n\0]/.test(value))deny();
 const parts=value.split('/');
 if(parts.some(part=>part===''||part==='.'||part==='..'))deny();
 return parts;
}

/** Every directory that must remain pinned while a child file is created or read. */
export function custodyParentDirectories(paths:string[]):string[]{
 if(!Array.isArray(paths))deny();
 const directories=new Set<string>();
 for(const path of paths){
  const parts=checkedPath(path);
  for(let count=1;count<parts.length;count++){
   directories.add(parts.slice(0,count).join('/'));
   if(directories.size>STORAGE_CUSTODY_PARENT_DIRECTORY_LIMIT)
    throw new DomainError('STORAGE_CUSTODY_PATH_LIMIT',409);
  }
 }
 return [...directories].sort();
}

/** Keep custody creation/validation in one place so callers cannot silently use
 * recursive Node filesystem creation under a mutable ancestor. */
export async function pinCustodyParentDirectories(
 lease:Pick<StorageCustody,'directory'>,
 base:string,
 paths:string[],
 create:boolean,
):Promise<number>{
 const root=base?checkedPath(base).join('/'):'';
 const directories=custodyParentDirectories(paths);
 for(const directory of directories)await lease.directory(root?root+'/'+directory:directory,create);
 return directories.length;
}
