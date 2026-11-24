import type { ChatAction, ChatController, ChatState, ChatRole, ChatQuestion, ChatRoleConfig, ChatProduct } from './chat-types.js';

const newId=()=>crypto.randomUUID();
const at=()=>new Date().toISOString();
const qTemplates:Omit<ChatQuestion,'id'>[]=[
 {text:'这个阅读工作台，主要是给谁使用？',choices:[{id:'A',label:'只给我自己用',description:'一处整理自己的阅读和思考'},{id:'B',label:'和朋友一起使用',description:'分享书单、进度与读书笔记'},{id:'C',label:'给一个读书小组',description:'多人协作，管理共同阅读计划'},{id:'D',label:'先做原型，再开放',description:'先验证想法，再考虑更多用户'}]},
 {text:'如果第一版只做好一件事，你最希望是什么？',choices:[{id:'A',label:'整理我的全部书籍',description:'让收藏、在读、已读一目了然'},{id:'B',label:'随手记下阅读灵感',description:'便捷记录和检索笔记'},{id:'C',label:'帮我坚持阅读',description:'阅读计划和温和的提醒'},{id:'D',label:'分享我喜欢的书',description:'生成可以分享的书单'}]},
 {text:'你希望这些书籍和笔记，保存在哪里？',choices:[{id:'A',label:'只保存在这台电脑',description:'离线可用，数据留在自己手中'},{id:'B',label:'多个设备之间同步',description:'电脑和手机都能继续阅读'},{id:'C',label:'保存在自己的云盘',description:'方便备份，也由我自己管理'},{id:'D',label:'先简单一点，以后再决定',description:'先做本地版本，预留同步接口'}]},
 {text:'你会怎样判断第一版已经值得使用？',allowMultiple:true,choices:[{id:'A',label:'每天都能轻松添加笔记',description:'操作顺手，不打断阅读'},{id:'B',label:'能快速找到想要的内容',description:'书籍与笔记都有搜索入口'},{id:'C',label:'数据安全，不怕弄丢',description:'支持导出、备份与恢复'},{id:'D',label:'先验证完整的使用流程',description:'添加书籍、记录、搜索都能完成'}]},
];
const roles:ChatRole[]=['seeker','planner','executor','reviewer'];
function roleConfig(role:ChatRole):ChatRoleConfig {
 const isSeeker=role==='seeker',model=isSeeker||role==='executor'?'deepseek-flash':'gpt-6-luna',harness=isSeeker?'dm-api':role==='executor'?'dsh':'codex';
 return {role,model,reasoning:'medium',harness,provider:isSeeker?'deepseek-official':undefined,providers:isSeeker?[{id:'deepseek-official',label:'DeepSeek 官方 API（演示）',available:true},{id:'openai',label:'OpenAI API（演示）',available:true}]:undefined,modelEditable:isSeeker,providerLabel:isSeeker||role==='executor'?'DeepSeek API · 演示配置':'OpenAI · 演示配置',authLabel:isSeeker||role==='executor'?'API Key · 未实际接入':'官方账户 · 未实际接入',models:[{id:model,label:`${model}（演示）`,available:true}],reasoningLevels:[{id:'low',label:'低',available:true},{id:'medium',label:'中',available:true},{id:'high',label:'高',available:true}],harnesses:[{id:harness,label:isSeeker?'DM API':harness==='codex'?'Codex':'DSH',available:true},...(!isSeeker?[{id:'claude',label:'Claude Code',available:false,reason:'尚未验证此组合'},{id:'pi',label:'Pi Agent',available:false,reason:'业务闭环仍待验证'}]:[])],extensions:isSeeker?[
   {id:'grill-me',label:'Grill Me',kind:'skill',description:'一次一个问题，把想法拆成可回答的选择。',available:true,required:true},
   {id:'prompt-optimizer',label:'Prompt optimizer',kind:'skill',description:'将描述与问答整理成可编辑、可确认的需求。',available:true,required:true},
   {id:'research',label:'开源项目研究',kind:'plugin',description:'在授权范围内研究相关公开项目。',available:false,reason:'演示不访问外部服务'}
 ]:[
   {id:'delivery-notes',label:'清晰的交付说明',kind:'skill',description:'说明成果、限制和可以复验的步骤。',available:true},
   {id:'repository',label:'项目资料检索',kind:'plugin',description:'只读取角色获授权的项目资料。',available:true},
   {id:'external-tools',label:'更多插件',kind:'plugin',description:'需要由原控制端注册和验证权限。',available:false,reason:'没有已验证的本机绑定'}
 ],selectedExtensions:isSeeker?['grill-me','prompt-optimizer']:['delivery-notes']};
}
function questions():ChatQuestion[]{return qTemplates.map((q,i)=>({...structuredClone(q),id:`demo-q-${i+1}`,revision:1,status:i<2?'answered':i===2?'pending':'pending',...(i===0?{answer:'只给我自己用',requirementIds:['R001']}:i===1?{answer:'随手记下阅读灵感',requirementIds:['R002']}:{})}));}
export function initialChatDemoState(product:ChatProduct='dm'):ChatState {
 return {product,engineeringMode:'classic',evidence:'demo',loading:false,connected:true,busy:false,title:product==='dm'?'我的阅读工作台':'个人阅读工作台 · 工程计划',projectId:product==='dm'?'demo-reading':'demo-flow',projects:[{id:'demo-reading',title:'我的阅读工作台',product:'dm',pinned:true},{id:'demo-budget',title:'轻量记账工具',product:'dm',pinned:true},{id:'demo-notes',title:'我的知识花园',product:'dm'},{id:'demo-walk',title:'周末徒步记录',product:'dm'},{id:'demo-flow',title:'阅读工作台 · 工程计划',product:'df',pinned:true}],messages:product==='dm'?[
 {id:'demo-msg-1',role:'user',text:'我想做一个自己的阅读工作台，把读过的书、正在读的书和随手记下的想法整理到一起。希望简单一些，打开就能用。',at:'2026-11-21T13:06:00Z'},
 {id:'demo-msg-2',role:'seeker',text:'一个安静的地方，装下你的书和思考。\n我已经记下：先做给你自己使用，第一版优先照顾随手记录的体验。接下来，我们看看数据怎样保存更适合你。',title:'Grill Me · 澄清需求',at:'2026-11-21T13:07:00Z'}
 ]:[],phase:product==='dm'?'awaiting_answer':'idle',phaseDetail:product==='dm'?'每一个回答，都会变成右侧的一颗星。你可以随时回看。':undefined,questions:product==='dm'?questions():[],activeQuestionId:product==='dm'?'demo-q-3':null,locked:false,requirements:null,roles:Object.fromEntries(roles.map(r=>[r,roleConfig(r)])) as Record<ChatRole,ChatRoleConfig>,capabilities:{send:true,answers:true,editAnswers:true,help:true,confirm:true,configureRoles:true,extensions:true,attachments:true,rename:true,archive:true,pin:true,cancel:false,finishInterview:product==='dm'},attachments:[],legacyHref:'/?legacy=1'};
}
/** Explicitly synthetic UI. It never uses fetch, EventSource, model APIs, production stores or timers. */
export function createChatDemoController(onState:(state:ChatState)=>void,product:ChatProduct='dm'):{controller:ChatController;getState():ChatState;destroy():void} {
 let state=initialChatDemoState(product),disposed=false;
 const snapshots=new Map<string,ChatState>();
 const emit=()=>{if(!disposed)onState(structuredClone(state));};
 const msg=(role:'user'|ChatRole|'system',text:string,title?:string)=>{state.messages.push({id:newId(),role,text,at:at(),title});};
 const saved=()=>{if(state.projectId)snapshots.set(state.projectId,structuredClone(state));};
 function newProject(){saved();const id=`demo-${newId()}`;state={...initialChatDemoState(state.product),projects:[...state.projects],projectId:id,title:'新聊天',messages:[],phase:'idle',phaseDetail:undefined,questions:[],activeQuestionId:null,requirements:null,capabilities:{...initialChatDemoState(state.product).capabilities,finishInterview:false,followup:false},attachments:[]};state.projects.unshift({id,title:'新聊天',product:state.product});}
 function optimize(){state.locked=false;state.capabilities={...state.capabilities,confirm:true,cancel:false,followup:false,send:true};state.requirements={revision:(state.requirements?.revision??0)+1,confirmed:false,text:`项目：${state.title}\n\n目标\n${state.messages.find(m=>m.role==='user')?.text??'建立一个简单、实用的个人工作台。'}\n\n已经确认\n${state.questions.filter(q=>q.answer).map((q,i)=>`${i+1}. ${q.text}\n   ${q.answer}`).join('\n')}\n\n第一版范围\n• 以已确认需求为准，先完成一条可用的核心流程。\n• 每条需求映射到 Prework 任务与可复验的验收标准。\n• 只在获授权的工作区执行，保留预算和独立审查。\n\n仍未确认\n• 本演示不会替你推断账户、费用、发布或数据迁移授权。`};state.activeQuestionId=null;state.phase='awaiting_confirmation';state.phaseDetail='Prompt optimizer 已根据演示问答整理需求。你可以直接修改下方正文。';state.capabilities.finishInterview=false;msg('seeker','我把你的描述和回答整理成了下面这份需求。你可以修改措辞、补充遗漏，再确认开始。','Prompt optimizer · 演示');}
 function startFlow(){state.phase='flow';state.phaseDetail='演示将逐步展示原 Engine 应提供的状态，不执行模型或代码。';state.locked=true;state.lockReason='本轮需求已冻结。星星可查看，暂不可修改。';state.activeQuestionId=null;state.capabilities={...state.capabilities,send:false,answers:false,editAnswers:false,confirm:false,cancel:true,finishInterview:false,followup:false};state.demoStepLabel='演示 Planner 接力';state.runId=`demo-run-${newId()}`;msg('system','已确认需求版本。DreamFlow 接过这份计划。');}
 const controller:ChatController={async dispatch(action:ChatAction){
   if(disposed)return;
   state.error=null;state.notice=null;
   switch(action.type){
    case 'project-new':newProject();break;
    case 'product-switch':{saved();const chosen=state.projects.find(p=>p.product===action.product&&!p.archived);state.product=action.product;if(chosen&&snapshots.has(chosen.id)){const list=state.projects;state=structuredClone(snapshots.get(chosen.id)!);state.projects=list;}else if(chosen?.id==='demo-flow'){const list=state.projects;state=initialChatDemoState('df');state.projects=list;}else if(chosen?.id==='demo-reading'){const list=state.projects;state=initialChatDemoState('dm');state.projects=list;}else newProject();break;}
    case 'project-select':{saved();const project=state.projects.find(p=>p.id===action.id);if(!project)throw Error('项目不存在。');const list=state.projects;if(snapshots.has(action.id)){state=structuredClone(snapshots.get(action.id)!);state.projects=list;}else{state={...initialChatDemoState(project.product),projects:list,projectId:project.id,title:project.title,messages:[],questions:[],activeQuestionId:null,requirements:null,phase:'idle',phaseDetail:undefined};}break;}
    case 'project-rename':{const p=state.projects.find(p=>p.id===action.id);if(!p)throw Error('项目不存在。');p.title=action.title;if(p.id===state.projectId)state.title=action.title;const old=snapshots.get(p.id);if(old)old.title=action.title;break;}
    case 'project-pin':{const p=state.projects.find(p=>p.id===action.id);if(p)p.pinned=action.pinned;break;}
    case 'project-archive':{const p=state.projects.find(p=>p.id===action.id);if(p)p.archived=true;if(p?.id===state.projectId)newProject();break;}
    case 'project-restore':{const p=state.projects.find(p=>p.id===action.id);if(p)p.archived=false;break;}
    case 'message-send':{
      if(state.locked)throw Error('本轮执行中的需求已经冻结。');msg('user',action.text);
      if(state.product==='df'){state.requirements={text:action.text,revision:1,confirmed:false};state.phase='awaiting_confirmation';state.phaseDetail='独立 DreamFlow：你提供计划并确认后，三个工程角色接力。';state.capabilities.finishInterview=false;break;}
      if(state.phase==='idle'||!state.questions.length){state.title=action.text.includes('阅读')?'我的阅读工作台':action.text.replace(/[\n，。！？]/g,' ').trim().slice(0,18)||'新的想法';const p=state.projects.find(p=>p.id===state.projectId);if(p)p.title=state.title;state.questions=qTemplates.map((q,i)=>({...structuredClone(q),id:`demo-q-${i+1}`,revision:1,status:'pending'}));state.activeQuestionId=state.questions[0].id;state.phase='awaiting_answer';state.phaseDetail='演示问题供体验交互，真实版本由 Seeker 的 Grill Me 生成。';state.capabilities.finishInterview=false;msg('seeker','我们先从几个关键选择开始。每次只谈一个问题，你也可以用自己的话回答。','Grill Me · 演示');}
      else{state.notice='先回答当前问题，或选择结束问答并整理需求。';}break;
    }
    case 'answer-submit':{
      if(state.locked||action.questionId!==state.activeQuestionId)throw Error('当前问题或需求版本已改变，请刷新后作答。');
      const q=state.questions.find(q=>q.id===action.questionId)!;
      const ids=action.choiceIds??(action.choiceId?[action.choiceId]:[]);
      if(new Set(ids).size!==ids.length||ids.some(id=>!q.choices?.some(c=>c.id===id)))throw Error('选项无效，请重新选择。');
      if(!q.allowMultiple&&ids.length>1)throw Error('这道问题只支持单选。');
      const answer=[...ids.map(id=>q.choices!.find(c=>c.id===id)!.label),action.answer.trim()].filter(Boolean).join('\n');
      if(!answer)throw Error('请先选择选项或输入自己的回答。');
      q.answer=answer;q.status='answered';q.requirementIds=[`R${String(state.questions.indexOf(q)+1).padStart(3,'0')}`];msg('seeker',q.text,'已回答的问题');msg('user',answer);const next=state.questions.find(q=>!q.answer);state.capabilities.finishInterview=true;if(next){state.activeQuestionId=next.id;state.phase='awaiting_answer';}else optimize();break;
    }
    case 'answer-edit':{if(state.locked)throw Error('本轮正在执行，回答只可查看。');const q=state.questions.find(q=>q.id===action.questionId);if(!q||q.revision!==action.expectedRevision)throw Error('回答版本已改变，请重新打开星星。');q.answer=action.answer;q.revision++;q.status='changed';if(state.requirements){state.requirements.confirmed=false;state.requirements=null;state.capabilities.finishInterview=true;}msg('system',`问题 ${state.questions.indexOf(q)+1} 的回答已保存新版本。请重新整理并确认需求。`);break;}
    case 'question-help':{const q=state.questions.find(x=>x.id===action.questionId);if(!q)throw Error('问题不存在。');return {text:`【本地演示解释，非模型回复】\n这道题在确认“${q.text}”。\n\n例如“只保存在这台电脑”，类似把笔记写在自己的本子里：不需要联网，换一台电脑时需要自行搬过去。“多设备同步”则像共享一本随身笔记，使用方便，但要另外确认账户、同步服务和费用。\n\n你可以先选择最接近现状的一项，也可以返回主对话写“我还不确定”。这里的解释不会修改你的正式回答。`};}
    case 'end-interview':if(state.locked)throw Error('执行中不能结束或改写问答。');optimize();break;
    case 'requirements-edit':{if(state.locked||state.requirements?.revision!==action.expectedRevision)throw Error('需求版本已改变。');state.requirements.text=action.text;state.requirements.revision++;state.requirements.confirmed=false;break;}
    case 'requirements-confirm':{if(state.locked||state.requirements?.revision!==action.expectedRevision)throw Error('需求版本已改变，请核对后确认。');state.requirements.text=action.text;state.requirements.confirmed=true;startFlow();break;}
    case 'role-configure':{if(state.locked)throw Error('本轮角色配置已冻结。');const r=state.roles[action.role];if(!r.harnesses.some(o=>o.id===action.harness&&o.available))throw Error('该 Harness 组合尚未可用。');if(!r.modelEditable&&!r.models.some(o=>o.id===action.model&&o.available))throw Error('该模型尚未可用。');r.model=action.model;r.reasoning=action.reasoning;r.harness=action.harness;if(action.provider)r.provider=action.provider;state.notice='已保存演示配置。真实账户、模型资格与计费未发生变化。';break;}
    case 'role-extensions':{if(state.locked)throw Error('执行期间不能更改 Skills 或插件。');const r=state.roles[action.role];if(action.ids.some(id=>!r.extensions.some(x=>x.id===id&&x.available)))throw Error('扩展未注册或不可用。');r.selectedExtensions=[...new Set([...action.ids,...r.extensions.filter(x=>x.required).map(x=>x.id)])];break;}
    case 'attachments-add':if(state.locked)throw Error('执行期间不能添加本轮输入。');for(const f of action.files){if(f.size>10*1024*1024)throw Error('演示附件上限为 10 MB；文件未上传。');state.attachments.push({id:newId(),name:f.name,size:f.size,status:'selected',detail:'仅在当前页面展示，未读取或上传内容'});}state.notice='文件仅在当前演示页显示；没有读取文件内容，也没有上传。';break;
    case 'attachment-remove':if(state.locked)throw Error('执行期间附件只读。');state.attachments=state.attachments.filter(a=>a.id!==action.id);break;
    case 'cancel':state.phase='paused';state.phaseDetail='演示已暂停，没有模型进程或外部副作用。';state.demoStepLabel=undefined;state.locked=false;state.capabilities={...state.capabilities,cancel:false,send:true,editAnswers:true,confirm:true,followup:false};break;
    case 'refresh':state.notice='这是一份当前页面中的合成交互状态，不代表真实项目运行结果。';break;
    case 'demo-step':{
      if(state.phase==='flow'){state.phase='planning';state.demoStepLabel='演示 Prework 交接';msg('planner','先完成一条可用的核心流程：\n01 · 建立书籍与笔记的数据结构\n02 · 实现添加、检索和阅读状态\n03 · 完成导出及最小验证\n\n每项任务会对应你的已确认需求，交由 Prework 限定工作范围与验收标准。','工程计划 · 演示');}
      else if(state.phase==='planning'){state.phase='prework';state.demoStepLabel='演示 Executor 执行';msg('system','Prework 演示合同：需求、任务、写入范围与验收条件已对应。');}
      else if(state.phase==='prework'){state.phase='executing';state.demoStepLabel='演示验证';state.questions.filter(q=>q.answer).forEach(q=>q.status='working');msg('executor','[演示记录]\nT001  建立本地数据结构\nT002  完成书籍列表与笔记编辑\nT003  补充搜索、导出和交互验证\n\n实际版本将在受控工作区执行，并逐项回报真实工具结果。','执行记录');}
      else if(state.phase==='executing'){state.phase='verifying';state.demoStepLabel='演示 Reviewer 审查';msg('system','演示进入验证阶段；此页未运行任何测试，不产生通过证据。');}
      else if(state.phase==='verifying'){state.phase='reviewing';state.demoStepLabel=state.product==='dm'?'演示交回 Seeker':'演示成果待接受';msg('reviewer','演示审查意见\n核心范围已对应到任务。还需要确认“更换电脑时如何恢复资料”，以免把导出文件误当作完整恢复能力。\n\n建议在下一轮明确备份与恢复的范围，再确定验收用例。','独立审查 · 演示');}
      else if(state.phase==='reviewing'){state.phase=state.product==='dm'?'review_feedback':'ready';state.demoStepLabel=undefined;state.locked=false;state.capabilities={...state.capabilities,cancel:false,send:true,editAnswers:true,confirm:false,followup:state.product==='dm'};state.questions.filter(q=>q.answer).forEach((q,i)=>{q.status=i===2?'changed':'done';q.evidenceLabel='演示状态 · 无真实执行证据';});if(state.product==='dm')msg('seeker','Reviewer 提醒我们补上“换电脑之后怎么办”。\n\n我建议第一版先支持一个可以恢复的本地备份包；云同步保留到后续版本。你愿意采用这个方案，还是更希望先做多设备同步？','分析阻碍 · 重新确认');else msg('system','演示成果待你查看与接受。未执行最终接受。');}break;
    }
    case 'review-followup':{if(state.locked)throw Error('当前运行尚未安全收口。');msg('user',action.text);state.questions.push({id:newId(),text:'根据本轮审查，下一轮如何处理备份与恢复？',answer:action.text,revision:1,status:'added',requirementIds:['R005']});state.capabilities.followup=false;optimize();break;}
    case 'help-open':state.notice='操作提示：右侧实心星查看与编辑回答，空星解释当前问题；加号选择资料与角色能力，右下角色图标配置模型。演示不会调用模型。';break;
    case 'engineering-settings-open':case 'settings-open':state.notice='当前为独立交互演示。真实版本的 API 账户与预算、工程模式 与数据管理会打开原应用设置。';break;
   }
   state.phaseAt=at();saved();emit();
 }};
 return {controller,getState:()=>structuredClone(state),destroy(){disposed=true;snapshots.clear();}};
}

/** Entry convenience: no implicit dispatch or model work occurs at start. */
export function createChatDemo(paint:(state:ChatState)=>void,product:ChatProduct='dm'):ChatController&{start():void;dispose():void}{
 const demo=createChatDemoController(paint,product);
 return {...demo.controller,start(){paint(demo.getState());},dispose(){demo.destroy();}};
}
