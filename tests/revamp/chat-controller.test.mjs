// Browser controller behavior against an in-memory adapter. No model, OAuth or network requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatLiveController} from '../../dist/web/chat-controller.js';
import {UiError} from '../../dist/web/contracts.js';
import {requirementText} from '../../dist/web/chat-projection.js';

const clone=structuredClone;
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const at='2026-11-21T00:00:00.000Z';
function snapshot(id='p'){
 return {project:{id,name:'合成项目',idea:'制作一个任务记录工具',mode:'live',version:1,state:'INTERVIEWING',questions:[{id:'q1',topic:'goal',text:'谁会先使用？',options:[{id:'a',label:'自己'}],createdAt:at}],answers:[],answerHistory:[],specId:null,activeRunId:null,createdAt:at,updatedAt:at},spec:null,runs:[],records:[],chat:{editable:true,reviewFeedbackReady:false,presentation:{pinned:false,archived:false,revision:0,nameEdited:false}}};
}
function withSpec(s){s.spec={id:'spec-'+s.project.id,hash:'f'.repeat(64),revision:1,stale:false,brief:'任务记录工具',requirements:[{id:'R1',text:'记录任务',sourceAnswerIds:['a1']}],acceptance:['能记录一项任务'],constraints:[],assumptions:[],outOfScope:[],conflicts:[]};s.project.specId=s.spec.id;s.project.state='SPEC_REVIEW';return s;}
function withRun(s,state='PLANNING',flowName='classic'){
 withSpec(s);const r={id:'run-'+s.project.id,projectId:s.project.id,mode:'live',version:1,specId:s.spec.id,specHash:s.spec.hash,state,phase:state,flowName,treeHash:'b'.repeat(64),tasks:[],review:null,verification:null,reason:null,createdAt:at,updatedAt:at};
 s.runs=[r];s.project.activeRunId=r.id;s.project.state='READY_TO_BUILD';s.chat.editable=false;return s;
}
function ready(s){
 withRun(s,'READY_FOR_DELIVERY');s.runs[0].review={verdict:'PASS',findings:[],source:'CODEX',treeHash:s.runs[0].treeHash};s.chat.reviewFeedbackReady=true;
 s.chat.reviewFeedbackBinding={runId:s.runs[0].id,runVersion:s.runs[0].version,specHash:s.spec.hash,reviewHash:'c'.repeat(64),projectVersion:s.project.version};return s;
}
function feedback(s,text='本轮审查已交回。'){
 return {id:'feedback-'+s.runs[0].version,kind:'SeekerReviewFeedback',runId:s.runs[0].id,at,data:{...s.chat.reviewFeedbackBinding,source:'MODEL',feedback:{summary:text,blockers:[],options:['查看成果'],question:'是否需要调整？',needsConfirmation:true}}};
}
async function fixture(t,s=snapshot(),{product='dream-maker',explain=false,profiles={},bindingVersion=2}={}){
 const loc={pathname:'/',search:'?project='+s.project.id,hash:''};
 const oldLocation=Object.getOwnPropertyDescriptor(globalThis,'location'),oldHistory=Object.getOwnPropertyDescriptor(globalThis,'history');
 Object.defineProperty(globalThis,'location',{configurable:true,value:loc});
 Object.defineProperty(globalThis,'history',{configurable:true,value:{replaceState(_a,_b,value){const url=new URL(value,'http://offline.invalid');loc.pathname=url.pathname;loc.search=url.search;}}});
 const states=new Map([[s.project.id,clone(s)]]),calls=[],readQueue=[],posts=new Map(),reads=new Map(),listeners=new Map(),nav=[];
 const config={config:{planner1:{provider:'deepseek',model:'synthetic-seeker'},codex:{model:'synthetic-codex'},dsh:{model:'synthetic-executor'},laya:{mode:'advisory'}},planner1Binding:{provider:'deepseek',model:'synthetic-seeker',authMethod:'api_key',bindingVersion}};
 const catalogs={deepseek:[{id:'deepseek-flash',label:'DeepSeek V4.1 Flash',context:1048576,output:8192,notes:'synthetic',available:true},{id:'deepseek-v4-pro',label:'DeepSeek V4 Pro',context:null,output:null,notes:'synthetic',available:true}],openai:[{id:'gpt-6-luna',label:'GPT-6 Luna',context:272000,output:null,notes:'synthetic',available:true}]};
 const adapter={mode:'local',async init(){},async request(path,method='GET',body){
  calls.push({path,method,body:clone(body)});
  if(method!=='GET'){const handler=posts.get(path);assert.ok(handler,'unexpected synthetic mutation '+path);return clone(await handler(body));}
  if(reads.has(path))return clone(await reads.get(path)());
  if(path==='/product')return {product};if(path==='/config')return clone(config);
  const catalogPath=path.match(/^\/planner1\/models\?provider=([^&]+)$/);
  if(catalogPath){const provider=decodeURIComponent(catalogPath[1]);return {schema:'dream-maker.planner1-models.v1',provider,source:'classic',models:clone(catalogs[provider]??[])};}
  if(path==='/chat/capabilities')return {schema:'dream-maker.chat-capabilities.v1',version:1,product,seeker:product!=='dreamflow',questionHelp:product!=='dreamflow',reviewFeedback:explain,projectPresentation:true};
  if(path==='/chat/projects')return {projects:[...states.values()].map(v=>({...clone(v.project),presentation:v.chat.presentation}))};
  const profile=path.match(/^\/projects\/([^/]+)\/flow-profile$/);if(profile)return {current:clone(profiles[profile[1]]??null),executionGranted:false};
  const project=path.match(/^\/projects\/([^/]+)$/);if(project){if(readQueue.length)return clone(await readQueue.shift()());return clone(states.get(project[1]));}
  assert.fail('unexpected synthetic read '+path);
 },subscribe(pid,onEvent,onState){listeners.set(pid,{onEvent,onState});return ()=>listeners.delete(pid);},dispose(){listeners.clear();},async exportRun(){throw Error('not used');}};
 const controller=new ChatLiveController(()=>{},adapter,url=>nav.push(url));
 t.after(()=>{controller.dispose();if(oldLocation)Object.defineProperty(globalThis,'location',oldLocation);else delete globalThis.location;if(oldHistory)Object.defineProperty(globalThis,'history',oldHistory);else delete globalThis.history;});
 const api={controller,states,calls,posts,reads,readQueue,profiles,nav,config,catalogs,emit(pid=s.project.id){listeners.get(pid)?.onEvent({id:calls.length+1,projectId:pid,runId:null,type:'run.phase',payload:{},at});}};
 return {...api,async boot(){await controller.boot();await flush();}};
}

