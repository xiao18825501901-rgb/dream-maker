import type {JsonDataView,JsonDataRestorePlan} from '../shared/json-data.js';
import {UiError,escapeHtml as e} from './contracts.js';
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const invalid=()=>new UiError('JSON_DATA_STATUS_INVALID','项目数据的版本或范围无法核对，已有内容保留。');
export function readJsonData(raw:unknown,pid:string):JsonDataView{
 const v=raw as JsonDataView;
 if(!v||v.schema!=='dream-maker.json-data.v1'||v.kind!=='JSON_DOCUMENT_V1'||v.projectId!==pid||v.scope!=='PROJECT_JSON_DATA_ONLY'||v.nativeExecutionGranted!==false||!integer(v.revision)||!v.document||typeof v.document!=='object'||Array.isArray(v.document)||!v.usage||!v.limits||!['versions','bytes','operations'].every(key=>integer(v.usage[key as keyof typeof v.usage])&&integer(v.limits[key as keyof typeof v.limits])&&v.usage[key as keyof typeof v.usage]<=v.limits[key as keyof typeof v.limits])||v.usage.versions!==v.revision||!integer(v.limits.payloadBytes)||v.limits.payloadBytes>100000||(v.revision===0?v.contentHash!==null||v.dataHash!==null:!sha(v.contentHash)||!sha(v.dataHash)))throw invalid();
 if(new TextEncoder().encode(JSON.stringify(v.document)).length>v.limits.payloadBytes)throw invalid();return v;
}
export function jsonDataErrorMessage(code:string):string|undefined{
 const messages:Record<string,string>={
  JSON_DATA_CONFLICT:'另一个操作已更新数据。你的输入保留，不会覆盖最新版本；请先复制需要保留的内容，再重新核对。',
  JSON_DATA_ALREADY_EXISTS:'本机已经有数据，导入不会覆盖它。请先读取并核对当前内容。',
  JSON_DATA_SOURCE_CHANGED:'成果源码发生了变化，已停止这次数据操作。原内容和历史版本保留。',
  JSON_DATA_SOURCE_UNVERIFIED:'这份成果的源码、方案批准或审查还没有核验完成。可以查看记录，暂不能修改或运行数据。',
  JSON_DATA_INVALID:'内容格式无法识别。请使用完整的 JSON 对象，移除脚本、特殊字段和无效值；原数据未改。',
  JSON_DATA_SECRET_DENIED:'内容包含凭据等敏感信息，未保存。请移除这些内容；不要在业务数据中填写账户密钥。',
  JSON_DATA_PAYLOAD_LIMIT:'这份数据过大，未保存。请减少内容后再核对；原数据和草稿保留。',
  JSON_DATA_RUNTIME_INPUT_LIMIT:'数据超出当前程序单次可接收的大小，未运行，也没有截断或覆盖内容。',
  JSON_DATA_RUNTIME_UNAVAILABLE:'当前运行组件尚未连接数据处理能力，已保存内容保留。',
  JSON_DATA_RUNTIME_FAILED:'数据程序没有正常完成，未保存输出。请先核对成果和验证记录，不要反复运行。',
  JSON_DATA_RUNTIME_OUTPUT_INVALID:'程序返回的数据与本次输入无法对应，未保存输出；当前版本保持。',
  JSON_DATA_STATUS_INVALID:'项目数据响应尚未核对，未覆盖已有内容。',
  REQUEST_RESULT_UNCERTAIN:'这次请求的结果尚不确定，不会自动重跑。请先重新读取已保存数据和任务状态，不要重复提交。',
  JSON_DATA_STORAGE_LIMIT:'项目数据历史占用已达上限，未删除旧版本。请先检查备份与空间。',
  JSON_DATA_VERSION_LIMIT:'数据版本数量已达上限，已有版本保留。',
  JSON_DATA_OPERATION_LIMIT:'本项目的数据操作数量已达上限，已有内容保留。',
  JSON_DATA_BUSY:'该项目仍有制作任务或恢复事项待处理。请先核对状态，数据没有被覆盖。'
 };return messages[code];
}
export function jsonDataPanel(data:JsonDataView|undefined,declared:boolean):string{
 return `<section class="card"><h2>项目业务数据</h2><p>${data?`已读取版本 ${e(data.revision)}，历史保存在本机项目数据库。`:'尚未读取这份成果的业务数据。'}</p><p>数据与源码分开保存，不发送给模型。读取、编辑和导入仍需核对原成果；保存数据不会授予制作权限。</p><div class="actions wrap"><button type="button" data-action="json-load">读取已保存数据</button><button type="button" data-action="json-edit">${data?.revision?'查看和编辑数据':'查看或导入数据'}</button>${data?'<button type="button" data-action="json-export">下载当前数据副本</button>':''}${declared?'<button type="button" data-action="json-execute">运行成果的数据处理</button>':''}</div>${declared?'<p class="hint">执行前会再次核对运行资格、当前源码和数据版本；只运行成果已声明的入口，不开放命令输入。</p>':'<p class="hint">这份成果未声明数据处理入口，当前没有提供运行按钮。</p>'}</section>`;
}
export function jsonEditorContent(data:JsonDataView,draft:string,draftKey:string):string{
 const value=draft||JSON.stringify(data.document,null,2);
 return `<h2 id="dialog-title">${data.revision?'查看和编辑项目数据':'导入项目数据'}</h2><p id="dialog-description">当前已核对版本 ${e(data.revision)}。保存会建立新版本，保留历史；不会修改源码、方案、批准或费用账本。</p><form id="json-editor-form"><label for="json-document">结构化内容（JSON）</label><textarea id="json-document" name="jsonDocument" rows="12" spellcheck="false" data-draft="${e(draftKey)}" required>${e(value)}</textarea><label for="json-import-file">从本机 JSON 文件读取到编辑框（尚不保存）</label><input id="json-import-file" type="file" name="jsonImportFile" accept=".json,application/json"><p class="hint">适合已有数据或需要精细修改时使用。不清楚格式时请先下载副本或查看 Help；不要填写密码或密钥。草稿保留在当前浏览器。</p><label class="check"><input type="checkbox" name="jsonConsent" required>我已核对本次内容，确认只保存项目业务数据。</label><div class="actions"><button type="button" data-action="close-modal">返回</button><button type="submit" class="primary">${data.revision?'确认保存为新版本':'确认导入数据'}</button></div></form>`;
}
export function jsonExecuteConfirmation(data:JsonDataView):string{
 return `<h2 id="dialog-title">运行成果的数据处理？</h2><p id="dialog-description">使用当前已核对版本 ${e(data.revision)}，在专用隔离环境运行一次成果声明的数据程序。不会发起模型请求。</p><p>结果通过输入核对、进程清理和版本检查后才保存。中途修改、停止或无法核验的结果不会覆盖已有内容。</p><form id="json-execute-form"><label class="check"><input type="checkbox" name="jsonConsent" required>确认使用这个版本运行一次并保存通过核验的数据结果。</label><div class="actions"><button type="button" data-action="close-modal">返回</button><button type="submit" class="primary">确认运行这次数据处理</button></div></form>`;
}
export function readJsonRestorePlan(raw:unknown,pid:string,snapshotId:string,rehearsalId:string):JsonDataRestorePlan{
 const v=raw as JsonDataRestorePlan;
 if(!v||v.schema!=='dream-maker.json-data-restore-plan.v1'||v.scope!=='PROJECT_JSON_DATA_ONLY'||v.engineStarted!==false||v.projectId!==pid||v.snapshotId!==snapshotId||v.rehearsalId!==rehearsalId||!v.source||!v.target||!integer(v.source.revision)||v.source.revision<1||!sha(v.source.contentHash)||!integer(v.source.bytes)||!Number.isFinite(Date.parse(v.source.at))||!integer(v.target.revision)||!integer(v.target.bytes)||(v.target.revision===0?v.target.contentHash!==null:!sha(v.target.contentHash)))throw invalid();return v;
}
export function jsonRestoreConfirmation(plan:JsonDataRestorePlan,name:string):string{
 return `<h2 id="dialog-title">只恢复这个项目的业务数据？</h2><p id="dialog-description">${e(name)}：当前版本 ${e(plan.target.revision)}，副本版本 ${e(plan.source.revision)}（${e(plan.source.at)}）。</p><p>按已演练副本建立新的数据版本，保留原历史。源码、方案、批准和原费用记录保持，不启动制作或数据程序。</p><form id="json-restore-form"><label class="check"><input type="checkbox" name="jsonConsent" required>我已核对项目和版本，确认只恢复项目业务数据。</label><div class="actions"><button type="button" data-action="close-modal">返回</button><button type="submit" class="primary">确认恢复为新数据版本</button></div></form>`;
}
