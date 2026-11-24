// Runs the real form controller and rejection path; only the DOM and HTTP boundary are doubles.
// This is not browser or native-role acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DreamMakerUI} from '../../dist/web/ui.js';
import {UiError} from '../../dist/web/contracts.js';
test('a rejected new maintenance operation cannot keep an earlier success result on screen',async()=>{
 const FormDataBefore=globalThis.FormData;globalThis.FormData=class{has(name){return name==='maintenanceConsent';}};
 try{
  const ui=Object.create(DreamMakerUI.prototype);ui.v={busy:false,screen:'maintenance',error:'',maintenanceResult:{snapshotId:'OLD_SNAPSHOT',scope:'READONLY_RESTORE_REHEARSAL_ONLY',engineStarted:false}};
  ui.adapter={mode:'local',async request(){throw new UiError('MAINTENANCE_SNAPSHOT_CHANGED','offline rejection',409);}};ui.epoch=1;ui.maintenanceBinding={kind:'rehearse',id:'snapshot_'+'b'.repeat(32)};ui.dialog={querySelector:()=>null};ui.render=()=>{};
  const act=DreamMakerUI.prototype.act.bind(ui);let pending;ui.act=work=>(pending=act(work));
  ui.submit({preventDefault(){},target:{id:'maintenance-choice-form'}});await pending;
  assert.equal(ui.v.maintenanceResult,undefined);assert.equal(ui.v.busy,false);assert.match(ui.v.error,/不一致/);
 }finally{globalThis.FormData=FormDataBefore;}
});
