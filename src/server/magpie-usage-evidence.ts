import {existsSync,lstatSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {within} from './security.js';

const USAGE_KEYS = [
  't',
  'agent',
  'provider',
  'callerKeyId',
  'callerKeyName',
  'model',
  'in',
  'out',
  'cache_read',
  'cache_write',
  'ms',
  'status',
  'err',
  'err_type',
  'ep',
  'rejected',
].sort();

function ordinaryDirectory(path:string):boolean {
  try {
    const stat=lstatSync(path);
    return stat.isDirectory()&&!stat.isSymbolicLink();
  }catch{
    return false;
  }
}

/**
 * Proves that one acknowledged admission was rejected by the owned Magpie
 * before an upstream request. This reads only a fresh, bounded usage log and
 * fails closed on ambiguous files.
 */
export function exactPreUpstreamGatewayRejection(input:{
  root:string;
  admissionId:string;
  expectedBinarySha256:string;
  from:string;
  to:string;
}):boolean {
  try{
    const admissionId=input.admissionId,expectedBinarySha256=input.expectedBinarySha256;
    if(typeof admissionId!=='string'||!/^admission_[A-Za-z0-9_-]{1,100}$/.test(admissionId))return false;
    if(typeof expectedBinarySha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedBinarySha256))return false;
    const from=Date.parse(input.from),to=Date.parse(input.to);
    if(!Number.isFinite(from)||!Number.isFinite(to)||to<from||to-from>10*60*1000)return false;
    const parent=within(input.root,'.runtime/magpie-controls');
    if(!ordinaryDirectory(parent))return false;
    const entries=readdirSync(parent,{withFileTypes:true});
    if(entries.length>256)return false;
    let matches=0;
    for(const entry of entries){
      if(!entry.isDirectory()||!entry.isSymbolicLink()===false||!/^owned-[A-Za-z0-9_-]{1,100}$/.test(entry.name))continue;
      const runtime=join(parent,entry.name);
      if(!ordinaryDirectory(runtime)||!ordinaryDirectory(join(runtime,'data')))continue;
      let usagePath:string;
      try{
        usagePath=within(input.root,`.runtime/magpie-controls/${entry.name}/data/usage.jsonl`);
      }catch{
        return false;
      }
      if(!existsSync(usagePath))continue;
      const stat=lstatSync(usagePath);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>1024*1024)return false;
      const lines=readFileSync(usagePath,'utf8').split(/\r?\n/).filter(Boolean);
      if(lines.length!==1)return false;
      let value:unknown;
      try{
        value=JSON.parse(lines[0]);
      }catch{
        return false;
      }
      if(!value||typeof value!=='object'||Array.isArray(value))return false;
      const row=value as Record<string,unknown>;
      if(JSON.stringify(Object.keys(row).sort())!==JSON.stringify(USAGE_KEYS))continue;
      if(row.callerKeyName!==`Dream Maker ${admissionId}`)continue;
      matches+=1;
      if(matches!==1)return false;
      const executable=within(input.root,`.runtime/magpie-controls/${entry.name}/dream-maker-magpie.exe`);
      if(!existsSync(executable))return false;
      const executableStat=lstatSync(executable);
      if(!executableStat.isFile()||executableStat.isSymbolicLink()||executableStat.size<1||executableStat.size>128*1024**2)return false;
      if(createHash('sha256').update(readFileSync(executable)).digest('hex')!==expectedBinarySha256)return false;
      const at=typeof row.t==='string'?Date.parse(row.t):NaN;
      if(!Number.isFinite(at)||at<from-1000||at>to+1000||
        row.agent!=='DreamMaker-Dedicated-Magpie'||
        row.provider!==''||typeof row.callerKeyId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(row.callerKeyId)||
        row.model!==''||row.in!==0||row.out!==0||row.cache_read!==0||row.cache_write!==0||row.ms!==0||
        row.status!==503||typeof row.err!=='string'||!row.err||row.err_type!=='gateway_key_limit_off'||
        row.ep!=='/v1/messages'||row.rejected!==true)return false;
    }
    return matches===1;
  }catch{
    return false;
  }
}
