// Pure UI projections of synthetic evidence. These checks do not claim a real role run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {currentQuestion,currentRun,starsFor,messagesFor,reviewFeedbackRecord,rolesFor,seekerApiSelected} from '../../dist/web/chat-projection.js';

const at='2026-11-21T00:00:00.000Z';
function snapshot(){
 const spec={id:'s',hash:'f'.repeat(64),revision:1,stale:false,requirements:[{id:'R1',text:'记录任务',sourceAnswerIds:['a1']}]};
 const run={id:'r',projectId:'p',mode:'live',version:3,specId:'s',specHash:spec.hash,flowName:'classic',state:'READY_FOR_DELIVERY',phase:'READY_FOR_DELIVERY',treeHash:'b'.repeat(64),prework:{contractId:'prework-test'},tasks:[{id:'T1',title:'制作记录',requirementIds:['R1'],dependsOn:[],status:'done'}],verification:{ok:true,treeHash:'b'.repeat(64),evidenceId:'v'},review:{verdict:'PASS',findings:[],source:'CODEX',treeHash:'b'.repeat(64)}};
 const project={id:'p',name:'合成项目',idea:'任务记录',mode:'live',version:4,state:'READY_TO_BUILD',activeRunId:'r',specId:'s',questions:[{id:'q1',text:'谁会使用？',createdAt:at}],answers:[{id:'a1',questionId:'q1',text:'我自己',revision:1,createdAt:at}],createdAt:at};
 return {project,spec,runs:[run],records:[],chat:{editable:false,reviewFeedbackReady:true,reviewFeedbackBinding:{runId:'r',runVersion:3,specHash:spec.hash,reviewHash:'c'.repeat(64),projectVersion:4},preworkCloseout:{contractId:'prework-test',treeHash:run.treeHash,coverageReached:true,requirementIds:['R1']}}};
}
function feedback(s){return {id:'fb',kind:'SeekerReviewFeedback',runId:'r',at,data:{...s.chat.reviewFeedbackBinding,source:'MODEL',feedback:{summary:'本轮已核对',blockers:[],options:['查看成果'],question:'还需调整吗？'}}};}

test('stars require real closeout coverage and done tasks bound to the current source',()=>{
 const s=snapshot();assert.equal(starsFor(s)[0].status,'done');assert.match(starsFor(s)[0].evidenceLabel,/待用户接受/);
 for(const mutate of [v=>v.chat.preworkCloseout=null,v=>v.chat.preworkCloseout.treeHash='old',v=>v.chat.preworkCloseout.contractId='other',v=>v.chat.preworkCloseout.requirementIds=[],v=>v.runs[0].tasks[0].status='implemented',v=>v.runs[0].verification.treeHash='old']){
  const changed=structuredClone(s);mutate(changed);assert.notEqual(starsFor(changed)[0].status,'done');
 }
});

test('a PASS review followed by failed Prework closeout remains blocked, never complete',()=>{
 const s=snapshot();s.runs[0].state='BLOCKED';s.runs[0].reason='PREWORK_REVIEW_COVERAGE_REQUIRED';s.runs[0].tasks[0].status='implemented';s.chat.preworkCloseout=null;
 const star=starsFor(s)[0];assert.equal(star.status,'blocked');assert.match(star.evidenceLabel,/PREWORK_REVIEW_COVERAGE_REQUIRED/);
});

test('edited answer ids never borrow completion evidence belonging to a historical answer',()=>{
 const s=snapshot();s.project.answers[0]={...s.project.answers[0],id:'a2',revision:2,text:'小团队'};
 const star=starsFor(s)[0];assert.equal(star.status,'changed');assert.deepEqual(star.requirementIds,[]);
 s.spec.stale=true;assert.equal(currentRun(s),null);assert.notEqual(starsFor(s)[0].status,'done');
});