test('SSE coalescing performs a trailing read for the final event instead of dropping delivery',async t=>{
 const f=await fixture(t,withRun(snapshot())),{controller:c}=f;await f.boot();
 const old=clone(f.states.get('p')),wait=deferred();f.readQueue.push(()=>wait.promise);f.emit();await flush();
 const final=f.states.get('p');final.runs[0].state='READY_FOR_DELIVERY';final.runs[0].version++;f.emit();
 wait.resolve(old);await flush();assert.equal(c.state.phase,'ready');assert.equal(c.state.runId,'run-p');
 assert.equal(f.calls.filter(x=>x.path==='/projects/p'&&x.method==='GET').length,3);
});

test('a delayed pre-mutation snapshot cannot undo a saved answer or its version',async t=>{
 const f=await fixture(t),{controller:c}=f;await f.boot();const old=clone(f.states.get('p')),wait=deferred();
 f.readQueue.push(()=>wait.promise);f.emit();await flush();
 f.posts.set('/projects/p/answer',body=>{const s=f.states.get('p');s.project.answers=[{id:'a1',questionId:body.questionId,text:body.text,revision:1,status:'answered',createdAt:at}];s.project.version++;s.project.state='AWAITING_INTERVIEW_DECISION';return s;});
 await c.dispatch({type:'answer-submit',questionId:'q1',answer:'先给自己用'});wait.resolve(old);await flush();
 assert.equal(c.state.questions[0].answer,'先给自己用');assert.equal(c.state.activeQuestionId,undefined);
 assert.equal(c.state.interviewDecisionRequired,true);
});

