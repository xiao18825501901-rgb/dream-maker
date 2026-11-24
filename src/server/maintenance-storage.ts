import {existsSync,lstatSync,readdirSync} from 'node:fs';
import {DomainError,within} from './security.js';
export const MAINTENANCE_STORAGE_LIMIT=1000000000;
/** One measured pool for state copies, rehearsals, file archives and extraction directories. */
export function maintenanceStorageBytes(data:string):number{
 let bytes=0,nodes=0;
 const walk=(folder:string,depth:number)=>{
  if(depth>36)throw new DomainError('MAINTENANCE_STORAGE_LIMIT',409);
  for(const entry of readdirSync(folder,{withFileTypes:true})){
   if(++nodes>50000||entry.isSymbolicLink())throw new DomainError('MAINTENANCE_STORAGE_UNKNOWN',409);
   const path=within(folder,entry.name),stat=lstatSync(path);
   if(stat.isDirectory())walk(path,depth+1);else if(stat.isFile()){bytes+=stat.size;if(!Number.isSafeInteger(bytes))throw new DomainError('MAINTENANCE_STORAGE_LIMIT',409);}else throw new DomainError('MAINTENANCE_STORAGE_UNKNOWN',409);
  }
 };
 for(const name of ['state-backups','state-rehearsals','registered-backups','registered-extractions']){const folder=within(data,'controller/'+name);if(existsSync(folder)){if(!lstatSync(folder).isDirectory())throw new DomainError('MAINTENANCE_STORAGE_UNKNOWN',409);walk(folder,0);}}
 return bytes;
}
export interface MaintenanceAllocation {files:number;directories:number;unit:bigint}
/** Logical content is quota-bound; free-space admission also reserves measured allocation padding,
 * directory/file metadata and a fixed margin. This intentionally overestimates physical growth. */
export function assertMaintenanceRoom(used:number,additional:number,free:bigint,code='MAINTENANCE_STORAGE_LIMIT',allocation?:MaintenanceAllocation):void{
 if(![used,additional,used+additional].every(v=>Number.isSafeInteger(v)&&v>=0)||used+additional>MAINTENANCE_STORAGE_LIMIT)throw new DomainError(code,409);
 let physical=BigInt(additional);
 if(allocation){
  if(![allocation.files,allocation.directories].every(v=>Number.isSafeInteger(v)&&v>=0)||allocation.unit<=0n||allocation.unit>1073741824n)throw new DomainError(code,409);
  const unit=4096n;
  physical+=BigInt(allocation.files*3+allocation.directories*2+32)*unit+1048576n;
 }
 if(free<physical+256000000n)throw new DomainError(code,409);
}