test('the current question is rendered only by its card while answered questions stay in history',()=>{
 const s=snapshot();s.project.state='INTERVIEWING';s.project.questions.push({id:'q2',text:'希望怎样提醒？',createdAt:at});s.spec=null;s.runs=[];
 assert.equal(currentQuestion(s).id,'q2');const dm=messagesFor(s,'dm');assert.equal(dm.filter(x=>x.id==='q1').length,1);assert.equal(dm.filter(x=>x.id==='q2').length,0);
 assert.equal(messagesFor(s,'df').some(x=>x.role==='seeker'),false);
 s.project.state='SPEC_REVIEW';assert.equal(currentQuestion(s),null);
});

test('feedback requires every exact binding and can be read beyond the recent-record window',()=>{
 const s=snapshot(),record=feedback(s);s.chat.reviewFeedback=record;assert.equal(reviewFeedbackRecord(s).id,'fb');
 assert.equal(messagesFor(s,'dm').filter(x=>x.title==='本轮结果与下一步').length,1);
 for(const key of ['runId','runVersion','specHash','reviewHash','projectVersion']){
  const old=structuredClone(s);old.chat.reviewFeedback=null;old.records=[structuredClone(record)];old.records[0].data[key]=typeof record.data[key]==='number'?record.data[key]-1:'old';
  assert.equal(reviewFeedbackRecord(old),null);assert.equal(messagesFor(old,'dm').some(x=>x.title==='本轮结果与下一步'),false);
 }
});

test('the Seeker picker projects the fetched catalog and switches provider without losing the binding',()=>{
 const config={config:{planner1:{provider:'deepseek',model:'deepseek-flash'},codex:{model:'synthetic-codex'},dsh:{model:'synthetic-executor'},laya:{mode:'off'}},planner1Binding:{provider:'deepseek',model:'deepseek-flash',authMethod:'api_key',bindingVersion:4}};
 const catalogs=new Map([['deepseek',[{id:'deepseek-flash',label:'DeepSeek V4.1 Flash',available:true},{id:'deepseek-v4-pro',label:'DeepSeek V4 Pro',available:true}]],['openai',[{id:'gpt-6-luna',label:'GPT-6 Luna',available:true}]]]);
 const deep=rolesFor(config,null,null,catalogs);
 assert.equal(deep.seeker.modelEditable,false);assert.equal(deep.seeker.model,'deepseek-flash');assert.deepEqual(deep.seeker.models.map(x=>x.id),['deepseek-flash','deepseek-v4-pro']);
 const open={...config,planner1Binding:{...config.planner1Binding,provider:'openai',model:'gpt-6-luna'}},openRoles=rolesFor(open,null,null,catalogs);
 assert.deepEqual(openRoles.seeker.models.map(x=>x.id),['gpt-6-luna']);
 const outside={...open,planner1Binding:{...open.planner1Binding,model:'unlisted-current'}},outsideRoles=rolesFor(outside,null,null,catalogs);
 assert.deepEqual(outsideRoles.seeker.models.map(x=>x.id),['gpt-6-luna','unlisted-current']);
 assert.equal(seekerApiSelected(config),true);assert.equal(seekerApiSelected(open),true);
 // A legacy version-2 or version-3 binding still opens old projects, but it is not the seeker_api route,
 // so it must not start a new Live project from the workbench.
 assert.equal(seekerApiSelected({...config,planner1Binding:{...config.planner1Binding,bindingVersion:2}}),false);
 assert.equal(seekerApiSelected({...config,planner1Binding:{...config.planner1Binding,bindingVersion:3}}),false);
 assert.equal(seekerApiSelected({...config,planner1Binding:{...config.planner1Binding,bindingVersion:1}}),false);
 assert.equal(seekerApiSelected({...config,planner1Retired:true}),false);
 assert.equal(seekerApiSelected(null),false);
});

test('DF keeps engineering messages while excluding Seeker feedback and all interview messages',()=>{
 const s=snapshot();s.chat.reviewFeedback=feedback(s);const messages=messagesFor(s,'df');
 assert.equal(messages.some(x=>x.role==='seeker'),false);assert.equal(messages.some(x=>x.role==='planner'),true);assert.equal(messages.some(x=>x.role==='executor'),true);assert.equal(messages.some(x=>x.role==='reviewer'),true);
});
