/* Fixed demo; no network, storage, or agent calls. Runs within an opaque-origin sandbox. */
const list=document.getElementById('tasks'),input=document.getElementById('task-input'),status=document.getElementById('sample-status');
function add(text){const li=document.createElement('li'),label=document.createElement('label'),check=document.createElement('input'),span=document.createElement('span'),remove=document.createElement('button');check.type='checkbox';span.textContent=text;remove.type='button';remove.textContent='删除';remove.setAttribute('aria-label','删除 '+text);label.append(check,span);li.append(label,remove);list.append(li);remove.addEventListener('click',()=>{li.remove();status.textContent='已从固定样例中删除一项。';});check.addEventListener('change',()=>{status.textContent=check.checked?'已标记完成。':'已恢复为未完成。';});}
['读一篇论文，记下一个问题','整理本周的课程笔记'].forEach(add);
function submitTask(){if(!input.value.trim())return;add(input.value.trim());input.value='';input.focus();status.textContent='已添加到固定样例；刷新后重置。';}
document.getElementById('add-task').addEventListener('click',submitTask);
input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229){event.preventDefault();submitTask();}});
