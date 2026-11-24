// Offline form/storage/view contracts, not browser or native model evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { userPlanFromFields,userPlanHome,userPlanEditor } from '../../dist/web/user-plan-view.js';
import { readUserPlan } from '../../dist/server/user-plans.js';
import { DraftStore } from '../../dist/web/dom.js';
import { DreamMakerUI } from '../../dist/web/ui.js';

test('manual plan form preserves requirements and checks without inventing model answers',()=>{
 const fields={projectName:'自己的方案',mode:'live',goal:'制作本地工具',requirements:'保存记录\n重新打开',acceptance:'输入记录后重开仍一致',approach:'本机程序\n本地存储',runtime:'现有电脑',data:'本地文件',steps:'完成输入\n验证保存',use:'在本机打开',accounts:'',fees:'尚未确认'};
 const doc=readUserPlan(userPlanFromFields(k=>fields[k]??'',k=>k==='standalone'));
 assert.deepEqual(doc.plan.requirements.map(r=>r.text),['保存记录','重新打开']);
 assert.ok(doc.plan.requirements.every(r=>r.origin==='USER'&&r.sources[0]==='USER_FORM'));
 assert.deepEqual(doc.plan.tasks[1].dependsOn,['T1']);assert.equal(doc.plan.delivery.needsInternet,false);
 assert.match(doc.plan.unknowns[0],/不代表/);assert.equal(doc.plan.research.status,'USER_IMPORTED_PLAN');
});
test('standalone home and editor escape user input and keep separate import, approval and build',()=>{
 const html=userPlanHome({projects:[{id:'p',name:'<script>bad</script>',idea:'private idea',mode:'live'}],draft:()=>'<img onerror=bad>',mode:'local'});
 assert.doesNotMatch(html,/<script>|<img onerror/);assert.match(html,/&lt;script&gt;/);
 assert.match(html,/id="user-plan-form"/);assert.match(html,/id="user-plan-import"/);
 assert.doesNotMatch(html,/kimiConsent|apiConsent|buildConsent|name="approved"/);
 assert.match(userPlanEditor({},'','<bad>','project-specific'),/data-draft="project-specific"/);
});
test('complete plan draft larger than the old limit survives a storage reload exactly',t=>{
 const previous=globalThis.sessionStorage,values=new Map();
 globalThis.sessionStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 t.after(()=>{if(previous===undefined)delete globalThis.sessionStorage;else globalThis.sessionStorage=previous;});
 const body=JSON.stringify({goal:'完整内容'.repeat(6000)}),draft=new DraftStore('OFFLINE_USER_PLAN',110000);
 draft.set('project-1',body);assert.equal(new DraftStore('OFFLINE_USER_PLAN',110000).get('project-1'),body);
 assert.equal(new DraftStore('other-project',110000).get('project-1'),'');
});
test('submitting typed values retains them while editing is temporarily locked',async t=>{
 const nativeFormData=globalThis.FormData;
 // DOM-free lifecycle seam; the real browser reproduction is recorded separately under W12.
 globalThis.FormData=class {constructor(form){this.values=new Map(Object.entries(form.disabled?{}:form.fields));}get(k){return this.values.get(k)??null;}has(k){return this.values.has(k);}};
 t.after(()=>{globalThis.FormData=nativeFormData;});
 const form={id:'user-plan-form',disabled:false,fields:{projectName:'输入原文',mode:'demo',goal:'保留提交时的中文目标',requirements:'保存输入',acceptance:'重开后原文一致',approach:'本地程序',runtime:'Windows',data:'本地文件',steps:'实现保存',use:'本机打开'}};
 const ui=Object.create(DreamMakerUI.prototype);let submitted,pending;
 Object.assign(ui,{composing:false,epoch:1,v:{busy:false},userPlanBinding:null,drafts:{delete(){}},adapter:{request:async(path,method,body)=>{submitted=body.document;return {project:{id:'OFFLINE_P'},spec:{}};}},
  closeDialog(){},list:async()=>{},open:async()=>{},url(){},toast(){},act(work){form.disabled=true;pending=work();return pending;}});
 ui.submit({preventDefault(){},target:form});await pending;
 assert.equal(readUserPlan(submitted).plan.goal,'保留提交时的中文目标');
 assert.equal(submitted.mode,'demo');assert.equal(form.disabled,true);
});
