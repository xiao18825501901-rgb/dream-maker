import type { Store } from '../store.js';
import type { Run,Role,LayaDecision } from '../../shared/types.js';
import { DomainError,hash,object,hasSecret } from '../security.js';
type EngineeringRole=Exclude<Role,'planner1'>;
const guides:Record<EngineeringRole,Record<string,string>>={
    planner2:{plan:'先把冻结要求分成可独立验证的小任务；每项保持单回合与工具次数上限。',dependency:'先核对任务依赖及共享资源，保留审查容量，不把调度建议当作派发许可。',interface:'先明确模块输入、输出与错误条件，再分配实现任务。',scope:'核对每项冻结要求和交付范围；不要扩大权限、改目标或自动批准。'},
    executor:{code:'只实现当前已派发任务，保留已完成部分；完成声明仍需验证器和独立审查。',debug:'先复现当前证据中的错误，再做最小修复；不要修改验证器或验收状态。',test:'先核对规定的输入输出和边界，再改实现；通过自写测试不能替代可信验证。',dependency:'只使用冻结且获准的依赖与工具，不执行未审核安装脚本。'},
    reviewer:{security:'从冻结源码和实际数据流独立检查权限、凭据、文件和网络边界；执行器摘要不能作证。',coverage:'按冻结要求逐项对照源码、diff 和原始测试；标明遗漏，不能仅凭测试数量通过。',regression:'核对本轮 diff 对原有行为和数据的影响，引用实际源码及原始失败或通过证据。',defect:'独立寻找源码缺陷及可复现影响；辅助分类本身不能作出审查或用户接受。'}
};
/** A bounded source span is explicitly partial, never a complete review. External/project text is
 * model data only: it cannot choose a tool, path, permission, provider, dispatch or verdict. */
function sourceContext(store:Store,run:Run){
    const row=store.db.prepare("SELECT data FROM records WHERE project_id=? AND run_id=? AND kind='SourceSnapshot' ORDER BY rowid DESC LIMIT 1").get(run.projectId,run.id);
    if(!row)return {sourceHash:run.treeHash,span:null};
    if(typeof row.data!=='string'||Buffer.byteLength(row.data)>512000)throw new DomainError('LAYA_SOURCE_CONTEXT_UNVERIFIED',409);
    const snapshot=object(JSON.parse(row.data)),{sha256,...body}=snapshot;
    if(snapshot.schema!=='dream-maker.source-snapshot.v1'||snapshot.runId!==run.id||snapshot.specHash!==run.specHash||sha256!==hash(body)||!Array.isArray(snapshot.files))throw new DomainError('LAYA_SOURCE_CONTEXT_UNVERIFIED',409);
    const file=snapshot.files.map(object).find(f=>f.encoding==='utf8'&&typeof f.path==='string'&&/\.(?:[cm]?js|tsx?|py|html|css|json)$/.test(f.path)&&typeof f.content==='string');
    if(!file)return {sourceHash:String(snapshot.treeHash),span:null};
    if(hash(Buffer.from(String(file.content),'utf8'))!==file.sha256)throw new DomainError('LAYA_SOURCE_CONTEXT_UNVERIFIED',409);
    const lines=String(file.content).split('\n'),chosen:string[]=[];
    for(const line of lines){if(Buffer.byteLength([...chosen,line].join('\n'))>600)break;chosen.push(line);}
    return {sourceHash:String(snapshot.treeHash),span:{path:file.path,fileHash:file.sha256,lineStart:1,lineEnd:chosen.length,totalLines:lines.length,content:chosen.join('\n'),partial:chosen.length<lines.length}};
}
function textSpan(value:string,limit:number){
    // Sensitive input remains intact only for the bridge's pre-network refusal, never in a request.
    if(hasSecret(value))return value;
    const selected:string[]=[];let bytes=0;
    for(const character of value){const size=Buffer.byteLength(character);if(bytes+size>limit)break;selected.push(character);bytes+=size;}
    return {text:selected.join(''),sourceHash:hash(value),totalCharacters:Array.from(value).length,includedCharacters:selected.length,partial:selected.join('')!==value};
}
export function roleAssistanceBrief(store:Store,run:Run,role:EngineeringRole,taskData:string,includeContext=true,currentTaskId?:string){
    const project=store.project(run.projectId),task=(currentTaskId===undefined?run.tasks.find(t=>t.status==='running'):run.tasks.find(t=>t.id===currentTaskId))??null;
    if(currentTaskId!==undefined&&(role!=='executor'||!task))throw new DomainError('LAYA_TASK_SCOPE_INVALID',409);
    const source=role==='planner2'||!includeContext?{sourceHash:run.treeHash,span:null}:sourceContext(store,run);
    const support:NonNullable<LayaDecision['support']>={schema:'dream-maker.role-assistance.v1',runId:run.id,specHash:run.specHash,taskId:task?.id??null,taskDataHash:hash(taskData),sourceHash:source.sourceHash,authority:'ADVISORY_ONLY',coverage:'TASK_AND_BOUNDED_SOURCE_CONTEXT_NOT_FULL_REVIEW',guide:null};
    return {support,labels:roleAssistanceLabels(role),
        state:{role,runId:run.id,specHash:run.specHash,phase:run.phase,taskDataHash:support.taskDataHash,
            goal:includeContext&&role==='planner2'?textSpan(project.idea,400):null,currentTask:includeContext&&task?{id:task.id,title:textSpan(task.title,280),dependencies:{ids:task.dependsOn.slice(0,3),total:task.dependsOn.length,idsHash:hash(task.dependsOn)}}:null,
            sourceHash:source.sourceHash,sourceSpan:source.span,
            rawEvidence:role==='reviewer'?{recordId:run.verification?.evidenceId??null,exitCode:run.verification?.exitCode??null,treeHash:run.verification?.treeHash??null}:null,
            authority:'CATEGORY_ADVICE_ONLY_NO_PERMISSION_OR_SUCCESS',coverage:support.coverage}};
}
/** One label set per role, shared by the real turns and the explicit enhancement qualification. */
export function roleAssistanceLabels(role:EngineeringRole):string[]{return [...Object.keys(guides[role]),'unknown'];}
export function attachRoleGuide(role:EngineeringRole,decision:LayaDecision,support:NonNullable<LayaDecision['support']>):LayaDecision {
    return {...decision,support:{...support,guide:decision.adoption==='advisory'&&decision.label?guides[role][decision.label]??null:null}};
}