test('known failed build keeps the approved start action and reuses approval on explicit retry',async t=>{
 const f=await fixture(t,withSpec(snapshot())),{controller:c}=f;await f.boot();let builds=0;
 f.posts.set('/projects/p/approve',()=>{const s=f.states.get('p');s.project.state='READY_TO_BUILD';s.project.version++;return s;});
 f.posts.set('/projects/p/build',body=>{assert.equal(body.flowName,'classic');assert.equal(body.laya,true);if(++builds===1)throw new UiError('NATIVE_INTEGRATION_BLOCKED','synthetic preflight gate',409);const s=f.states.get('p');withRun(s);s.project.version++;return s;});
 const confirm={type:'requirements-confirm',text:requirementText(f.states.get('p').spec),expectedRevision:1};
 await assert.rejects(c.dispatch(confirm),{code:'NATIVE_INTEGRATION_BLOCKED'});
 assert.equal(c.state.requirements.confirmed,true);assert.equal(c.state.capabilities.confirm,true);assert.equal(c.state.locked,false);
 await c.dispatch(confirm);assert.equal(f.calls.filter(x=>x.path.endsWith('/approve')).length,1);assert.equal(builds,2);assert.equal(c.state.locked,true);assert.equal(c.state.capabilities.confirm,false);
});

test('a READY review can conclude then reopen requirements while answers remain locked beforehand',async t=>{
 const f=await fixture(t,ready(snapshot())),{controller:c}=f;await f.boot();
 assert.equal(c.state.locked,true);assert.equal(c.state.capabilities.editAnswers,false);assert.equal(c.state.capabilities.followup,true);assert.equal(c.state.capabilities.cancel,false);
 f.reads.set('/runs/run-p/report',()=>({reportHash:'d'.repeat(64)}));
 f.posts.set('/runs/run-p/conclude',body=>{assert.equal(body.choice,'ALTERNATIVE');f.states.get('p').chat.editable=true;return {};});
 f.posts.set('/projects/p/alternative',()=>{const s=f.states.get('p');s.spec=null;s.project.specId=null;s.project.activeRunId=null;s.project.state='INTERVIEWING';s.project.version++;s.chat.reviewFeedbackReady=false;return s;});
 f.posts.set('/projects/p/next',()=>f.states.get('p'));
 await c.dispatch({type:'review-followup',text:'增加导出功能'});
 assert.deepEqual(f.calls.filter(x=>x.method==='POST').map(x=>x.path),['/runs/run-p/conclude','/projects/p/alternative','/projects/p/next']);
 assert.equal(c.state.locked,false);assert.equal(c.state.phase,'awaiting_answer');
});

test('initial open explains one exact review and a newer review is not hidden by old same-run feedback',async t=>{
 const f=await fixture(t,ready(snapshot()),{explain:true}),{controller:c}=f;
 f.posts.set('/projects/p/review-feedback',()=>{const s=f.states.get('p');s.chat.reviewFeedback=feedback(s,'审查版本 '+s.runs[0].version);return s.chat.reviewFeedback.data;});
 await f.boot();assert.equal(f.calls.filter(x=>x.path.endsWith('/review-feedback')).length,1);
 assert.equal(c.state.messages.filter(x=>x.title==='本轮结果与下一步').length,1);
 await c.dispatch({type:'refresh'});await flush();assert.equal(f.calls.filter(x=>x.path.endsWith('/review-feedback')).length,1);
 const s=f.states.get('p');s.records.push(s.chat.reviewFeedback);s.chat.reviewFeedback=null;s.runs[0].version=2;s.chat.reviewFeedbackBinding.runVersion=2;s.chat.reviewFeedbackBinding.reviewHash='e'.repeat(64);f.emit();await flush();
 assert.equal(f.calls.filter(x=>x.path.endsWith('/review-feedback')).length,2);
 const messages=c.state.messages.filter(x=>x.title==='本轮结果与下一步');assert.equal(messages.length,1);assert.match(messages[0].text,/审查版本 2/);
});

