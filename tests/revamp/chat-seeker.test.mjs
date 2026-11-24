// Isolated SQLite / local HTTP / synthetic provider boundaries only. No product model or OAuth calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createApp} from '../../dist/server/http.js';
import {Interviews} from '../../dist/server/interview.js';
import {ModelProvider} from '../../dist/server/providers/model.js';
import {chatProjectEditable,chatProjectPresentation,chatReviewFeedbackReady,saveChatProjectPresentation} from '../../dist/server/chat-project.js';
import {hash} from '../../dist/server/security.js';
import {defaults} from '../../dist/server/config.js';
import {harness,root,bindOfflineApi} from '../helpers.mjs';

const question = {topic:'goal',text:'第一版要帮谁解决什么问题？',suggestion:'先从自己的日常场景说起。',prerequisites:[],options:[{id:'a',label:'个人使用'},{id:'b',label:'家人使用'},{id:'c',label:'小团队使用'},{id:'d',label:'公开使用'}],allowMultiple:false,projectTitle:'个人任务助手'};
function live(t,handler){
 const h=harness(t);bindOfflineApi(h.config);let calls=0;
 const model={complete:async payload=>{calls++;return {data:await handler(payload),usage:{role:'planner1',source:'OFFLINE_TEST',requestId:'offline-'+calls,costUsd:null}};}};
 const interviews=new Interviews(h.store,model,h.laya,()=>h.config);t.after(()=>interviews.close());
 return {...h,interviews,calls:()=>calls};
}

test('first question atomically uses the model title without a second naming request',async t=>{
 const h=live(t,p=>{assert.equal(p.task,'question');assert.equal(p.requestProjectTitle,true);return question;});
 const p=h.interviews.create('新项目','想做一个任务助手','live');await h.interviews.next(p.id);
 assert.equal(h.store.project(p.id).name,'个人任务助手');assert.equal(h.calls(),1);
 assert.equal(chatProjectPresentation(h.store,p.id).nameSource,'MODEL');
 assert.equal(h.store.records(p.id,'Question').length,1);
});

test('a user-edited project title is never overwritten by the first model question',async t=>{
 const h=live(t,()=>question),p=h.interviews.create('新项目','一个项目','live');
 saveChatProjectPresentation(h.store,p.id,{version:p.version,name:'新项目'},'OFFLINE_USER');
 await h.interviews.next(p.id);assert.equal(h.store.project(p.id).name,'新项目');
 assert.equal(chatProjectPresentation(h.store,p.id).nameEdited,true);
});

test('pinning while a real model boundary is pending does not invalidate its project input version',async t=>{
 let resolve;const wait=new Promise(r=>{resolve=r;});
 const h=live(t,async()=>{await wait;return question;}),p=h.interviews.create('新项目','一个项目','live');
 const work=h.interviews.next(p.id);await new Promise(r=>setImmediate(r));
 saveChatProjectPresentation(h.store,p.id,{version:p.version,pinned:true},'OFFLINE_USER');
 assert.equal(h.store.project(p.id).version,p.version);resolve();await work;
 assert.equal(h.store.project(p.id).questions.length,1);assert.equal(chatProjectPresentation(h.store,p.id).pinned,true);
});

test('question-help uses the original model boundary and never submits an answer or changes approval',async t=>{
 const payloads=[];const h=live(t,p=>{payloads.push(p);return p.task==='question'?question:{explanation:'这里是指谁会最先使用，先想到一个人即可。'};});
 const p=h.interviews.create('新项目','一个项目','live');await h.interviews.next(p.id);const before=h.store.project(p.id);
 const result=await h.interviews.questionHelp(p.id,before.questions[0].id,'第一批使用者是什么意思？',before.version);
 assert.equal(result.source,'MODEL');assert.equal(result.projectVersion,before.version);assert.equal(payloads.at(-1).task,'question_help');
 assert.deepEqual(h.store.project(p.id),before);assert.equal(h.store.records(p.id,'QuestionHelp').length,1);
 assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM approvals').get().n,0);
});

test('question-help refuses stale, answered and orphan-lease inputs before calling the model',async t=>{
 const h=live(t,()=>question),p=h.interviews.create('测试','一个项目','live');await h.interviews.next(p.id);const current=h.store.project(p.id),qid=current.questions[0].id;
 await assert.rejects(h.interviews.questionHelp(p.id,qid,'解释',current.version-1),{code:'STALE_PROJECT_VERSION'});
 h.store.acquire(p.id,'offline-unsettled');
 assert.equal(chatProjectEditable(h.store,current),false);
 await assert.rejects(h.interviews.questionHelp(p.id,qid,'解释',current.version),{code:'RUN_MUST_STOP_BEFORE_EDIT'});h.store.release(p.id,'offline-unsettled');
 h.interviews.answer(p.id,qid,'个人使用',false,current.version);
 await assert.rejects(h.interviews.questionHelp(p.id,qid,'解释',h.store.project(p.id).version),{code:'CURRENT_QUESTION_REQUIRED'});
 assert.equal(h.calls(),1);assert.equal(h.store.records(p.id,'QuestionHelp').length,0);
});

