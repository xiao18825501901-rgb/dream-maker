// OFFLINE view/brief regression; no browser, real model, source qualification or approval proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shell } from '../../dist/web/views.js';
import { roleAssistanceBrief } from '../../dist/server/flow/role-assistance.js';
import { flowCatalog } from '../../dist/server/flows.js';
import { harness,ready } from '../helpers.mjs';
test('a stale enhanced draft requires a new choice and retains separate build consent',async t=>{
 const h=harness(t),{p,s}=await ready(h),v={mode:'local',screen:'project',snapshot:{project:p,spec:s,runs:[],records:[],flowOptions:flowCatalog(h.config,{live:false})},settings:{config:h.config,keyStatus:{planner1:false,executor:false},nativeStatus:'NOT_VERIFIED'},tab:'spec',busy:false,error:'',events:[],connection:'closed',railClosed:false,fileName:'',fileText:'',files:[],previewUrl:'',previewScope:'',diagnostics:'',specSearch:'',logLimit:200,clash:null,hasDraft:key=>key.startsWith('flow:'),draft:key=>key.startsWith('flow:')?'dreamflow-laya':''};
 v.projects=[p];const html=shell(v);assert.match(html,/旧选择或辅助状态已改变，请重新选择经典或完全自定义/);
 assert.match(html,/<input[^>]*name="flowName" value="classic" required/);assert.match(html,/name="buildConsent" type="checkbox" required/);
 assert.doesNotMatch(html,/<input[^>]*name="flowName"[^>]*checked/);
});
test('a large project description has an explicit partial span without changing the full source',()=>{
 const idea='需要保留完整描述。'.repeat(800),store={project:()=>({idea})};
 const run={id:'offline-flow',projectId:'offline-project',specHash:'a'.repeat(64),tasks:[],phase:'PLANNING',treeHash:null};
 const brief=roleAssistanceBrief(store,run,'planner2','complete frozen task packet');
 assert.ok(Buffer.byteLength(JSON.stringify(brief.state))<2400);assert.equal(brief.state.goal.partial,true);assert.equal(brief.state.goal.totalCharacters,Array.from(idea).length);assert.equal(store.project().idea,idea);
 assert.equal(brief.support.coverage,'TASK_AND_BOUNDED_SOURCE_CONTEXT_NOT_FULL_REVIEW');
});
test('Custom setup becomes selectable after controller wiring while qualification remains explicit',async t=>{
 const h=harness(t),{p,s}=await ready(h),options=flowCatalog(h.config,{live:false},()=>({connected:true})).map(value=>value.name==='custom'?{...value,blockedBy:'CUSTOM_ROLE_QUALIFICATION_REQUIRED',setupAllowed:true}:value);
 const v={mode:'local',screen:'project',snapshot:{project:p,spec:s,runs:[],records:[],flowOptions:options},settings:{config:h.config,keyStatus:{planner1:false,executor:false},nativeStatus:'NOT_VERIFIED'},tab:'spec',busy:false,error:'',events:[],connection:'closed',railClosed:false,fileName:'',fileText:'',files:[],previewUrl:'',previewScope:'',diagnostics:'',specSearch:'',logLimit:200,clash:null,hasDraft:()=>false,draft:()=>''};
 v.projects=[p];const html=shell(v);
 assert.match(html,/<input[^>]*id="flow-choice-custom"[^>]*value="custom"[^>]*(?![^>]*disabled)/);
 assert.match(html,/需先完成该项目账户、模型与运行器核验/);
});
