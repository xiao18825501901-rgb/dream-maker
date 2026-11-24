// Rendered production view contract only; real-browser and model acceptance are separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {shell} from '../../dist/web/views.js';
import {flowCatalog} from '../../dist/server/flows.js';
import {harness,ready} from '../helpers.mjs';
test('new production build choice has two mode cards and a separate optional Laya choice',async t=>{
 const h=harness(t),{p,s}=await ready(h);const v={mode:'local',screen:'project',snapshot:{project:p,spec:s,runs:[],records:[],flowOptions:flowCatalog(h.config,{live:false})},settings:{config:h.config,keyStatus:{planner1:false,executor:false},nativeStatus:'NOT_VERIFIED'},tab:'spec',projects:[p],busy:false,error:'',events:[],connection:'closed',railClosed:false,fileName:'',fileText:'',files:[],previewUrl:'',previewScope:'',diagnostics:'',specSearch:'',logLimit:200,clash:null,hasDraft:()=>false,draft:()=>''};
 const html=shell(v);assert.match(html,/type="radio" name="flowName" value="classic"/);assert.match(html,/type="radio" name="flowName" value="custom"/);
 assert.doesNotMatch(html,/(?:option|input)[^>]+value="dreamflow(?:-laya)?"/);
 assert.match(html,/name="flowLaya"/);assert.match(html,/name="buildConsent" type="checkbox" required/);
 assert.match(html,/自定义.*(?:尚未连接|尚未就绪|暂未连接)/);assert.doesNotMatch(html,/Copilot 快捷模式/);
});
