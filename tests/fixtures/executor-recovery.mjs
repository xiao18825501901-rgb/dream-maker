// OFFLINE setup with actual F files/SQLite. Never a Native admission, model or product review receipt.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {resolve,sep} from 'node:path';
import assert from 'node:assert/strict';
import {harness,ready} from '../helpers.mjs';
import {ExecutorSlices} from '../../dist/server/flow/executor-slices.js';
import {treeHash} from '../../dist/server/workspace.js';
import {ManagedDatasets} from '../../dist/server/managed-data.js';
import {hash} from '../../dist/server/security.js';
import {root} from '../helpers.mjs';
import {DatabaseSync} from 'node:sqlite';
export async function interruptedMerge(t,stage='PARTIAL',options={}){
 const h=options.h??harness(t),{p,s}=await ready(h);
 const created=h.engine.create(p.id,s.hash,true);h.engine.pause(created.id);await h.engine.settled(created.id);
 const r=h.store.run(created.id);r.state=r.phase='IMPLEMENTING';r.tasks=['A','B'].map((task,i)=>({id:task,title:task,status:'pending',dependsOn:[],requirementIds:[s.requirements[0].id],acceptance:['controller fixture only'],writePaths:[i?'b.txt':'a.txt']}));
 fs.mkdirSync(r.workspace,{recursive:true});fs.writeFileSync(resolve(r.workspace,'a.txt'),'a0');fs.writeFileSync(resolve(r.workspace,'b.txt'),'b0');r.treeHash=treeHash(r.workspace);h.store.saveRun(r);
 // Seed data-only canary rows through the original storage writer. No review/admission receipt is manufactured.
 if(options.businessData)new ManagedDatasets(h.store,root).commit(p.id,r.id,r.treeHash,[{id:'saved',title:'合并恢复必须保留的业务内容',done:false}],0,'PREVIEW_EDIT',hash('OFFLINE_RECOVERY_BUSINESS'),'local-session:'+'a'.repeat(64));
 if(options.database){const database=new DatabaseSync(resolve(r.workspace,'business.bin'));try{database.exec("CREATE TABLE important(value TEXT);INSERT INTO important VALUES ('retain actual SQLite data')");}finally{database.close();}r.treeHash=treeHash(r.workspace);h.store.saveRun(r);}
 const canary=resolve(h.dir,'business-canary.txt');fs.writeFileSync(canary,'OFFLINE_BUSINESS_DATA_KEEP');
 const slices=new ExecutorSlices(h.store,h.dir),wave=slices.prepare(r.id);
 for(const a of wave.assignments){const current=h.store.run(r.id);current.tasks=current.tasks.map(task=>task.id===a.taskId?{...task,status:'running'}:task);h.store.saveRun(current);fs.writeFileSync(resolve(a.workspace,a.taskId==='A'?'a.txt':'b.txt'),a.taskId==='A'?'a1':'b1');slices.seal(r.id,a.id);}
 const rename=fs.renameSync,record=h.store.record.bind(h.store);let writes=0;
 fs.renameSync=(from,to)=>{if(resolve(to).startsWith(resolve(r.workspace)+sep)){writes++;if((stage==='UNCHANGED'&&writes===1)||(stage==='PARTIAL'&&writes===2))throw Error('OFFLINE_MERGE_INTERRUPTION');}return rename(from,to);};syncBuiltinESMExports();
 h.store.record=(kind,...args)=>{if(stage==='COMBINED'&&kind==='ExecutorMergeApplied')throw Error('OFFLINE_MERGE_INTERRUPTION');return record(kind,...args);};
 try{assert.throws(()=>slices.merge(r.id,wave.id,new AbortController().signal,()=>{},(run,sourceHash)=>{run.treeHash=sourceHash;}),/OFFLINE_MERGE_INTERRUPTION/);}
 finally{fs.renameSync=rename;syncBuiltinESMExports();h.store.record=record;}
 h.engine.recover();return {h,p,s,run:h.store.run(r.id),slices,wave,canary};
}
