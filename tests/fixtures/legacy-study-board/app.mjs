import { add, toggle, remove, stats, restore } from './board.mjs';
const key = 'dream-maker-study-board:' + location.pathname.replace(/index\.html$/, '');
let tasks = [];
const error = document.querySelector('#error');
const query=new URLSearchParams(location.search),parentOrigin=query.get('dm_parent'),channel=query.get('dm_channel');
const framed=parent!==window;
const pending=new Map();
function uuid(){const b=crypto.getRandomValues(new Uint8Array(16));return [...b].map(n=>n.toString(16).padStart(2,'0')).join('');}
function request(op,value){
    if(!parentOrigin||!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(parentOrigin)||!channel) return Promise.reject(Error('PREVIEW_STORAGE_SCOPE_DENIED'));
    const requestId=uuid();
    return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('PREVIEW_STORAGE_TIMEOUT'));},3000);
        pending.set(requestId,{resolve,reject,timer});
        parent.postMessage({type:'dm-preview-storage',version:1,channel,requestId,op,...(op==='write'?{tasks:value}:{})},parentOrigin);
    });
}
window.addEventListener('message',event=>{
    const d=event.data;
    if(event.source!==parent||event.origin!==parentOrigin||!d||d.type!=='dm-preview-storage-result'||d.version!==1||d.channel!==channel) return;
    const job=pending.get(d.requestId);if(!job)return;
    clearTimeout(job.timer);pending.delete(d.requestId);
    if(d.error)job.reject(Error(d.error));else job.resolve(d.tasks);
});
async function load(){try{
    tasks=framed?restore(JSON.stringify(await request('read'))):restore(localStorage.getItem(key));
}catch{error.textContent='当前浏览器禁止保存数据；本次仅保留内存状态。';}render();}
function save(){
    if(framed){void request('write',tasks).catch(()=>{error.textContent='无法保存任务数据，请检查本地预览连接。';});return;}
    try{localStorage.setItem(key,JSON.stringify(tasks));}catch{error.textContent='无法保存数据，请检查浏览器存储权限。';}
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
        check.addEventListener('change', () => { tasks = toggle(tasks, task.id); save(); render(); });
        label.textContent = task.title;
        if (task.done)
            label.className = 'done';
        del.textContent = '删除';
        del.className = 'quiet';
        del.addEventListener('click', () => { tasks = remove(tasks, task.id); save(); render(); });
        li.append(check, label, del);
        box.append(li);
    }
    const s = stats(tasks);
    document.querySelector('#stats').textContent = `${s.done} / ${s.total} 已完成`;
    document.querySelector('#empty').hidden = box.children.length > 0;
}
function submit(){ const input = document.querySelector('#title'); try {
    if(tasks.length>=200)throw Error('PREVIEW_TASK_LIMIT');
    tasks = add(tasks, input.value, uuid());
    input.value = '';
    save();
    render();
}
catch {
    error.textContent = '请输入 1–120 字的任务，最多保存 200 项。';
} }
document.querySelector('#add-task').addEventListener('click',submit);
document.querySelector('#title').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229){event.preventDefault();submit();}});
document.querySelector('#filter').addEventListener('change', render);
void load();