test('failed help preserves the question, answers and input while recording the original failure',async t=>{
 const h=live(t,p=>{if(p.task==='question')return question;throw Object.assign(Error('synthetic provider error'),{code:'OFFLINE_PROVIDER_FAILURE'});});
 const p=h.interviews.create('测试','一个项目','live');await h.interviews.next(p.id);const before=h.store.project(p.id);
 await assert.rejects(h.interviews.questionHelp(p.id,before.questions[0].id,'解释',before.version),{code:'OFFLINE_PROVIDER_FAILURE'});
 assert.deepEqual(h.store.project(p.id),before);assert.equal(h.store.records(p.id,'QuestionHelp').length,0);
 assert.equal(h.store.records(p.id,'ModelAttemptFailure').at(-1).data.code,'OFFLINE_PROVIDER_FAILURE');
});

test('late help cannot commit after the current question changes',async t=>{
 let resolve;const wait=new Promise(r=>{resolve=r;});
 const h=live(t,async p=>{if(p.task==='question')return question;await wait;return {explanation:'迟到的解释'};});
 const p=h.interviews.create('测试','一个项目','live');await h.interviews.next(p.id);const current=h.store.project(p.id),qid=current.questions[0].id;
 const help=h.interviews.questionHelp(p.id,qid,'解释',current.version);await new Promise(r=>setImmediate(r));
 h.interviews.answer(p.id,qid,'个人使用',false,current.version);resolve();await assert.rejects(help,{code:'MODEL_RESULT_STALE'});
 assert.equal(h.store.records(p.id,'QuestionHelp').length,0);assert.equal(h.store.project(p.id).answers.length,1);
});

test('the original max-call ceiling also stops question-help and never authorizes a different account',async t=>{
 const h=live(t,()=>question);h.config.planner1.maxCallsPerProject=1;
 const p=h.interviews.create('测试','一个项目','live');await h.interviews.next(p.id);const current=h.store.project(p.id);
 await assert.rejects(h.interviews.questionHelp(p.id,current.questions[0].id,'解释',current.version),{code:'INTERVIEW_CALL_BUDGET_EXCEEDED'});
 assert.equal(h.calls(),1);
});

test('project_plan loads the pinned optimizer while question requests retain grilling and both reserve budget',async t=>{
 const config=structuredClone(defaults);bindOfflineApi(config);config.planner1.keyEnv='DM_CHAT_OFFLINE_TEST_KEY';process.env.DM_CHAT_OFFLINE_TEST_KEY='SYNTHETIC_NOT_A_KEY';
 t.after(()=>delete process.env.DM_CHAT_OFFLINE_TEST_KEY);const requests=[];let reserves=0,settles=0;
 const before=readFileSync(join(root,'skills/registry.json'),'utf8');
 const provider=new ModelProvider(()=>config,root,async(_url,init)=>{requests.push(JSON.parse(init.body));return {id:'offline_result',model:config.planner1.model,status:'completed',output:[{content:[{type:'output_text',text:'{}'}]}],usage:{input_tokens:5,output_tokens:2}};},()=>{reserves++;return {settle(){settles++;}};});
 await provider.complete({task:'project_plan'});await provider.complete({task:'question'});
 assert.match(requests[0].instructions,/Prompt compiler guidance/);assert.match(requests[0].instructions,/complete project_plan JSON shape/);
 assert.match(requests[1].instructions,/Dream Maker interview skill/);assert.doesNotMatch(requests[1].instructions,/Prompt compiler guidance/);
 assert.equal(reserves,2);assert.equal(settles,2);assert.equal(readFileSync(join(root,'skills/registry.json'),'utf8'),before);
});

function settledReview(h,p){
 const current=h.store.project(p.id);current.specId='offline-spec';current.activeRunId='offline-run';h.store.saveProject(current);
 const run={id:'offline-run',projectId:p.id,version:1,specId:'offline-spec',specHash:'f'.repeat(64),mode:'live',state:'BLOCKED',phase:'REVIEWING',treeHash:'b'.repeat(64),review:{verdict:'CHANGES_REQUESTED',findings:[],source:'INDEPENDENT_API',treeHash:'b'.repeat(64)},verification:null,calls:3,maxCalls:13,reason:'OFFLINE_ONLY'};
 h.store.insertRun(run);return {project:h.store.project(p.id),run};
}

