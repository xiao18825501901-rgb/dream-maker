/** Bounded fixed-Demo data only; this contract grants no file, model or execution capability. */
export interface DemoTask {id:string;title:string;done:boolean}
export function checkedDemoTasks(value:unknown):DemoTask[]{
 if(!Array.isArray(value)||value.length>200)throw Error('PREVIEW_TASK_LIMIT');
 const ids=new Set<string>();
 return value.map(v=>{
  if(!v||typeof v!=='object'||Object.keys(v).some(key=>!['id','title','done'].includes(key))||typeof v.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(v.id)||ids.has(v.id)||typeof v.title!=='string'||!v.title.trim()||v.title.length>120||typeof v.done!=='boolean')throw Error('PREVIEW_TASK_INVALID');
  ids.add(v.id);return {id:v.id,title:v.title,done:v.done};
 });
}