test('a truncated mutation response is held unknown and neither refresh nor events replay it',async t=>{
 const f=await fixture(t,ready(snapshot()),{explain:true}),{controller:c}=f;
 f.posts.set('/projects/p/review-feedback',()=>{throw new UiError('INVALID_JSON','synthetic response stream interrupted');});
 await f.boot();f.emit();await flush();await c.dispatch({type:'refresh'});await flush();
 assert.equal(f.calls.filter(x=>x.path.endsWith('/review-feedback')).length,1);
 await assert.rejects(c.dispatch({type:'review-followup',text:'再解释一次'}),{code:'RESULT_UNCERTAIN'});
 assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
});

test('a failed GET does not poison the mutation guard after a successful read',async t=>{
 const f=await fixture(t),{controller:c}=f;await f.boot();
 f.readQueue.push(()=>{throw new UiError('NETWORK_UNCERTAIN','synthetic read failure');});f.emit();await flush();
 await c.dispatch({type:'refresh'});
 f.posts.set('/projects/p/question-help',()=>({explanation:'这是指最先使用的人。'}));
 assert.deepEqual(await c.dispatch({type:'question-help',questionId:'q1',text:'什么意思？'}),{text:'这是指最先使用的人。'});
});

test('engineering mode and read-only role cards follow each project and confirmed profile',async t=>{
 const f=await fixture(t,withRun(snapshot('custom'),'PLANNING','custom')),{controller:c}=f;
 f.states.set('classic',withRun(snapshot('classic'),'PLANNING','classic'));
 f.states.set('draft',withSpec(snapshot('draft')));f.profiles.draft={projectId:'draft',configuration:{mode:'custom',roles:{planner2:{runtime:'pi',model:{id:'test-planner'},provider:'synthetic',authentication:'api_key'},executors:[{runtime:'dsh',model:{id:'test-executor'},provider:'synthetic',authentication:'api_key'}],reviewer:{runtime:'codex',model:{id:'test-reviewer'},provider:'synthetic',authentication:'api_key'}}}};
 await f.boot();assert.equal(c.state.engineeringMode,'custom');
 await c.dispatch({type:'project-select',id:'classic'});assert.equal(c.state.engineeringMode,'classic');
 await c.dispatch({type:'project-select',id:'draft'});assert.equal(c.state.engineeringMode,'custom');assert.equal(c.state.roles.planner.harness,'pi');assert.equal(c.state.roles.planner.frozen,true);
 await c.dispatch({type:'settings-open'});assert.equal(f.nav.at(-1),'/?ui=legacy&view=settings');
 await c.dispatch({type:'help-open'});assert.equal(f.nav.at(-1),'/?ui=legacy&view=help');
 await c.dispatch({type:'engineering-settings-open'});assert.equal(f.nav.at(-1),'/?ui=legacy&project=draft&tab=flow');
 await c.dispatch({type:'project-new'});await c.dispatch({type:'engineering-settings-open'});assert.equal(f.nav.at(-1),'/?ui=legacy&view=settings');
});

test('standalone DF shows no Seeker question or automatic feedback and refuses switching into DM',async t=>{
 const s=ready(snapshot());s.project.planner1Mode='USER';s.project.questions=[];
 const f=await fixture(t,s,{product:'dreamflow',explain:true}),{controller:c}=f;await f.boot();
 assert.equal(c.state.product,'df');assert.deepEqual(c.state.questions,[]);assert.equal(c.state.messages.some(x=>x.role==='seeker'),false);
 assert.equal(f.calls.some(x=>x.method==='POST'),false);
 await assert.rejects(c.dispatch({type:'product-switch',product:'dm'}),{code:'DM_INSTANCE_REQUIRED'});
});