test('Reviewer feedback is source-bound, budgeted once, cached and does not accept or resume a run',async t=>{
 const h=live(t,p=>{assert.equal(p.task,'review_feedback');return {summary:'需要调整一项需求。',blockers:['导出格式未确认'],options:['选择一种导出格式'],question:'你希望导出成什么格式？',needsConfirmation:true};});
 const p=h.interviews.create('测试','一个项目','live'),x=settledReview(h,p),before=structuredClone(x.run);
 const a=await h.interviews.reviewFeedback(p.id,x.run.id,x.project.version),b=await h.interviews.reviewFeedback(p.id,x.run.id,x.project.version);
 assert.deepEqual(a,b);assert.equal(h.calls(),1);assert.equal(a.reviewHash,hash(x.run.review));
 assert.equal(h.store.records(p.id,'SeekerReviewFeedback').length,1);assert.deepEqual(h.store.run(x.run.id),before);
 assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM approvals').get().n,0);
});

test('Reviewer feedback refuses missing, mismatched or still-leased review evidence before dispatch',async t=>{
 const h=live(t,()=>{throw Error('must not dispatch');}),p=h.interviews.create('测试','一个项目','live'),x=settledReview(h,p);
 h.store.acquire(p.id,x.run.id);await assert.rejects(h.interviews.reviewFeedback(p.id,x.run.id,x.project.version),{code:'FLOW_TERMINATION_REQUIRED'});h.store.release(p.id,x.run.id);
 let run=h.store.run(x.run.id);run.review.treeHash='c'.repeat(64);h.store.saveRun(run);
 await assert.rejects(h.interviews.reviewFeedback(p.id,x.run.id,x.project.version),{code:'REVIEW_ROLE_EVIDENCE_REQUIRED'});
 run=h.store.run(x.run.id);run.review=null;h.store.saveRun(run);
 await assert.rejects(h.interviews.reviewFeedback(p.id,x.run.id,x.project.version),{code:'REVIEW_ROLE_EVIDENCE_REQUIRED'});assert.equal(h.calls(),0);
});

test('a ready-for-delivery review can be explained before conclusion while answer edits stay locked',async t=>{
 const h=live(t,()=>({summary:'本轮审查通过，等待你查看。',blockers:[],options:['查看成果'],question:'是否满足你的需要？',needsConfirmation:true}));
 const p=h.interviews.create('测试','一个项目','live'),x=settledReview(h,p),r=h.store.run(x.run.id);r.state='READY_FOR_DELIVERY';h.store.saveRun(r);
 assert.equal(chatProjectEditable(h.store,x.project),false);assert.equal(chatReviewFeedbackReady(h.store,x.project,h.store.run(r.id)),true);
 const result=await h.interviews.reviewFeedback(p.id,r.id,x.project.version);assert.equal(result.needsConfirmation,true);
 assert.equal(h.store.run(r.id).state,'READY_FOR_DELIVERY');assert.equal(h.store.run(r.id).flowConclusion,undefined);assert.equal(h.calls(),1);
});

test('rename/archive cannot hide a leased project; pin remains metadata and restores without deleting records',async t=>{
 const h=harness(t),p=h.interviews.create('原名称','一个项目','demo');h.store.acquire(p.id,'offline-lease');
 assert.throws(()=>saveChatProjectPresentation(h.store,p.id,{version:p.version,name:'新名称'},'OFFLINE'),{code:'RUN_MUST_STOP_BEFORE_EDIT'});
 assert.throws(()=>saveChatProjectPresentation(h.store,p.id,{version:p.version,archived:true},'OFFLINE'),{code:'RUN_MUST_STOP_BEFORE_EDIT'});
 saveChatProjectPresentation(h.store,p.id,{version:p.version,pinned:true},'OFFLINE');assert.equal(h.store.project(p.id).version,p.version);h.store.release(p.id,'offline-lease');
 saveChatProjectPresentation(h.store,p.id,{version:p.version,archived:true},'OFFLINE');saveChatProjectPresentation(h.store,p.id,{version:p.version,archived:false},'OFFLINE');
 assert.equal(h.store.projects().length,1);assert.equal(chatProjectPresentation(h.store,p.id).archived,false);assert.equal(h.store.records(p.id,'ChatProjectPresentation').length,3);
});

