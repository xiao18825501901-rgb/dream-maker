import { newId } from './contracts.js';
import {checkedDemoTasks,type DemoTask} from '../shared/demo-tasks.js';
import type {ManagedDataOperationView,ManagedDataView} from '../shared/managed-data.js';
import {readManagedData} from './managed-data-view.js';
type Task=DemoTask;
export function previewTasks(value:unknown):Task[]{return checkedDemoTasks(value);}
type Frame = Pick<HTMLIFrameElement,'src'|'contentWindow'>;
/** Only the hash-verified fixed Demo can store bounded task data. No API proxy. */
export class PreviewStorageBridge {
  private session: {url:string;channel:string;key:string}|null=null;
  private frame: Frame|null=null;
  constructor(private storage:()=>Pick<Storage,'getItem'|'setItem'>, private parentOrigin:string) {}
  prepare(base:string,runId:string,treeHash:string):string {
    const url=new URL(base),parent=new URL(this.parentOrigin);
    if (url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.origin===parent.origin ||
      url.username || url.password || url.search || url.hash || parent.protocol!=='http:' ||
      !['127.0.0.1','localhost'].includes(parent.hostname) || !/^[A-Za-z0-9_-]+$/.test(runId) || !/^[a-f\d]{64}$/.test(treeHash))
      throw Error('PREVIEW_STORAGE_SCOPE_DENIED');
    const channel=newId();url.searchParams.set('dm_parent',parent.origin);url.searchParams.set('dm_channel',channel);
    this.session={url:url.href,channel,key:'dream-maker.preview.tasks.v1:'+runId+':'+treeHash};
    this.frame=null;return url.href;
  }
  bind(frame:Frame|null):void { this.frame=frame; }
  clear():void { this.frame=null;this.session=null; }
  legacySnapshot():{present:boolean;tasks:Task[]}{
    if(!this.session)throw Error('PREVIEW_STORAGE_SCOPE_DENIED');
    const raw=this.storage().getItem(this.session.key);return {present:raw!==null,tasks:previewTasks(JSON.parse(raw??'[]'))};
  }
  receive(event:Pick<MessageEvent,'origin'|'source'|'data'>):boolean {
    const s=this.session,f=this.frame,d=event.data;
    if (!s || !f || f.src!==s.url || event.source!==f.contentWindow || event.origin!=='null' ||
      !d || typeof d!=='object' || d.type!=='dm-preview-storage' || d.version!==1 || d.channel!==s.channel ||
      typeof d.requestId!=='string' || !/^[A-Za-z0-9_-]{1,80}$/.test(d.requestId) ||
      !['read','write'].includes(d.op) || Object.keys(d).some(k=>!['type','version','channel','requestId','op','tasks'].includes(k))) return false;
    let tasks:Task[]=[],error='';
    try {
      const storage=this.storage();
      if(d.op==='write'){tasks=previewTasks(d.tasks);storage.setItem(s.key,JSON.stringify(tasks));}
      else tasks=previewTasks(JSON.parse(storage.getItem(s.key)??'[]'));
    }catch { error='PREVIEW_STORAGE_UNAVAILABLE_OR_INVALID'; }
    // Opaque-origin frames require '*'. Window identity and nonce are checked above;
    // the reply is task data only, never credentials, files or controller commands.
    f.contentWindow?.postMessage({type:'dm-preview-storage-result',version:1,channel:s.channel,requestId:d.requestId,tasks,error},'*');
    return true;
  }
}

interface ManagedPreviewClient {
 read(runId:string,treeHash:string):Promise<unknown>;
 write(runId:string,treeHash:string,tasks:Task[],revision:number):Promise<unknown>;
}
/** Exact fixed Demo data messages only. Revision comes from the displayed read, never a fresh rebase. */
export class ManagedPreviewBridge {
 private session:{url:string;channel:string;runId:string;treeHash:string;revision:number|null;busy:boolean;requests:Set<string>}|null=null;
 private frame:Frame|null=null;
 constructor(private client:ManagedPreviewClient,private parentOrigin:string,private changed?:(data:ManagedDataView)=>void){}
 prepare(base:string,runId:string,treeHash:string):string{
  const legacy=new PreviewStorageBridge(()=>{throw Error('NO_BROWSER_STORAGE');},this.parentOrigin),url=new URL(legacy.prepare(base,runId,treeHash));url.searchParams.set('dm_data','2');
  this.session={url:url.href,channel:url.searchParams.get('dm_channel')!,runId,treeHash,revision:null,busy:false,requests:new Set()};this.frame=null;return url.href;
 }
 bind(frame:Frame|null):void{this.frame=frame;}
 clear():void{this.frame=null;this.session=null;}
 async receive(event:Pick<MessageEvent,'origin'|'source'|'data'>):Promise<boolean>{
  const s=this.session,f=this.frame,d=event.data;
  if(!s||!f||f.src!==s.url||event.source!==f.contentWindow||event.origin!=='null'||!d||typeof d!=='object'||d.type!=='dm-preview-data'||d.version!==2||d.channel!==s.channel||typeof d.requestId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(d.requestId)||!['read','write'].includes(d.op)||Object.keys(d).some(k=>!['type','version','channel','requestId','op',...(d.op==='write'?['tasks','revision']:[])].includes(k)))return false;
  const reply=(values:object)=>{if(this.session===s&&this.frame===f&&f.src===s.url)f.contentWindow?.postMessage({type:'dm-preview-data-result',version:2,channel:s.channel,requestId:d.requestId,...values},'*');};
  if(s.busy){reply({error:'MANAGED_DATA_BUSY'});return true;}
  if(s.requests.has(d.requestId)||s.requests.size>=10000){reply({error:'MANAGED_DATA_REQUEST_DENIED'});return true;}
  s.requests.add(d.requestId);s.busy=true;
  try{
   let result:unknown;
   if(d.op==='write'){
    if(s.revision===null||!Number.isSafeInteger(d.revision)||d.revision!==s.revision)throw Object.assign(Error('stale'),{code:'MANAGED_DATA_CONFLICT'});
    const values=previewTasks(d.tasks);result=await this.client.write(s.runId,s.treeHash,values,d.revision);
    const operation=(result as ManagedDataOperationView)?.operation;
    if(!operation||operation.appliedRevision!==(result as ManagedDataView)?.revision)throw Object.assign(Error('changed'),{code:'MANAGED_DATA_CONFLICT'});
   }else result=await this.client.read(s.runId,s.treeHash);
   const data=readManagedData(result);if(this.session!==s||this.frame!==f)return true;
   s.revision=data.revision;reply({tasks:data.tasks,revision:data.revision,error:''});this.changed?.(data);
  }catch(error){const code=(error as {code?:unknown})?.code;reply({error:typeof code==='string'&&/^[A-Z_]{1,80}$/.test(code)?code:'MANAGED_DATA_UNCERTAIN'});}
  finally{s.busy=false;}
  return true;
 }
}