test('archive restore appends only the existing versioned presentation mutation',async t=>{
 const s=snapshot();s.chat.presentation.archived=true;const f=await fixture(t,s),{controller:c}=f;await f.boot();
 f.posts.set('/projects/p/presentation',body=>{assert.deepEqual(body,{version:1,archived:false});const s=f.states.get('p');s.chat.presentation.archived=false;s.chat.presentation.revision++;return s;});
 await c.dispatch({type:'project-restore',id:'p'});assert.equal(c.state.projects[0].archived,false);
});

test('cleanup after the last phase event is observed by bounded reads before one feedback request',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const s=ready(snapshot());s.chat.reviewFeedbackReady=false;const f=await fixture(t,s,{explain:true});
 f.posts.set('/projects/p/review-feedback',()=>{const s=f.states.get('p');s.chat.reviewFeedback=feedback(s);return s.chat.reviewFeedback.data;});
 await f.boot();assert.equal(f.calls.some(x=>x.method==='POST'),false);
 f.states.get('p').chat.reviewFeedbackReady=true;t.mock.timers.tick(250);await flush();
 assert.equal(f.calls.filter(x=>x.path.endsWith('/review-feedback')).length,1);
});

test('pending Seeker question and plan operations expose stop through the original planning cancel route',async t=>{
 const f=await fixture(t),{controller:c}=f;await f.boot();
 for(const action of [{type:'question-help',questionId:'q1',text:'解释一下'},{type:'end-interview'}]){
  const wait=deferred(),path=action.type==='question-help'?'/projects/p/question-help':'/projects/p/finish';
  f.posts.set(path,()=>wait.promise);f.posts.set('/projects/p/planning/cancel',()=>{wait.resolve(action.type==='question-help'?{explanation:'已结束'}:f.states.get('p'));return {};});
  const work=c.dispatch(action);await flush();assert.equal(c.state.busy,true);assert.equal(c.state.capabilities.cancel,true);assert.equal(c.state.runId,undefined);
  await c.dispatch({type:'cancel'});await work;assert.equal(c.state.capabilities.cancel,false);
 }
 assert.equal(f.calls.filter(x=>x.path==='/projects/p/planning/cancel').length,2);
 assert.equal(f.calls.some(x=>x.path.startsWith('/runs/')&&x.path.endsWith('/cancel')),false);
});

test('automatic read-only review feedback never exposes or redirects to engineering cancellation',async t=>{
 const f=await fixture(t,ready(snapshot()),{explain:true}),{controller:c}=f,wait=deferred();
 f.posts.set('/projects/p/review-feedback',()=>wait.promise);await f.boot();
 assert.equal(c.state.busy,true);assert.equal(c.state.capabilities.cancel,false);
 await assert.rejects(c.dispatch({type:'cancel'}),{code:'READ_ONLY_ANALYSIS_PENDING'});
 assert.equal(f.calls.some(x=>x.path.endsWith('/cancel')),false);
 f.states.get('p').chat.reviewFeedback=feedback(f.states.get('p'));wait.resolve(f.states.get('p').chat.reviewFeedback.data);await flush();
});

test('multi-select answers preserve original ids and project version without inventing free text',async t=>{
 const s=snapshot();s.project.version=7;s.project.questions[0].allowMultiple=true;
 s.project.questions[0].options=[{id:'a',label:'自己'},{id:'b',label:'家人'},{id:'c',label:'小团队'},{id:'d',label:'公开使用'}];
 const f=await fixture(t,s),{controller:c}=f;await f.boot();assert.equal(c.state.questions[0].allowMultiple,true);
 f.posts.set('/projects/p/answer',body=>{
  assert.deepEqual(body,{questionId:'q1',text:'',version:7,optionIds:['a','c']});
  const current=f.states.get('p');current.project.answers=[{id:'a1',questionId:'q1',text:'由原服务端解析选项',optionIds:body.optionIds,revision:1,status:'answered',createdAt:at}];
  current.project.version=8;current.project.state='AWAITING_INTERVIEW_DECISION';return current;
 });
 await c.dispatch({type:'answer-submit',questionId:'q1',answer:'',choiceIds:['a','c']});
 assert.equal(f.calls.filter(x=>x.path==='/projects/p/answer').length,1);
 assert.equal(c.state.questions[0].answer,'由原服务端解析选项');
});