async function httpFixture(t,product='dream-maker'){
 const parent=join(root,'.runtime/test-temp');mkdirSync(parent,{recursive:true});const data=mkdtempSync(join(parent,'chat-http-'));writeFileSync(join(data,'config.json'),JSON.stringify(defaults));
 const app=await createApp({root,data,configPath:join(data,'config.json'),product,port:0});t.after(async()=>{await app.close();rmSync(data,{recursive:true,force:true});});
 const login=await fetch(app.origin+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrap:app.bootstrap})}),cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 const request=async(path,body,overrides={})=>{const headers={cookie,...(body===undefined?{}:{'content-type':'application/json','x-csrf-token':csrf,'idempotency-key':crypto.randomUUID()}),...overrides};const response=await fetch(app.origin+'/api'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 return {app,request};
}

test('local HTTP exposes real chat metadata, keeps CSRF, versions and help idempotency',async t=>{
 const h=await httpFixture(t);assert.equal((await h.request('/chat/capabilities')).body.questionHelp,true);
 let s=(await h.request('/projects',{name:'新项目',idea:'想制作学习记录工具',mode:'demo'})).body;
 s=(await h.request('/projects/'+s.project.id+'/next',{})).body;const pid=s.project.id,version=s.project.version,qid=s.project.questions[0].id;
 assert.equal(s.chat.editable,true);assert.equal(s.chat.presentation.nameSource,'DEMO_RULES');
 const input={questionId:qid,text:'我不理解这个问题',version},key=crypto.randomUUID();
 assert.equal((await h.request('/projects/'+pid+'/question-help',input,{'x-csrf-token':'wrong'})).status,403);
 const a=await h.request('/projects/'+pid+'/question-help',input,{'idempotency-key':key}),b=await h.request('/projects/'+pid+'/question-help',input,{'idempotency-key':key});
 assert.equal(a.status,200);assert.deepEqual(a,b);assert.equal(h.app.store.records(pid,'QuestionHelp').length,1);assert.equal(h.app.store.project(pid).answers.length,0);
 const renamed=await h.request('/projects/'+pid+'/presentation',{version,name:'我的学习工具',pinned:true});assert.equal(renamed.status,200);assert.equal(renamed.body.project.name,'我的学习工具');
 assert.equal((await h.request('/projects/'+pid+'/presentation',{version,name:'过期名字'})).status,409);
 const list=await h.request('/chat/projects');assert.equal(list.body.projects[0].presentation.pinned,true);assert.equal(list.body.projects[0].name,'我的学习工具');
});

test('standalone DF denies question help and review feedback without creating a Seeker session',async t=>{
 const h=await httpFixture(t,'dreamflow'),caps=(await h.request('/chat/capabilities')).body;
 assert.equal(caps.seeker,false);assert.equal(caps.questionHelp,false);assert.equal(caps.reviewFeedback,false);
 const help=await h.request('/projects/unknown/question-help',{questionId:'q',text:'解释',version:1});assert.equal(help.status,409);assert.equal(help.body.error,'USER_PLANNER_REQUIRED');
 const review=await h.request('/projects/unknown/review-feedback',{runId:'r',version:1});assert.equal(review.status,409);assert.equal(review.body.error,'USER_PLANNER_REQUIRED');assert.equal(h.app.store.projects().length,0);
});

for(const product of ['dream-maker','dreamflow'])test(product+' serves the new compiled entry and assets through the original static allowlist',async t=>{
 const h=await httpFixture(t,product);
 const page=await fetch(h.app.origin+'/');assert.equal(page.status,200);
 const html=await page.text();assert.match(html,/src="\/chat-entry.js"/);assert.match(html,/href="\/chat-shell.css"/);
 for(const name of ['chat-entry.js','chat-controller.js','chat-projection.js','chat-types.js','chat-shell.js','chat-shell.css','contracts.js','local-api.js','dom.js']){
  const response=await fetch(h.app.origin+'/'+name);assert.equal(response.status,200,name);
  assert.match(response.headers.get('content-type'),name.endsWith('.js')?/text\/javascript/:name.endsWith('.css')?/text\/css/:/text\/html/);
  assert.ok((await response.text()).length>0,name);
 }
 // The demo/preview entry is a development artifact: its files exist in the build, but the official
 // service never serves them. The offline preview is produced only by scripts/build-chat-preview.mjs
 // from the same view modules, so a page cannot reach a demo entry by guessing a URL.
 for(const name of ['chat-preview.html','chat-preview.js','chat-demo.js'])assert.equal((await fetch(h.app.origin+'/'+name)).status,404,name);
 assert.equal((await fetch(h.app.origin+'/server/http.js')).status,404);
 assert.equal(h.app.store.projects().length,0);
});
