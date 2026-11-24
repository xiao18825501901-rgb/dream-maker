// Offline view/controller boundaries; real browser evidence is collected separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import {lifecycleConfirmation,lifecyclePanel,readLifecycleStatus} from '../../dist/web/lifecycle-view.js';
import {DreamMakerUI} from '../../dist/web/ui.js';
import {UiError} from '../../dist/web/contracts.js';
const status=(state='RUNNING')=>({schema:'dream-maker.lifecycle.v1',state,lastChoice:null,changedAt:'2026-11-01T00:00:00.000Z',code:null,scope:'CONTROLLER_OWNED_WORK_ONLY',automaticResume:false,browserCloseStopsWork:false,currentRoundMayStillRun:state==='PAUSE_REQUESTED',active:{engineJobs:0,interviews:0,modelCalls:0,queued:0,grants:0,quarantined:0}});
test('leaving requires a separate explicit choice and consent and explains browser and current-round limits',()=>{
 const html=lifecycleConfirmation(status());assert.match(html,/关闭浏览器不会停止/);assert.match(html,/name="exitChoice"/);assert.match(html,/value="PAUSE"/);assert.match(html,/value="BACKGROUND_CURRENT_WORK"/);assert.match(html,/name="exitConsent"/);assert.doesNotMatch(html,/checked/);assert.match(html,/仍可能.*计费/);
});
test('unconfirmed, pending and uncertain states cannot claim safe shutdown or offer background after pausing',()=>{
 for(const state of [undefined,status('PAUSE_REQUESTED'),{...status('PAUSE_UNCERTAIN'),code:'<script>bad</script>'}]){const html=lifecycleConfirmation(state);assert.match(html,/lifecycle-read/);assert.doesNotMatch(html,/value="BACKGROUND_CURRENT_WORK"/);assert.doesNotMatch(html,/<script>/);assert.doesNotMatch(html,/本机工作已暂停/);}
 assert.match(lifecyclePanel(status('PAUSED')),/服务仍在本机运行/);assert.match(lifecycleConfirmation(status('PAUSED')),/不会自动/);
});
test('lifecycle projection rejects forged completion, counts and browser-close claims',()=>{
 assert.equal(readLifecycleStatus(status()).state,'RUNNING');for(const change of [{state:'COMPLETE'},{automaticResume:true},{browserCloseStopsWork:true},{scope:'ALL_PROCESSES_CLEANED'},{active:{...status().active,engineJobs:-1}},{state:'PAUSED',active:{...status().active,engineJobs:1}}])assert.throws(()=>readLifecycleStatus({...status(),...change}));
});
test('failed exit submission clears old success and never repeats or fabricates a pause result',async()=>{
 const saved=globalThis.FormData;globalThis.FormData=class{has(name){return name==='exitConsent';}get(name){return name==='exitChoice'?'PAUSE':null;}};
 try{const ui=Object.create(DreamMakerUI.prototype);ui.v={busy:false,screen:'maintenance',error:'',lifecycle:status('PAUSED')};ui.epoch=1;ui.modalSeq=0;ui.modalKind='lifecycle';ui.dialog={querySelector:()=>null};ui.render=()=>{};let shown='',calls=0;ui.showDialog=(_kind,html)=>{ui.modalSeq++;shown=html;};ui.adapter={mode:'local',async request(){calls++;throw new UiError('NETWORK_UNCERTAIN','本次结果尚未确认',409);}};
  const actual=DreamMakerUI.prototype.act.bind(ui);let pending;ui.act=work=>(pending=actual(work));ui.submit({preventDefault(){},target:{id:'lifecycle-choice-form'}});await pending;
  assert.equal(calls,1);assert.equal(ui.v.lifecycle,undefined);assert.equal(ui.v.busy,false);assert.match(shown,/尚未核对/);assert.doesNotMatch(shown,/本机工作已暂停/);assert.match(ui.v.error,/尚未确认/);
 }finally{globalThis.FormData=saved;}
});
