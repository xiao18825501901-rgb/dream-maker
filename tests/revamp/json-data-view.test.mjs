// Pure frontend safety/contract tests, not role or Native execution evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readJsonData,jsonDataPanel,jsonEditorContent,jsonExecuteConfirmation,jsonDataErrorMessage,readJsonRestorePlan,jsonRestoreConfirmation} from '../../dist/web/json-data-view.js';
const data={schema:'dream-maker.json-data.v1',kind:'JSON_DOCUMENT_V1',projectId:'p1',revision:1,document:{name:'<img src=x onerror=alert(1)>',notes:['中文内容']},dataHash:'a'.repeat(64),contentHash:'b'.repeat(64),scope:'PROJECT_JSON_DATA_ONLY',nativeExecutionGranted:false,usage:{versions:1,bytes:90,operations:1},limits:{versions:1000,bytes:8000000,operations:5000,payloadBytes:100000}};
test('JSON UI validates source scope and version before exposing data controls',()=>{
 assert.deepEqual(readJsonData(data,'p1'),data);
 for(const value of [{...data,projectId:'p2'},{...data,nativeExecutionGranted:true},{...data,revision:NaN},{...data,document:[]},{...data,usage:{...data.usage,versions:2}}])assert.throws(()=>readJsonData(value,'p1'));
 const panel=jsonDataPanel(undefined,false);assert.match(panel,/读取已保存数据/);assert.doesNotMatch(panel,/数据处理已完成|data-action="json-execute"/);
 assert.match(jsonDataPanel(data,true),/版本 1/);assert.match(jsonDataPanel(data,true),/json-execute/);
});
test('JSON editor and consent views escape business text, retain drafts and bind the shown version',()=>{
 const html=jsonEditorContent(data,'</textarea><script>bad()</script>','draft-key');
 assert.doesNotMatch(html,/<script>|<img src=x/);assert.match(html,/&lt;\/textarea&gt;/);assert.match(html,/data-draft="draft-key"/);assert.match(html,/name="jsonConsent" required/);assert.match(html,/版本 1/);
 assert.match(jsonExecuteConfirmation(data),/当前.*版本 1/);assert.match(jsonExecuteConfirmation(data),/不会.*模型/);assert.match(jsonExecuteConfirmation(data),/jsonConsent/);
 assert.match(jsonDataErrorMessage('JSON_DATA_CONFLICT'),/保留|不会覆盖/);assert.match(jsonDataErrorMessage('REQUEST_RESULT_UNCERTAIN'),/不要.*重复|不会.*重跑/);
});
test('JSON restore UI requires the selected project, anchored source and explicit narrow consent',()=>{
 const plan={schema:'dream-maker.json-data-restore-plan.v1',scope:'PROJECT_JSON_DATA_ONLY',engineStarted:false,projectId:'p1',snapshotId:'snapshot_'+'a'.repeat(32),rehearsalId:'rehearsal_'+'b'.repeat(32),source:{revision:1,contentHash:'a'.repeat(64),bytes:90,at:new Date().toISOString()},target:{revision:2,contentHash:'c'.repeat(64),bytes:100}};
 assert.deepEqual(readJsonRestorePlan(plan,'p1',plan.snapshotId,plan.rehearsalId),plan);assert.throws(()=>readJsonRestorePlan(plan,'p2',plan.snapshotId,plan.rehearsalId));
 const html=jsonRestoreConfirmation(plan,'<svg onload=bad()>');assert.doesNotMatch(html,/<svg/);assert.match(html,/当前版本 2/);assert.match(html,/副本.*版本 1/);assert.match(html,/新.*版本/);assert.match(html,/jsonConsent/);
});
