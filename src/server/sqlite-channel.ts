import {createHash} from 'node:crypto';
import {DomainError,object} from './security.js';

export const SQLITE_IMAGE_LIMIT=64*1024*1024;
const METADATA_LIMIT=2000000;
const EMPTY_HASH=createHash('sha256').digest('hex');
const MAGIC=Buffer.from('SQLite format 3\0');
const digest=(body:Buffer)=>createHash('sha256').update(body).digest('hex');
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const revision=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const imageSize=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=SQLITE_IMAGE_LIMIT&&value%512===0;
function fail(code='SQLITE_CHANNEL_INVALID'):never{throw new DomainError(code,502);}
export interface SqliteChannelBinding {inputHash:string;expectedRevision:number}
export interface SqliteInputDescriptor extends SqliteChannelBinding {
 schema:'dream-maker.sqlite-exchange.v1';kind:'SQLITE_IMAGE_V1';imageBytes:number;imageHash:string;
}
export interface SqliteFrame extends SqliteChannelBinding {
 schema:'dream-maker.sqlite-frame.v1';kind:'SQLITE_IMAGE_V1';imageBytes:number;imageHash:string;result:Record<string,unknown>;
}
function checkBinding(binding:SqliteChannelBinding){if(!sha(binding.inputHash)||!revision(binding.expectedRevision))fail();}
/** Byte-header validation only. SQLite parsing/integrity/backup belong inside the isolated worker. */
export function checkSqliteImageBytes(body:Buffer):void{
 if(!Buffer.isBuffer(body)||body.length<512||!imageSize(body.length)||!body.subarray(0,16).equals(MAGIC))fail('SQLITE_IMAGE_HEADER_INVALID');
 const encoded=body.readUInt16BE(16),pageSize=encoded===1?65536:encoded;
 if(pageSize<512||pageSize>65536||(pageSize&(pageSize-1))!==0||body.length%pageSize!==0||![1,2].includes(body[18])||![1,2].includes(body[19]))fail('SQLITE_IMAGE_HEADER_INVALID');
}
export function validateSqliteInputDescriptor(raw:unknown):SqliteInputDescriptor{
 const value=object(raw);
 if(Object.keys(value).some(key=>!['schema','kind','inputHash','expectedRevision','imageBytes','imageHash'].includes(key))||value.schema!=='dream-maker.sqlite-exchange.v1'||value.kind!=='SQLITE_IMAGE_V1'||!sha(value.inputHash)||!revision(value.expectedRevision)||!imageSize(value.imageBytes)||!sha(value.imageHash)||value.imageBytes===0&&(value.expectedRevision!==0||value.imageHash!==EMPTY_HASH))fail();
 return value as unknown as SqliteInputDescriptor;
}
export function sqliteInputDescriptor(image:Buffer|null,binding:SqliteChannelBinding):SqliteInputDescriptor{
 checkBinding(binding);if(image!==null)checkSqliteImageBytes(image);
 return validateSqliteInputDescriptor({schema:'dream-maker.sqlite-exchange.v1',kind:'SQLITE_IMAGE_V1',inputHash:binding.inputHash,expectedRevision:binding.expectedRevision,imageBytes:image?.length??0,imageHash:image===null?EMPTY_HASH:digest(image)});
}
/** Only fixed controller/worker code constructs headers; this is not an audit or result validator. */
export function sqliteFrameHeader(result:Record<string,unknown>,image:Buffer|null,binding:SqliteChannelBinding):Buffer{
 checkBinding(binding);if(image!==null)checkSqliteImageBytes(image);
 const header=Buffer.from(JSON.stringify({schema:'dream-maker.sqlite-frame.v1',kind:'SQLITE_IMAGE_V1',inputHash:binding.inputHash,expectedRevision:binding.expectedRevision,imageBytes:image?.length??0,imageHash:image===null?EMPTY_HASH:digest(image),result})+'\n');
 if(header.length-1>METADATA_LIMIT)fail('SQLITE_CHANNEL_METADATA_LIMIT');return header;
}
function readFrame(body:Buffer,binding:SqliteChannelBinding):SqliteFrame{
 let parsed:unknown;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{fail();}
 const value=object(parsed);
 if(value.schema==='dream-maker.wsl-supervisor-error.v1'&&typeof value.code==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(value.code))fail('SANDBOX_SUPERVISOR_'+value.code);
 if(Object.keys(value).some(key=>!['schema','kind','inputHash','expectedRevision','imageBytes','imageHash','result'].includes(key))||value.schema!=='dream-maker.sqlite-frame.v1'||value.kind!=='SQLITE_IMAGE_V1'||value.inputHash!==binding.inputHash||value.expectedRevision!==binding.expectedRevision||!imageSize(value.imageBytes)||!sha(value.imageHash)||value.imageBytes===0&&value.imageHash!==EMPTY_HASH)fail();
 object(value.result);return value as unknown as SqliteFrame;
}
/** One bounded metadata line followed by exactly the declared bytes. No SQL, base64 or file paths. */
export class SqliteFrameDecoder {
 private prefix=Buffer.allocUnsafe(METADATA_LIMIT);private prefixBytes=0;private frame:SqliteFrame|null=null;
 private image:Buffer|null=null;private received=0;private checksum=createHash('sha256');private closed=false;private failed=false;
 private readonly binding:SqliteChannelBinding;
 constructor(binding:SqliteChannelBinding){this.binding={inputHash:binding.inputHash,expectedRevision:binding.expectedRevision};checkBinding(this.binding);}
 push(chunk:Buffer):void{
  if(this.closed||this.failed)fail('SQLITE_CHANNEL_CLOSED');
  try{
   if(!Buffer.isBuffer(chunk))fail();
   if(!this.frame){
    const newline=chunk.indexOf(10),end=newline<0?chunk.length:newline;
    if(this.prefixBytes+end>METADATA_LIMIT)fail('SQLITE_CHANNEL_METADATA_LIMIT');
    chunk.copy(this.prefix,this.prefixBytes,0,end);this.prefixBytes+=end;
    if(newline<0)return;
    this.frame=readFrame(this.prefix.subarray(0,this.prefixBytes),this.binding);this.prefix=Buffer.alloc(0);
    this.image=this.frame.imageBytes?Buffer.allocUnsafe(this.frame.imageBytes):null;chunk=chunk.subarray(newline+1);
   }
   if(this.received+chunk.length>this.frame.imageBytes)fail('SQLITE_CHANNEL_LENGTH_MISMATCH');
   if(chunk.length){const start=this.received;chunk.copy(this.image!,start);this.received+=chunk.length;this.checksum.update(this.image!.subarray(start,this.received));}
  }catch(error){this.failed=true;this.image=null;this.prefix=Buffer.alloc(0);throw error;}
 }
 finish():{frame:SqliteFrame;image:Buffer|null}{
  if(this.closed||this.failed)fail('SQLITE_CHANNEL_CLOSED');this.closed=true;
  if(!this.frame||this.received!==this.frame.imageBytes)fail('SQLITE_CHANNEL_TRUNCATED');
  if(this.checksum.digest('hex')!==this.frame.imageHash)fail('SQLITE_CHANNEL_HASH_MISMATCH');
  const image=this.image;this.image=null;
  if(image)checkSqliteImageBytes(image);return {frame:this.frame,image};
 }
}