test('the Seeker picker fetches each provider catalog and keeps the current binding selected',async t=>{
 const f=await fixture(t),{controller:c}=f;await f.boot();
 assert.equal(c.state.roles.seeker.modelEditable,false);
 assert.deepEqual(c.state.roles.seeker.models.map(x=>x.id),['synthetic-seeker']);
 const deep=await c.seekerModels('deepseek');
 assert.deepEqual(deep.map(x=>x.id),['deepseek-flash','deepseek-v4-pro','synthetic-seeker']);
 assert.equal(deep.at(-1).label,'synthetic-seeker · 当前绑定');
 assert.deepEqual(c.state.roles.seeker.models.map(x=>x.id),deep.map(x=>x.id));
 const open=await c.seekerModels('openai');
 assert.deepEqual(open.map(x=>x.id),['gpt-6-luna']);
 assert.deepEqual(f.calls.filter(x=>x.path.startsWith('/planner1/models')).map(x=>x.path),['/planner1/models?provider=deepseek','/planner1/models?provider=openai']);
});

test('saving a Seeker model lifts the binding to v4 (seeker_api route) and unblocks the next message',async t=>{
 const f=await fixture(t,undefined,{bindingVersion:1}),{controller:c}=f;await f.boot();
 await c.dispatch({type:'project-new'});
 assert.match(c.state.notice,/Seeker API/);
 await assert.rejects(c.dispatch({type:'message-send',text:'先写个需求'}),{code:'SEEKER_API_REQUIRED'});
 assert.equal(f.calls.filter(x=>x.path==='/projects'&&x.method==='POST').length,0);
 f.posts.set('/planner1/selection',body=>{
  assert.deepEqual(body,{provider:'deepseek',authentication:'api_key',model:'deepseek-flash',confirmed:true,route:'seeker_api'});
  f.config.planner1Binding={...f.config.planner1Binding,provider:'deepseek',model:'deepseek-flash',bindingVersion:4};return clone(f.config);
 });
 await c.dispatch({type:'role-configure',role:'seeker',model:'deepseek-flash',reasoning:'default',harness:'api',provider:'deepseek'});
 assert.equal(f.config.planner1Binding.bindingVersion,4);assert.equal(c.state.roles.seeker.model,'deepseek-flash');
 const created=snapshot('np');created.project.id='np';created.project.name='新项目';created.project.state='DRAFT';created.project.questions=[];created.project.activeRunId=null;
 f.states.set('np',created);
 f.posts.set('/projects',body=>{assert.equal(body.idea,'先写个需求');return created;});
 f.posts.set('/projects/np/next',()=>f.states.get('np'));
 await c.dispatch({type:'message-send',text:'先写个需求'});
 assert.equal(f.calls.filter(x=>x.path==='/projects'&&x.method==='POST').length,1);
 assert.equal(f.calls.filter(x=>x.path==='/planner1/selection'&&x.method==='POST').length,1);
});

test('message-send is refused before any project write when no v2 API selection exists',async t=>{
 const f=await fixture(t,undefined,{bindingVersion:1}),{controller:c}=f;await f.boot();
 await c.dispatch({type:'project-new'});
 await assert.rejects(c.dispatch({type:'message-send',text:'未选择模型'}),{code:'SEEKER_API_REQUIRED'});
 assert.equal(f.calls.filter(x=>x.path==='/projects'&&x.method==='POST').length,0);
});
