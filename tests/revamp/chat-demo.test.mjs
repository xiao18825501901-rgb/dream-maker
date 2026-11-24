// The offline preview state machine only. These checks are not product/role evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatDemoController} from '../../dist/web/chat-demo.js';

test('the offline demo can complete a review-to-Seeker second confirmation without becoming disabled',async t=>{
 const d=createChatDemoController(()=>{});t.after(()=>d.destroy());
 await d.controller.dispatch({type:'end-interview'});
 let s=d.getState();
 await d.controller.dispatch({type:'requirements-confirm',text:s.requirements.text,expectedRevision:s.requirements.revision});
 s=d.getState();const q=s.questions.find(q=>q.answer);
 await assert.rejects(d.controller.dispatch({type:'answer-edit',questionId:q.id,answer:'不能写进执行中的方案',expectedRevision:q.revision}));
 for(let i=0;i<6;i++)await d.controller.dispatch({type:'demo-step'});
 assert.equal(d.getState().phase,'review_feedback');
 await d.controller.dispatch({type:'review-followup',text:'下一版先实现可恢复的本地备份。'});
 s=d.getState();assert.equal(s.phase,'awaiting_confirmation');assert.equal(s.capabilities.confirm,true);assert.equal(s.capabilities.cancel,false);assert.equal(s.locked,false);
 await d.controller.dispatch({type:'requirements-confirm',text:s.requirements.text,expectedRevision:s.requirements.revision});
 assert.equal(d.getState().phase,'flow');assert.equal(d.getState().evidence,'demo');
});
test('archive and restore keep the same demo project and its answered questions',async t=>{
 const d=createChatDemoController(()=>{});t.after(()=>d.destroy());const before=d.getState();
 await d.controller.dispatch({type:'project-archive',id:before.projectId});
 assert.equal(d.getState().projects.find(p=>p.id===before.projectId).archived,true);
 await d.controller.dispatch({type:'project-restore',id:before.projectId});
 await d.controller.dispatch({type:'project-select',id:before.projectId});
 const after=d.getState();assert.equal(after.projectId,before.projectId);assert.deepEqual(after.questions,before.questions);assert.equal(after.projects.find(p=>p.id===before.projectId).archived,false);
});
test('independent DF preview contains no Seeker messages or question stars',t=>{
 const d=createChatDemoController(()=>{},'df');t.after(()=>d.destroy());const s=d.getState();
 assert.equal(s.product,'df');assert.equal(s.questions.length,0);assert.equal(s.activeQuestionId,null);assert.equal(s.messages.some(m=>m.role==='seeker'),false);
});
test('demo option ids preserve one copy of source labels and keep free text separate',async t=>{
 const d=createChatDemoController(()=>{});t.after(()=>d.destroy());let s=d.getState(),q=s.questions.find(q=>q.id===s.activeQuestionId);
 await assert.rejects(d.controller.dispatch({type:'answer-submit',questionId:q.id,choiceIds:['A','B'],answer:''}));
 await d.controller.dispatch({type:'answer-submit',questionId:q.id,choiceIds:['A'],answer:''});
 assert.equal(d.getState().questions.find(x=>x.id===q.id).answer,'只保存在这台电脑');
 s=d.getState();q=s.questions.find(q=>q.id===s.activeQuestionId);assert.equal(q.allowMultiple,true);
 await d.controller.dispatch({type:'answer-submit',questionId:q.id,choiceIds:['A','C'],answer:'希望每天都能放心使用。'});
 assert.equal(d.getState().questions.find(x=>x.id===q.id).answer,'每天都能轻松添加笔记\n数据安全，不怕弄丢\n希望每天都能放心使用。');
});
