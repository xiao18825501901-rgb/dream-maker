/** Desktop conversation projection. It grants no Engine, budget or role authority. */
export type ChatRole = 'seeker' | 'planner' | 'executor' | 'reviewer';
export type ChatProduct = 'dm' | 'df';
export type ChatEngineeringMode = 'classic' | 'custom';
export type ChatPhase = 'idle' | 'seeking' | 'awaiting_answer' | 'optimizing' | 'awaiting_confirmation' | 'flow' | 'planning' | 'prework' | 'executing' | 'verifying' | 'reviewing' | 'review_feedback' | 'ready' | 'accepted' | 'blocked' | 'paused' | 'cancelling' | 'error';
export interface ChatProject { id:string; title:string; product:ChatProduct; pinned?:boolean; archived?:boolean; updatedAt?:string; subtitle?:string; }
export interface ChatMessage { id:string; role:ChatRole|'user'|'system'; text:string; at?:string; title?:string; badge?:string; kind?:'message'|'activity'|'result'; }
export interface ChatQuestion { id:string; text:string; answer?:string; allowMultiple?:boolean; choices?:{id:string;label:string;description?:string}[]; revision?:number; status?:'pending'|'answered'|'changed'|'added'|'working'|'done'|'blocked'|'crafted'|'verified'|'reviewed'; requirementIds?:string[]; evidenceLabel?:string; }
export interface ChatOption { id:string; label:string; available:boolean; reason?:string; }
export interface ChatExtension extends ChatOption { kind:'skill'|'plugin'; description:string; required?:boolean; }
export interface ChatRoleConfig { role:ChatRole; model:string; reasoning:string; harness:string; provider?:string; providers?:ChatOption[]; modelEditable?:boolean; providerLabel?:string; authLabel?:string; frozen?:boolean; models:ChatOption[]; reasoningLevels:ChatOption[]; harnesses:ChatOption[]; extensions:ChatExtension[]; selectedExtensions:string[]; }
export interface ChatAttachment { id:string; name:string; size:number; status:'selected'|'uploading'|'ready'|'failed'; detail?:string; }
export interface ChatCapabilities { send:boolean; answers:boolean; editAnswers:boolean; help:boolean; confirm:boolean; configureRoles:boolean; extensions:boolean; attachments:boolean; rename:boolean; archive:boolean; pin:boolean; cancel:boolean; finishInterview?:boolean; followup?:boolean; reason?:string; }
export interface ChatState {
  product:ChatProduct; engineeringMode:ChatEngineeringMode; evidence:'live'|'demo'|'offline';
  loading:boolean; connected:boolean; busy:boolean; title:string;
  projects:ChatProject[]; projectId:string|null; messages:ChatMessage[];
  phase:ChatPhase; phaseDetail?:string; phaseAt?:string; questions:ChatQuestion[];
  activeQuestionId?:string|null; locked:boolean; lockReason?:string; interviewDecisionRequired?:boolean;
  requirements?:{text:string; revision:number; confirmed:boolean}|null;
  roles:Record<ChatRole,ChatRoleConfig>; capabilities:ChatCapabilities;
  attachments:ChatAttachment[]; error?:string|null; notice?:string|null;
  legacyHref?:string; demoStepLabel?:string; runId?:string; requirementVersion?:string;
}
export type ChatAction =
 | {type:'product-switch';product:ChatProduct}
 | {type:'project-new'} | {type:'project-select';id:string}
 | {type:'project-rename';id:string;title:string}
 | {type:'project-archive';id:string} | {type:'project-restore';id:string} | {type:'project-pin';id:string;pinned:boolean}
 | {type:'message-send';text:string}
 | {type:'answer-submit';questionId:string;answer:string;choiceId?:string;choiceIds?:string[]}
 | {type:'answer-edit';questionId:string;answer:string;expectedRevision:number}
 | {type:'question-help';questionId:string;text:string}
 | {type:'requirements-confirm';text:string;expectedRevision:number}
 | {type:'requirements-edit';text:string;expectedRevision:number}
 | {type:'role-configure';role:ChatRole;model:string;reasoning:string;harness:string;provider?:string}
 | {type:'role-extensions';role:ChatRole;ids:string[]}
 | {type:'role-restore-defaults'}
 | {type:'attachments-add';files:File[]}
 | {type:'attachment-remove';id:string}
 | {type:'end-interview'} | {type:'review-followup';text:string}
 | {type:'cancel'} | {type:'refresh'} | {type:'demo-step'}
 | {type:'help-open'} | {type:'settings-open'} | {type:'engineering-settings-open'} | {type:'mode-toggle'};
export interface ChatActionResult { text?:string; }
export interface ChatController { dispatch(action:ChatAction):void|ChatActionResult|Promise<void|ChatActionResult>; roleChoices?(projectId:string):Promise<Record<string,{models:ChatOption[];efforts:ChatOption[];harnesses:ChatOption[];skills:ChatExtension[];plugins:ChatExtension[];selected:string[];current:{harness:string;model:string;effort:string}}>|null>; /** Read-only model catalog used to fill the Seeker picker. */ seekerModels?(provider:string):Promise<ChatOption[]>; }
export const CHAT_ROLE_LABELS:Record<ChatRole,string> = {seeker:'Seeker',planner:'Planner',executor:'Executor',reviewer:'Reviewer'};
export const CHAT_PHASE_LABELS:Record<ChatPhase,string> = {idle:'准备好，开始一个想法',seeking:'Seeker 探寻中',awaiting_answer:'Seeker · 等待你的回答',optimizing:'Seeker 整理需求中',awaiting_confirmation:'需求已整理 · 等待确认',flow:'DreamFlow 流转中',planning:'Planner 规划中',prework:'Prework 交接中',executing:'Executor 执行中',verifying:'验证器核验中',reviewing:'Reviewer 审查中',review_feedback:'Seeker 分析反馈中',ready:'成果已就绪 · 等待接受',accepted:'成果已接受',blocked:'流程已暂停 · 需要处理',paused:'流程已暂停',cancelling:'正在停止并核对结果',error:'连接需要恢复'};
