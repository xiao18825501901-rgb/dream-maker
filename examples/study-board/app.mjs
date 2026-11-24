import { add, toggle, remove, stats, restore } from './board.mjs';
const key = 'dream-maker-study-board:' + location.pathname.replace(/index\.html$/, '');
let tasks = [],revision=null,busy=false,blocked=false;
const error = document.querySelector('#error');
const query=new URLSearchParams(location.search),parentOrigin=query.get('dm_parent'),channel=query.get('dm_channel');
const framed=parent!==window;
const managed=framed&&query.get('dm_data')==='2';
document.querySelector('#storage-scope').textContent=managed?'固定样例 · 任务数据保存在本机 Dream Maker 项目中':'固定样例 · 数据保存在当前浏览器';
document.querySelector('#storage-help').textContent=managed?'任务数据与源码分开保存。请在 Dream Maker 的“数据与维护”建立副本。':'浏览器清理站点数据会移除本浏览器任务；旧成果可在 Dream Maker 明确迁移数据。';
const pending=new Map();
function uuid(){const b=crypto.getRandomValues(new Uint8Array(16));return [...b].map(n=>n.toString(16).padStart(2,'0')).join('');}
function request(op,value){
    if(!parentOrigin||!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(parentOrigin)||!channel) return Promise.reject(Error('PREVIEW_STORAGE_SCOPE_DENIED'));
    const requestId=uuid();
    return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('PREVIEW_STORAGE_TIMEOUT'));},5000);
        pending.set(requestId,{resolve,reject,timer});
        parent.postMessage({type:managed?'dm-preview-data':'dm-preview-storage',version:managed?2:1,channel,requestId,op,...(op==='write'?{tasks:value,...(managed?{revision}:{})}:{})},parentOrigin);
    });
}
window.addEventListener('message',event=>{
    const d=event.data;
    if(event.source!==parent||event.origin!==parentOrigin||!d||d.type!==(managed?'dm-preview-data-result':'dm-preview-storage-result')||d.version!==(managed?2:1)||d.channel!==channel) return;
    const job=pending.get(d.requestId);if(!job)return;
    clearTimeout(job.timer);pending.delete(d.requestId);
    if(d.error)job.reject(Error(d.error));else if(!Array.isArray(d.tasks)||managed&&(!Number.isSafeInteger(d.revision)||d.revision<0))job.reject(Error('PREVIEW_INVALID_DATA'));else job.resolve({tasks:d.tasks,revision:d.revision});
});
function controls(){
    for(const input of document.querySelectorAll('#title,#add-task,#tasks input,#tasks button'))input.disabled=busy||blocked;
    document.querySelector('#recovery').hidden=!blocked;
    document.querySelector('#reload-tasks').disabled=busy||!document.querySelector('#reload-consent').checked;
}
async function load(){busy=true;controls();try{
    if(framed){const data=await request('read');tasks=restore(JSON.stringify(data.tasks));revision=managed?data.revision:null;}
    else tasks=restore(localStorage.getItem(key));
    blocked=false;error.textContent='';document.querySelector('#reload-consent').checked=false;
}catch{blocked=true;error.textContent='未能核对保存状态。已有页面内容保留，暂不接受新修改；可复制留存后再明确读取保存版本。';}
finally{busy=false;render();}}
async function save(next){
    if(busy||blocked)return false;tasks=next;busy=true;render();
    try{
        if(framed){const data=await request('write',tasks);tasks=restore(JSON.stringify(data.tasks));if(managed)revision=data.revision;}
        else localStorage.setItem(key,JSON.stringify(tasks));
        error.textContent='';return true;
    }catch{blocked=true;error.textContent='保存结果尚未确认，可能有另一页面改动。你的页面内容保留，未自动重试；先复制留存或核对，再选择读取已保存版本。';return false;}
    finally{busy=false;render();}
}
function render() {
    const box = document.querySelector('#tasks');
    box.replaceChildren();
    const filter = document.querySelector('#filter').value;
    for (const task of tasks.filter(t => filter === 'all' || (filter === 'done' ? t.done : !t.done))) {
        const li = document.createElement('li'), check = document.createElement('input'), label = document.createElement('span'), del = document.createElement('button');
        check.type = 'checkbox';
        check.checked = task.done;
        check.setAttribute('aria-label', '完成 ' + task.title);
        check.addEventListener('change', () => { void save(toggle(tasks, task.id)); });
        label.textContent = task.title;
        if (task.done)
            label.className = 'done';
        del.textContent = '删除';
        del.className = 'quiet';
        del.addEventListener('click', () => { void save(remove(tasks, task.id)); });
        li.append(check, label, del);
        box.append(li);
    }
    const s = stats(tasks);
    document.querySelector('#stats').textContent = `${s.done} / ${s.total} 已完成`;
    document.querySelector('#empty').hidden = box.children.length > 0;
    controls();
}
async function submit(){ if(busy||blocked)return;const input = document.querySelector('#title'); try {
    if(tasks.length>=200)throw Error('PREVIEW_TASK_LIMIT');
    const next=add(tasks, input.value, uuid());
    if(await save(next))input.value = '';
}
catch {
    error.textContent = '请输入 1–120 字的任务，最多保存 200 项。';
} }
document.querySelector('#add-task').addEventListener('click',submit);
document.querySelector('#title').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229){event.preventDefault();submit();}});
document.querySelector('#filter').addEventListener('change', render);
document.querySelector('#reload-consent').addEventListener('change',controls);
document.querySelector('#reload-tasks').addEventListener('click',()=>{if(!busy&&document.querySelector('#reload-consent').checked)void load();});
document.querySelector('#export-tasks').addEventListener('click',()=>{
    const field=document.querySelector('#task-copy');document.querySelector('#task-copy-label').hidden=false;field.hidden=false;field.value=JSON.stringify(tasks,null,2);field.focus();field.select();
});
void load();
