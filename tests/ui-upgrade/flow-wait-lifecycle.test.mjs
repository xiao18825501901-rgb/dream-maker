// Isolated controller lifecycle tests. No browser, product DB, Native role or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DreamMakerUI} from '../../dist/web/ui.js';
import {LocalApiAdapter} from '../../dist/web/local-api.js';
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function fixture(t){
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1800000000000});
 const ui=Object.create(DreamMakerUI.prototype),snapshot={project:{id:'OFFLINE_P',specId:'OFFLINE_S',version:1},spec:{stale:false},runs:[{id:'OFFLINE_R',specId:'OFFLINE_S',state:'IMPLEMENTING'}]};
 const stats={reads:0,renders:0,signals:[],fail:false,hold:false};
 const dispatch=()=>({executorSlots:1,active:[],quarantined:[],queued:[{projectId:'OFFLINE_P',runId:'OFFLINE_R',kind:'executor',wait:{scope:'RESOURCE_OBSERVATION_ONLY',reason:'MEMORY',sampledAt:new Date().toISOString(),availableMemoryMiB:1536,estimatedMemoryGapMiB:1024}}]});
 Object.assign(ui,{epoch:1,panelSeq:0,readSeq:0,disposed:false,composing:false,flowRefreshTimer:null,flowExpiryTimer:null,panelAbort:null,flowNeedsInitialRead:false,dialog:{open:false},v:{screen:'project',tab:'flow',snapshot,dispatch:dispatch(),busy:false,error:'',panelError:''},render(){stats.renders++;},errorText:()=> '读取失败',adapter:{mode:'local',async request(path,_method,_body,signal){if(path.startsWith('/projects/'))return structuredClone(snapshot);stats.reads++;stats.signals.push(signal);if(stats.fail)throw Error('OFFLINE_READ_FAILURE');if(stats.hold)return new Promise((_ok,reject)=>signal?.addEventListener('abort',()=>reject(Error('ABORTED')),{once:true}));return {dispatch:dispatch()};}}});
 t.after(()=>ui.clearPanels());return {ui,stats,snapshot};
}
test('SSE snapshots cannot bypass queued-only three-second polling',async t=>{
 const {ui,stats,snapshot}=fixture(t);await ui.loadProjectPanel();
 for(let i=0;i<10;i++){t.mock.timers.tick(250);await ui.refreshSnapshot('OFFLINE_P');}
 assert.equal(stats.reads,1);t.mock.timers.tick(500);await flush();assert.equal(stats.reads,2);
 ui.v.dispatch.queued=[];for(let i=0;i<4;i++){await ui.refreshSnapshot('OFFLINE_P');t.mock.timers.tick(3000);await flush();}assert.equal(stats.reads,2);
 snapshot.runs[0].state='ACCEPTED';ui.v.dispatch.queued=[{projectId:'OFFLINE_P',runId:'OFFLINE_R'}];await ui.refreshSnapshot('OFFLINE_P');t.mock.timers.tick(3000);await flush();assert.equal(stats.reads,2);
});
for(const deferral of ['composing','modal','busy'])test('automatic event reads defer during '+deferral,async t=>{
 const {ui,stats}=fixture(t);await ui.loadProjectPanel();
 if(deferral==='modal')ui.dialog.open=true;else if(deferral==='busy')ui.v.busy=true;else ui.composing=true;
 for(let i=0;i<12;i++){await ui.refreshSnapshot('OFFLINE_P');t.mock.timers.tick(250);await flush();}assert.equal(stats.reads,1);
 ui.dialog.open=false;ui.v.busy=false;ui.composing=false;t.mock.timers.tick(3000);await flush();assert.equal(stats.reads,2);
});
test('manual refresh resets the automatic interval instead of inheriting an imminent read',async t=>{
 const {ui,stats}=fixture(t);await ui.loadProjectPanel();t.mock.timers.tick(2500);await ui.loadProjectPanel();assert.equal(stats.reads,2);
 t.mock.timers.tick(500);await flush();assert.equal(stats.reads,2);t.mock.timers.tick(2500);await flush();assert.equal(stats.reads,3);
});
test('SSE during a delayed manual read cannot schedule an imminent follow-up',async t=>{
 const {ui,stats}=fixture(t);await ui.loadProjectPanel();t.mock.timers.tick(2500);
 const original=ui.adapter.request;let release;
 ui.adapter.request=async(...args)=>{const value=await original(...args);if(args[0]==='/dispatch')return new Promise(resolve=>{release=()=>resolve(value);});return value;};
 const pending=ui.loadProjectPanel();await flush();t.mock.timers.tick(100);await ui.refreshSnapshot('OFFLINE_P');t.mock.timers.tick(2900);release();await pending;
 ui.adapter.request=original;t.mock.timers.tick(100);await flush();assert.equal(stats.reads,2);t.mock.timers.tick(2900);await flush();assert.equal(stats.reads,3);
});
test('failed polling immediately invalidates old resource observations',async t=>{
 const {ui,stats}=fixture(t);await ui.loadProjectPanel();stats.fail=true;t.mock.timers.tick(3000);await flush();assert.equal(ui.v.dispatch,undefined);assert.ok(ui.v.panelError);const renders=stats.renders;t.mock.timers.tick(30000);await flush();assert.equal(stats.reads,2);assert.equal(stats.renders,renders);
});
test('observations expire by clock even when reading is deferred',async t=>{
 const {ui,stats}=fixture(t);await ui.loadProjectPanel();ui.composing=true;const renders=stats.renders;t.mock.timers.tick(15001);await flush();assert.equal(stats.reads,1);assert.ok(stats.renders>renders,'the stale notice must render without a successful new response');
});
test('leaving a panel aborts its actual request and ignores cancellation',async t=>{
 const {ui,stats}=fixture(t);stats.hold=true;const pending=ui.loadProjectPanel();await flush();assert.ok(stats.signals[0] instanceof AbortSignal);ui.clearPanels();await pending;assert.equal(stats.signals[0].aborted,true);assert.equal(ui.v.dispatch,undefined);assert.equal(ui.v.panelError,'');assert.equal(ui.v.panelLoading,false);
});
test('tab return cannot display old observations while a replacement read stalls',async t=>{
 const {ui,stats}=fixture(t);await ui.loadProjectPanel();ui.cancelPanelRead();
 assert.equal(ui.v.dispatch,undefined,'tab navigation must invalidate observations whose expiry timer was cleared');
 stats.hold=true;const pending=ui.loadProjectPanel();await flush();t.mock.timers.tick(16000);await flush();assert.equal(ui.v.dispatch,undefined);ui.clearPanels();await pending;
});
test('local GET transport passes cancellation to fetch without retry',async t=>{
 const controller=new AbortController(),adapter=new LocalApiAdapter();let sends=0,observedSignal;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{sends++;observedSignal=options.signal;if(!options.signal)throw Error('MISSING_SIGNAL');return new Promise((_ok,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('OFFLINE_ABORT')),{once:true}));});
 const pending=adapter.request('/dispatch','GET',undefined,controller.signal);controller.abort();await assert.rejects(pending);assert.equal(observedSignal,controller.signal);assert.equal(sends,1);
});
